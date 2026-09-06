# 拾光 architecture

拾光 (SG Team) is an independent desktop control plane for Cursor multi-Agent teamwork. It does not run inside any Cursor extension and does not depend on any plugin process: channel messages, presence and Agent MCP all flow through the embedded SG Team server plus a shared SQLite database.

Dependency direction:

```text
renderer -> preload API -> Electron main (services)
                              |
                              v
                        SQLite (single database file)
                              ^
                              |
                    stdio Agent MCP (SG Team, per-channel identity)
```

Rules:

- SQLite is the only inter-process medium between the Electron main process and the MCP server processes; both open the same database file and rely on `BEGIN IMMEDIATE` + revision CAS for cross-process atomicity.
- The renderer is a pure snapshot consumer: it receives validated domain snapshots via IPC push/pull and never advances workflow state directly. Task/collaboration writes go exclusively through the Agent MCP tools (`team_task`, `team_message`, …); the desktop IPC surface exposes only read projections plus workflow entry points (team setup, launch, handoff, account switching).
- Snapshot assembly is layered once, in order: `ChannelMessageRelay` owns conversations/presence for the embedded channels and orders entries by when they entered the dialogue; `LocalSessionBridge` is the transport that merges relay data into the base snapshot; `DesktopSessionService` adds Cursor telemetry and the live process projection on top and seals finished native turns onto persisted replies. The service reacts to transport events once and coalesces pushes into a microtask, so one relay event yields one post-seal snapshot.
- The MCP surface is nine tools in one native `SG Team` entry: the communication contract is exactly two tools, `check_messages` / `record_reply` (`channel_id`, plus an optional per-seat `session` token, see below); the seven team tools are grouped by object (`team_check_in`, `team_tasks`, `team_task`, `team_review`, `team_message`, `team_memory`, `team_run`) with an `action` / `view` enum each (see `docs/TASK-MCP.md`). Cursor-native process events are observed directly and the keepalive marker is `<sg_team_keepalive n="N"/>`.
- Agent identity is `workspace hash + channel + install generation` (`workspaceId:ch-N:generation`); reinstalling a workspace revokes prior generations immediately, so stale MCP processes are fenced.
- Sessions on the same channel are fenced by a per-seat session token, not by waiting for old heartbeats to expire (see "Run modes and the session fence").
- Task, attempt, lease, review and agent-registration state is owned by application/domain services.
- Cursor integration is observation + automation, never a control dependency: CDP (session creation, stream observer, auto-heal) and `state.vscdb` reads degrade gracefully when Cursor is absent.
- Durable storage of raw Cursor/user conversation history remains deferred. Agent-to-Agent collaboration is separate: it is already persisted by `TeamRun + stable AgentSlot + messageId`, with notification, read and response receipts.

## Run modes and the session fence

A workspace has one active run at a time: either a team run (`team-run:<workspace>:<key>`, one-shot, lead + members) or an independent batch (`session-run:<workspace>:<key>`, solo seats that only talk to the user). Both live in the same `team_runs` table; `activeRun` is the newest run of the active workspace.

Channel numbers are global singletons and one MCP process serves every Cursor session, so `channel_id` alone cannot distinguish the old independent session on CH-N from the new team seat on the same channel. The fence makes the arbitration explicit:

- Every `(run, slot)` runtime binding carries a `session_token`, issued at install time and rotated on seat rebuild (`prepareComposerRelaunch`). Team launch does not rotate it (a session created before launch must not be killed by its own team fence). Standby takeover clears it (the standby was already online without a token); manual handoff moves the donor's token with the donor.
- Launch hints, role briefings and delivery suffixes hand the token to the Agent and require it on `check_messages` / `record_reply`. Team tools only take `channel_id`.
- On every communication call the MCP server resolves the channel's owner in the active run (`resolveChannelSessionOwner`, one lightweight query) and evaluates the token *before* any presence write: `ok` (token matches the seat), `legacy` (no token presented: pre-upgrade sessions keep the old contract), or `retired` (`no_run`, `run_completed`, `channel_unbound`, `token_mismatch`). A retired `check_messages` returns a plain-text system instruction that is equivalent to the user asking the Agent to stop; a retired `record_reply` returns `code: session_retired`. If ownership cannot be resolved the fence fails open.
- Switching the conversation scope to a different run (`beginScope`) marks every `channel_presence` row `retired`: old heartbeats no longer represent the new seats. `retired` is an explicit stop phase (offline, `runtimeEvidence = stopped`) that only new life evidence revives: the new session's first tool call (`touchPresence`) or CDP runtime activity for a Composer bound in the *current* run (`touchRuntimeActivity`). Replaying the same scope after a restart does not revive it.

