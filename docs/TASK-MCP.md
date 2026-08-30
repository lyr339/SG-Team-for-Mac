# 拾光 Agent MCP

The built server is `out/mcp/index.mjs`. Tools are role-scoped instead of exposing every mutation to every Agent.

All Agents receive the execution tools:

- `team_check_in`
- `team_list_available`
- `team_list_mine`
- `team_get_task`
- `team_claim_task`
- `team_start_task`
- `team_renew_lease`
- `team_report_progress`
- `team_submit_for_review`
- `team_fail_task`

All Agents also receive durable collaboration and memory tools:

- `team_get_context`
- `team_list_inbox`
- `team_read_message`
- `team_send_message`
- `team_respond_message`
- `team_memory_search`
- `team_memory_propose`

The lead additionally receives `team_list_board` and `team_plan_tasks`. Lead/reviewer runtimes receive `team_memory_review`; project-long memory still requires an independent reviewer and cannot be self-approved. User-facing team continuity is automatic: the desktop app captures deduplicated checkpoints and restores each stable AgentSlot through correlated collaboration messages.

## Install from the desktop app

Open the lobby and press **安装团队 MCP**, then explicitly choose the Cursor workspace. The installer:

- preserves unrelated keys and MCP servers in `.cursor/mcp.json`;
- removes dual-entry-era legacy entries (`qingtian-team-ch-N`, `qt-ch-N`, `qtwx-mcp-N`, `qunshu-ch-N`) from the workspace config;
- registers a fresh generation in SQLite and revokes the previous generation;
- restores the original config if generation activation fails.

The single native `SG Team` entry in the global `~/.cursor/mcp.json` is registered at app startup; the production bundle lives outside `app.asar` so Cursor can execute it with `ELECTRON_RUN_AS_NODE=1`.

Restart Cursor after installation. A cancelled folder picker performs no write.

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

The legacy QingTian bridge does not expose Cursor `composerId`, so the current compatibility identity is `workspace hash + channel + install generation`. It is intentionally not treated as a permanent conversation identity. Every MCP tool call checks the active SQLite registration; reinstalling revokes older generations, so a stale Cursor MCP process cannot claim or mutate tasks.

Bridge v1 will upgrade this to `workspaceId + composerId + runtime generation` without changing the task protocol.

## Workflow contract

```text
list -> claim -> start -> renew/report* -> submit_for_review
                                      \-> fail -> queued or failed
```

Claim, start and submit are retry-safe. The lease token remains inside SQLite and the process-bound service. A process with a different generation cannot operate the attempt.

Run the packaged stdio smoke with:

```bash
npm run build:mcp
npm run smoke:mcp
```

The smoke spawns three real MCP subprocesses: owner, wrong generation and resumed owner.

The packaged-app path is separately verified with:

```bash
npm run verify:mac
```
