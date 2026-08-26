# UI structure

The desktop app has two levels. They share the same `AgentSession` projection and never maintain separate copies of session state.

## 1. Session overview

- Card grid for health, task, context pressure, change summary and queue depth.
- Filters for running, waiting, blocked, reviving and offline sessions.
- Team and task summaries are added here later.

## 2. Session workspace

Opened by selecting a session card:

```text
session list | session header + warning rail
             | transcript / tool timeline / diff
             | message composer + handoff + unattended controls
```

The reference UI's commerce banner, refund actions and unrelated utilities are intentionally excluded. The useful patterns are persistent session navigation, explicit disconnection messaging, visible recovery, a stable composer and direct handoff.

Required data before the workspace is enabled:

- stable `composerId + generation` identity;
- transcript and tool event stream;
- model and context usage telemetry;
- session-attributed file changes;
- send, recover, stop and handoff commands with request IDs.
