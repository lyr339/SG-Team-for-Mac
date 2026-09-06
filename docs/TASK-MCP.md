# 拾光 Agent MCP

The built server is `out/mcp/index.mjs`. Cursor sees a single native entry, `SG Team`, that exposes **nine tools**: two communication tools and seven team tools. Every call carries `channel_id`; role permissions are enforced per call by the service layer (the surface is a superset, the fence is at call time).

## Tool surface

| Tool | Kind | Purpose |
| --- | --- | --- |
| `check_messages` | communication | Long-poll for the next user message (keepalive → stay silent). |
| `record_reply` | communication | Archive the complete user-visible reply after every real reply. |
| `team_check_in` | team | Acknowledge launch and return the role briefing **plus** the run context snapshot (members with real capabilities, unread / awaiting counts, confirmed run memory). Call again whenever the context needs refreshing (takeover, permission change). |
| `team_tasks` | team, read-only | `view=mine \| available \| reviews \| board`; pass `taskId` to read one task in full. |
| `team_task` | team | `action=claim \| start \| renew \| progress \| submit \| fail \| plan` — everything that mutates a task. `plan` is lead-only and creates 1–30 tasks with dependencies and target slots. |
| `team_review` | team | `action=claim \| renew \| submit` for independent acceptance (quality roles; implementers cannot review their own work). |
| `team_message` | team | `action=inbox \| read \| send \| respond \| broadcast \| collect` — durable team messages with read / response receipts. `broadcast` / `collect` are lead-only. |
| `team_memory` | team | `action=search \| propose \| review` for run-scoped decisions, constraints, facts, risks and lessons. `review` is lead / quality only and never self-approving. |
| `team_run` | team | `action=start \| transfer_lead \| claim_lead \| clear_acting_lead \| ping \| pong \| liveness` — run launch, lead authority and liveness probes. |

Schemas are flat objects with optional fields; a missing action-specific argument returns `{ ok: false, code: 'invalid_arguments', message }` naming the field, never a protocol error. Every response is JSON in both `content` and `structuredContent`; idle-oriented responses carry `nextAction: { type: 'enter_channel_wait', … }` so the Agent returns to `check_messages`.

### Why nine instead of one tool per service method

The previous surface exposed 35 tools — one per service method (`team_list_mine`, `team_list_available`, `team_list_reviews`, `team_list_board`, `team_get_task` were five ways to "look at tasks"). Models pick tools by name; near-synonyms cost tokens and cause misfires. Grouping by object (tasks / task / review / message / memory / run) keeps each tool's `action` enum as the complete list of what that object can do, and keeps `readOnlyHint` meaningful (`team_tasks` is the only read-only team tool).

## Prompt layering

Every protocol rule is stated once, at the layer that owns it:

| Layer | Text | Owns |
| --- | --- | --- |
| Server `instructions` (once per session) | `buildUnifiedServerInstructions` | the complete protocol: tool map, reply loop, silence rule, boundaries, termination |
| Launch hint (once per seat) | `buildTeamLaunchHint` / `buildSoloLaunchHint` | identity, first call, session token |
| First delivery suffix | `buildDeliverySuffix({ isFirstDelivery: true })` | the "持续对话协议" summary with the concrete `record_reply` / `check_messages` calls |
| Every later delivery | two-line reminder under `CHANNEL_USER_DELIVERY_MARKER` | what to do when this turn ends |
| Tool `nextAction` | `buildChannelWaitInstruction` | "go back to `check_messages` silently" |
| `team_check_in` briefing | `buildTeamRoleBriefing` | role mission, boundaries, per-role workflow, collaboration rules — no protocol restatement |

The marker line `【真实用户消息处理完后进入 check_messages 待命】` is also evidence for the Cursor process observer (it separates business thinking from polling noise), so it stays on every real user delivery.

## Install from the desktop app

The lobby's **接入团队 MCP** step (also run automatically when a run's member topology changes) registers the run's seats with the server:

