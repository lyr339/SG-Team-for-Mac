# 拾光 architecture

拾光 is an independent desktop control plane for Cursor multi-Agent teamwork. It does not run inside any Cursor extension and does not depend on the legacy QingTian plugin process: channel messages, presence and Agent MCP all flow through the embedded SG Team server plus a shared SQLite database.

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
- The renderer is a pure snapshot consumer: it receives validated domain snapshots via IPC push/pull and never advances workflow state directly. Task/collaboration writes go exclusively through the Agent MCP tools (`team_claim_task`, `team_send_message`, …); the desktop IPC surface exposes only read projections plus workflow entry points (team setup, launch, handoff, account switching).
- The MCP communication contract is exactly two tools: `check_messages` / `record_reply`; Cursor-native process events are observed directly and the keepalive marker is `<sg_team_keepalive n="N"/>`.
- Agent identity is `workspace hash + channel + install generation` (`workspaceId:ch-N:generation`); reinstalling a workspace revokes prior generations immediately, so stale MCP processes are fenced.
- Task, attempt, lease, review and agent-registration state is owned by application/domain services.
- Cursor integration is observation + automation, never a control dependency: CDP (session creation, stream observer, auto-heal) and `state.vscdb` reads degrade gracefully when Cursor is absent.
- Durable storage of raw Cursor/user conversation history remains deferred. Agent-to-Agent collaboration is separate: it is already persisted by `TeamRun + stable AgentSlot + messageId`, with notification, read and response receipts.

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

Switching accounts (FlyCursor-style one-click flow) is orchestrated in the main process: deterministically terminate Cursor (`pkill -x` → poll → `pkill -9` fallback) → logical key backup → write auth keys + account-bound machine identity into `state.vscdb` / `storage.json` / `machineid` exclusively (Cursor must be dead: `node:sqlite` is synchronous and touching the DB while Cursor runs froze the main process) → relaunch with `--remote-debugging-port`.

## Distribution boundary

`npm run pack:mac` creates an unsigned local macOS app under `release/`. `npm run verify:mac` launches the MCP bundle through that packaged app executable and repeats the real three-process fencing/resume smoke. Signing and notarization are intentionally a later release step and are not implied by the local package.
