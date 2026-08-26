# 群枢 architecture

群枢 is an independent desktop control plane. It does not run inside the VSIX and does not read QingTian runtime files directly.

Dependency direction:

```text
renderer -> preload API -> Electron main -> QingTian bridge
                              |
                    +---------+---------+
                    |                   |
                    v                   v
          application services      SQLite task pool
                    |                   ^
                    v                   |
               domain models      stdio Agent MCP
```

Rules:

- The Electron main process is the only owner of the QingTian WebSocket connection.
- The renderer receives validated domain snapshots, never raw socket messages.
- `AgentSession.id` is not a permanent agent identity. It is a compatibility identity until QingTian exposes `composerId + generation`.
- QingTian's existing JSON files are transport implementation details, not this application's source of truth.
- Task, attempt, lease, review and agent-registration state is owned by application/domain services; UI components never advance workflow state directly.
- All future bridge commands require an application-level request ID even if the legacy QingTian protocol cannot echo it yet.
- Legacy `submit` calls are serialized per channel. An in-flight command is never automatically replayed after a disconnect because the legacy bridge has no idempotency key.
- Durable storage of raw Cursor/user conversation history remains deferred until the bridge exposes a stable `workspaceId + runtimeId`. Agent-to-Agent collaboration is separate: it is already persisted by `TeamRun + stable AgentSlot + messageId`, with notification, read and response receipts.

## Team continuity

- task, collaboration and accepted Agent-managed memory changes are projected into bounded automatic checkpoints;
- unchanged state is content-deduplicated instead of creating timer noise;
- one-click recovery creates a role-specific capsule for each stable AgentSlot and uses the durable message bus for delivery;
- recovery is complete only after every Agent sends a correlated response; channel submission alone is not treated as restored;
- raw chat is never presented as team memory, and users do not manually curate recovery data.

## Task pool persistence

The task pool is already durable and uses Electron's bundled `node:sqlite`:

- dedicated database under the 群枢 user-data directory;
- WAL mode, foreign keys and busy timeout enabled;
- normalized `tasks`, `attempts`, `task_events` and `task_pool_meta` tables;
- all aggregate saves use `BEGIN IMMEDIATE` plus revision compare-and-swap;
- lease expiry is swept by the Electron main process, independent of the renderer;
- manual tasks enter the explicit `local-inbox` run until Bridge v1 can perform idempotent dispatch and agent reporting.
- every installed MCP process is bound to an active SQLite agent registration; reinstalling a workspace revokes the prior generation immediately;
- the production MCP bundle is copied to `Contents/Resources/mcp/index.mjs`, outside `app.asar`, and executed through the packaged Electron binary with `ELECTRON_RUN_AS_NODE=1`.

## Distribution boundary

`npm run pack:mac` creates an unsigned local macOS app under `release/`. `npm run verify:mac` launches the MCP bundle through that packaged app executable and repeats the real three-process fencing/resume smoke. Signing and notarization are intentionally a later release step and are not implied by the local package.