- registers a fresh agent generation in SQLite and revokes the previous generation;
- does not write the workspace `.cursor/mcp.json` at all — the only MCP entry is the global one below;
- never requires a Cursor reload: the global entry is watched natively, so there is no "restart required" state anywhere in the app;
- reports failures as IPC errors; nothing is written to disk besides SQLite, so there is nothing to roll back.

The single native `SG Team` entry in the global `~/.cursor/mcp.json` is registered at app startup; the production bundle lives outside `app.asar` so Cursor can execute it with `ELECTRON_RUN_AS_NODE=1`.

## Process-bound identity

The model never supplies its identity or a lease token. One unified server process serves every channel; the process is bound to the task database by environment, and each tool call carries `channel_id`:

```json
{
  "mcpServers": {
    "SG Team": {
      "command": "/Applications/拾光.app/Contents/MacOS/拾光",
      "args": ["/Applications/拾光.app/Contents/Resources/mcp/index.mjs"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "SG_TEAM_DB": "/absolute/path/to/task-pool.sqlite3",
        "SG_TEAM_SERVER_ROLE": "unified"
      }
    }
  }
}
```

On Windows `command` is the installed `拾光.exe` and `args` points at `resources/mcp/index.mjs`.

The Agent identity is `workspace hash + channel + install generation`. It is intentionally not treated as a permanent conversation identity. Every MCP tool call checks the active SQLite registration; reinstalling revokes older generations, so a stale Cursor MCP process cannot claim or mutate tasks.

## Communication tools and the session fence

`check_messages` and `record_reply` are the only user-facing communication tools. Both take `channel_id` and an optional `session`:

```text
check_messages({ channel_id: '2', session?: '<seat token>', reply?: string })
record_reply({ channel_id: '2', session?: '<seat token>', content, title?, groupId?, taskId?, files? })
```

- `session` is the per-seat token (`^[a-zA-Z0-9_-]{8,128}$`) that the launch hint / role briefing hands to the Cursor session. It is issued when the seat is installed, rotated when the seat is rebuilt, cleared on standby takeover, and moved with the donor on manual handoff. The Agent never invents it; if the launch instruction did not include one, the call is made without it.
- Without `session` the call is `legacy` and follows the previous contract unchanged (sessions created before the upgrade, standby takeovers).
- With `session` the server checks the channel's owner in the active run before any presence write. Mismatch, an unbound channel, a completed run or no active run returns a **retired** result:
  - `check_messages` → plain text starting with `[system] 会话围栏：…`, telling the Agent this is a server-side stop equivalent to the user asking it to stop: no further `check_messages` / `record_reply`, no visible reply, no retry.
  - `record_reply` → `isError` with `{ ok: false, code: 'session_retired', message }`; nothing is stored.
  - A retired caller never refreshes `channel_presence`, so the new seat on the same channel is not lit up by the old session.
- Ownership lookups that fail (for example a locked database) fail open: the fence only rejects on positive evidence.

Presence phases seen by the desktop: `waiting` / `keepalive` / `processing` / `need_reply_sync` (protocol), `cursor_stopped` / `tool_aborted` (explicit termination), `retired` (scope moved to another run; explicit stop until new life evidence), `reviving` (transition after a heartbeat or CDP activity revives a stopped phase).

## Workflow contract

```text
team_tasks(view) -> team_task(claim) -> team_task(start) -> team_task(renew | progress)* -> team_task(submit)
                                                                                        \-> team_task(fail) -> queued or failed
team_tasks(view: 'reviews') -> team_review(claim) -> team_review(renew)* -> team_review(submit: accept | reject)
```

Claim, start and submit are retry-safe. The lease token remains inside SQLite and the process-bound service. A process with a different generation cannot operate the attempt.

Run the stdio smoke with:

```bash
npm run build:mcp
npm run smoke:mcp
```

The smoke spawns real MCP subprocesses (owner, wrong generation, resumed owner, reviewer) and asserts the exact nine-tool surface.

The packaged-app path is separately verified with `npm run verify:mac` / `npm run verify:win`.
