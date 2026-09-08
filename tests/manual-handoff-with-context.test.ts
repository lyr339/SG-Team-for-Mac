import { describe, expect, it } from 'vitest'
import { manualHandoffWithContext, type ManualHandoffWithContextPorts } from '../src/application/manual-handoff-with-context'
import type { SessionHandoffContext, SessionHandoffResult } from '../src/domain/session-handoff'
import { emptyTeamControlSnapshot, type TeamControlSnapshot, type TeamMemberView } from '../src/domain/team-control'
import type { ManualTeamHandoffResult } from '../src/domain/team-handoff'

const SOURCE_CONTEXT: SessionHandoffContext = {
  channelId: '2',
  displayName: '架构实现 · CH-2',
  role: { name: '架构实现', slotName: '实现席', templateKey: 'builder' },
  composerId: 'composer-2',
  transcript: { path: '/transcripts/composer-2.jsonl', exists: true, resolution: 'workspace' },
  holdSupported: true,
  userMessageCount: 3,
  assistantMessageCount: 3
}

const MIGRATED: ManualTeamHandoffResult = { mode: 'role_rebind', messageId: 'msg-1', vacatedSlotId: undefined }

function team(): TeamControlSnapshot {
  const run = {
    id: 'team-run:ws:main', workspaceId: 'ws', name: '主运行', goal: '', templateId: 'software-core-v1',
    status: 'running' as const, createdAt: 1, updatedAt: 1
  }
  const builder: TeamMemberView = {
    slot: { id: 'slot-builder', runId: run.id, roleId: 'role-builder', name: '实现席', avatarId: 'architect', channelId: '2', order: 0, createdAt: 1, updatedAt: 1 },
    role: { id: 'role-builder', runId: run.id, key: 'builder', templateKey: 'builder', name: '架构实现', mission: '', instructions: '', capabilities: [], skills: [], accent: 'mint', order: 0 },
    binding: {
      id: 'b-2', workspaceId: 'ws', runId: run.id, slotId: 'slot-builder', channelId: '2', agentSessionId: 'agent-2', generation: 'g1',
      installedAt: 1, launchStatus: 'acknowledged', launchDetail: '', lastCheckInNote: '', composerBindingKey: 'k2', composerId: 'composer-2'
    },
    readiness: 'offline'
  }
  return {
    ...emptyTeamControlSnapshot(),
    activeRun: run,
    runs: [run],
    members: [builder],
    bindings: [builder.binding!],
    runtimeChannels: [
      { channelId: '2', displayName: '架构实现 · CH-2', status: 'offline', online: false, waiting: false, queueDepth: 0, registered: true, assignedSlotId: 'slot-builder', agentSessionId: 'agent-2' },
      { channelId: '7', displayName: 'SG Team CH-7', status: 'waiting', online: true, waiting: true, queueDepth: 0, registered: true, agentSessionId: 'agent-7' }
    ],
    standbyChannels: [
      { channelId: '7', displayName: 'SG Team CH-7', status: 'waiting', online: true, waiting: true, queueDepth: 0, registered: true, agentSessionId: 'agent-7' }
    ]
  }
}

function harness(options: { deliverError?: string; migrateError?: string; contextError?: string } = {}) {
  const calls: string[] = []
  const snapshot = team()
  const ports: ManualHandoffWithContextPorts = {
    failover: {
      manualHandoff: (input) => {
        calls.push(`migrate:${input.sourceSlotId}->${input.replacementAgentSessionId}`)
        if (options.migrateError) throw new Error(options.migrateError)
        // 迁移改写绑定：原席位现在指向接手通道，原通道失去 Composer
        snapshot.members[0]!.binding = { ...snapshot.members[0]!.binding!, channelId: '7', composerId: undefined }
        return MIGRATED
      }
    },
    team: { getSnapshot: () => snapshot },
    handoff: {
      context: (channelId) => {
        calls.push(`context:${channelId}`)
        if (options.contextError) throw new Error(options.contextError)
        return SOURCE_CONTEXT
      },
      deliverFrom: (source, target): SessionHandoffResult => {
        calls.push(`deliver:${source.channelId}->${target.kind === 'channel' ? target.channelId : 'self'}`)
        if (options.deliverError) throw new Error(options.deliverError)
        return { targetChannelId: target.kind === 'channel' ? target.channelId : source.channelId, held: false, transcriptPath: source.transcript!.path, commandId: 'cmd-1', issuedAt: 1 }
      }
    }
  }
  return { ports, calls }
}

