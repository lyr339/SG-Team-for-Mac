# QingTian bridge v1 contract

The current `3180` protocol remains a compatibility transport. These fields are required before the desktop app treats the bridge as a durable control plane.

## Identity handshake

```json
{
  "type": "server.hello",
  "protocolVersion": 1,
  "instanceId": "plugin-process-id",
  "runtimeId": "qingtian-runtime-generation",
  "workspaceId": "stable-workspace-id",
  "workspacePath": "/absolute/path",
  "capabilities": ["session.telemetry", "conversation.stream", "command.idempotency"]
}
```

`channelId` is routing metadata. A session identity is:

```text
workspaceId + composerId + generation
```

## Commands

Every command carries `requestId` and `idempotencyKey` and receives exactly one `command.result`.

```json
{
  "type": "command",
  "requestId": "uuid",
  "idempotencyKey": "uuid",
  "method": "session.send",
  "payload": { "sessionId": "...", "text": "..." }
}
```

Required methods:

- `session.list`
- `session.send`
- `session.recover`
- `session.stop`
- `session.handoff`
- `telemetry.subscribe`

## Events and resume

Every event has a monotonically increasing `seq`. The client reconnects with its last committed sequence; the bridge replays missing events or returns `resyncRequired`.

Required events:

- `session.upsert`
- `session.removed`
- `session.activity`
- `conversation.entry`
- `conversation.delta`
- `command.result`

## Session telemetry

```json
{
  "sessionId": "workspace:composer:generation",
  "composerId": "cursor-composer-id",
  "generation": 3,
  "channelId": "2",
  "state": "running",
  "model": "composer-2.5",
  "context": { "used": 370000, "limit": 1000000 },
  "changes": { "additions": 275, "deletions": 17, "files": 10 },
  "currentTaskId": "task-id",
  "lastActivityAt": 0,
  "evidence": ["mcp-heartbeat", "cursor-run", "composer-presence"]
}
```

## Security

- Authentication is required on loopback too.
- The token is short-lived and scoped to one plugin runtime.
- The bridge validates `Origin` and message size.
- Sensitive commands such as stop, handoff and cleanup require explicit capability checks.