Mode switching therefore no longer hard-blocks on live sessions. `configureWorkspace` and `configureIndependentWorkspace` share `replaceActiveRun` (complete the previous run with a "replaced" reason → write the new bundle → begin the new scope); `endActiveRun` ends the current run explicitly. The only hard block is a team launch whose instructions are still being delivered (or a one-click session creation still running in the desktop). The renderer owns the consequence step: `RunModePanel` replaces the old full-page interception in independent mode and asks once when sessions are still live; `IndependentSessionPage` guards "结束批次" / "新建批次" / creating over a live team run the same way. `createNextRun` (a new round of the same team) keeps the "previous run must be over" rule because a team run is a one-shot session, not a mode.

## Team continuity

- task, collaboration and accepted Agent-managed memory changes are projected into bounded automatic checkpoints;
- unchanged state is content-deduplicated instead of creating timer noise;
- one-click recovery creates a role-specific capsule for each stable AgentSlot and uses the durable message bus for delivery;
- recovery is complete only after every Agent sends a correlated response; channel submission alone is not treated as restored;
- raw chat is never presented as team memory, and users do not manually curate recovery data.

## Task pool persistence

The task pool is durable and uses Electron's bundled `node:sqlite`:

- dedicated database under the 拾光 user-data directory;
- WAL mode, foreign keys and busy timeout enabled;
- normalized `tasks`, `attempts`, `task_events` and `task_pool_meta` tables;
- all aggregate saves use `BEGIN IMMEDIATE` plus revision compare-and-swap;
- lease expiry is swept by the Electron main process, independent of the renderer;
- every installed MCP process is bound to an active SQLite agent registration;
- the production MCP bundle is copied to `Contents/Resources/mcp/index.mjs`, outside `app.asar`, and executed through the packaged Electron binary with `ELECTRON_RUN_AS_NODE=1`.

## Cursor account switching

Switching accounts (FlyCursor-style one-click flow) is orchestrated in the main process: deterministically terminate Cursor (macOS `pkill -x` → poll → `pkill -9` fallback; Windows `taskkill /F`) → logical key backup → write auth keys + account-bound machine identity into `state.vscdb` / `storage.json` / `machineid` exclusively (Cursor must be dead: `node:sqlite` is synchronous and touching the DB while Cursor runs froze the main process) → relaunch with `--remote-debugging-port`. On Windows the relaunch uses the executable path captured from the running process before it was terminated (per-user and all-users Inno Setup installs live in different directories and the latter registers no App Paths entry).

## Platform boundary

Both desktop platforms are first-class. Everything that touches Cursor's own files goes through `src/infrastructure/cursor/cursor-install-paths.ts` (user-data root, install roots, workbench bundle), and process control goes through the platform pair `open/pkill/pgrep/osascript` (macOS) vs `cmd start/taskkill/tasklist/PowerShell Get-Process` (Windows). Two account-automation browser hosts exist: the fingerprint browser (RoxyBrowser, both platforms) and the external system browser (macOS only, AppleScript); Windows always uses the fingerprint host.

## Distribution boundary

`npm run pack:mac` creates an unsigned local macOS app and `npm run pack:win` an NSIS installer plus `win-unpacked` under `release/`. `npm run verify:mac` / `verify:win` launch the MCP bundle through that packaged executable and repeat the real three-process fencing/resume smoke. Signing and notarization are intentionally a later release step and are not implied by the local package.