describe('manualHandoffWithContext', () => {
  it('resolves the source context before the migration and delivers it to the replacement channel afterwards', () => {
    const { ports, calls } = harness()
    const outcome = manualHandoffWithContext(ports, {
      sourceSlotId: 'slot-builder', replacementAgentSessionId: 'agent-7', includeContext: true
    })
    expect(calls).toEqual(['context:2', 'migrate:slot-builder->agent-7', 'deliver:2->7'])
    expect(outcome.handoff).toBe(MIGRATED)
    expect(outcome.contextHandoff).toMatchObject({ ok: true, result: { targetChannelId: '7', transcriptPath: '/transcripts/composer-2.jsonl' } })
  })

  it('reports a failed context delivery without undoing the migration', () => {
    const { ports, calls } = harness({ deliverError: 'CH-2 尚未绑定 Cursor Composer，找不到它的上下文文档' })
    const outcome = manualHandoffWithContext(ports, {
      sourceSlotId: 'slot-builder', replacementAgentSessionId: 'agent-7', includeContext: true
    })
    expect(calls).toEqual(['context:2', 'migrate:slot-builder->agent-7', 'deliver:2->7'])
    expect(outcome.handoff).toBe(MIGRATED)
    expect(outcome.contextHandoff).toEqual({ ok: false, error: 'CH-2 尚未绑定 Cursor Composer，找不到它的上下文文档' })
  })

  it('propagates a failed migration and never delivers anything', () => {
    const { ports, calls } = harness({ migrateError: '候选 Agent 当前不可交接' })
    expect(() => manualHandoffWithContext(ports, {
      sourceSlotId: 'slot-builder', replacementAgentSessionId: 'agent-7', includeContext: true
    })).toThrowError('候选 Agent 当前不可交接')
    expect(calls).toEqual(['context:2', 'migrate:slot-builder->agent-7'])
  })

  it('still migrates when resolving the source context throws, and reports that error', () => {
    const { ports, calls } = harness({ contextError: 'EACCES: transcript directory unreadable' })
    const outcome = manualHandoffWithContext(ports, {
      sourceSlotId: 'slot-builder', replacementAgentSessionId: 'agent-7', includeContext: true
    })
    expect(calls).toEqual(['context:2', 'migrate:slot-builder->agent-7'])
    expect(outcome.handoff).toBe(MIGRATED)
    expect(outcome.contextHandoff).toEqual({ ok: false, error: 'EACCES: transcript directory unreadable' })
  })

  it('is a plain migration without includeContext', () => {
    const { ports, calls } = harness()
    const outcome = manualHandoffWithContext(ports, { sourceSlotId: 'slot-builder', replacementAgentSessionId: 'agent-7' })
    expect(calls).toEqual(['migrate:slot-builder->agent-7'])
    expect(outcome).toEqual({ handoff: MIGRATED })
  })

  it('reports when the replacement channel cannot be located instead of guessing a target', () => {
    const { ports, calls } = harness()
    const outcome = manualHandoffWithContext(ports, {
      sourceSlotId: 'slot-builder', replacementAgentSessionId: 'agent-unknown', includeContext: true
    })
    expect(calls).toEqual(['context:2', 'migrate:slot-builder->agent-unknown'])
    expect(outcome.contextHandoff).toEqual({ ok: false, error: '迁移前没有定位到原席位或接手通道，上下文文档未投递' })
  })
})
