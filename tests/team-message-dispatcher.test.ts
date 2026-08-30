import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamMessageDispatcher, type TeamMessageDispatcherBridge, type TeamMessageDispatcherTeamSource } from '../src/application/team-message-dispatcher'
import { createDefaultTeamBundle, emptyTeamControlSnapshot, type TeamControlSnapshot } from '../src/domain/team-control'
import type { DesktopSnapshot, SendMessageInput } from '../src/shared/desktop-api'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'

class FakeBridge implements TeamMessageDispatcherBridge {
  readonly sent: Array<SendMessageInput & { commandId: string }> = []
  private readonly listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  private snapshot: DesktopSnapshot = {
    connection: { state: 'connected', endpoint: 'shiguang://local-channel-runtime', attempt: 0, lastError: '' },
    sessions: [],
    conversations: {},
    protocolIssues: [],
    updatedAt: 1
  }

  getSnapshot(): DesktopSnapshot { return structuredClone(this.snapshot) }
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  sendMessage(input: SendMessageInput) {
    const commandId = `command-${this.sent.length + 1}`
    this.sent.push({ ...input, commandId })
    const entry = {
      id: `outgoing:${commandId}`,
      channelId: input.channelId,
      role: 'user',
      text: input.text,
      timestamp: Date.now(),
      status: 'pending',
      source: 'desktop',
      commandId,
      ...(input.silent ? { silent: true } : {})
    } as const
    if (input.silent) {
      this.snapshot.commandReceipts = { ...(this.snapshot.commandReceipts ?? {}), [commandId]: entry }
    } else {
      const entries = this.snapshot.conversations[input.channelId] ?? []
      this.snapshot.conversations[input.channelId] = [...entries, entry]
    }
    return { commandId }
  }
  finish(commandId: string, status: 'complete' | 'failed', error?: string): void {
    const receipt = this.snapshot.commandReceipts?.[commandId]
    if (receipt) {
      receipt.status = status
      receipt.error = error
      receipt.timestamp = Date.now()
    }
    for (const entries of Object.values(this.snapshot.conversations)) {
      const entry = entries.find((candidate) => candidate.commandId === commandId)
      if (entry) {
        entry.status = status
        entry.error = error
        entry.timestamp = Date.now()
      }
    }
    for (const listener of this.listeners) listener(this.getSnapshot())
  }
}

class FakeTeam implements TeamMessageDispatcherTeamSource {
  constructor(private snapshot: TeamControlSnapshot) {}
  getSnapshot(): TeamControlSnapshot { return structuredClone(this.snapshot) }
  subscribe(): () => void { return () => undefined }
  setWaiting(slotId: string, waiting: boolean): void {
    const member = this.snapshot.members.find((candidate) => candidate.slot.id === slotId)
    if (member?.runtime) member.runtime.waiting = waiting
  }
  setOnline(slotId: string, online: boolean): void {
    const member = this.snapshot.members.find((candidate) => candidate.slot.id === slotId)
    if (member?.runtime) member.runtime.online = online
  }
}

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-dispatcher-')), 'team.sqlite3')
  const teamRepository = new SqliteTeamControlRepository(path)
  const bundle = createDefaultTeamBundle({
    workspaceId: 'alpha',
    workspaceName: 'alpha',
    workspacePath: '/workspace/alpha',
    channelIds: ['1', '2'],
    now: 100
  })
  teamRepository.upsertWorkspaceTeam(bundle)
  teamRepository.recordInstallation({
    workspaceId: 'alpha',
    runId: bundle.run.id,
    generation: 'generation123',
    agents: bundle.slots.map((slot) => ({
      agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
      workspaceId: 'alpha',
      channelId: slot.channelId!,
      generation: 'generation123',
      runId: bundle.run.id,
      capabilities: bundle.roles.find((role) => role.id === slot.roleId)!.capabilities
    }))
  })
  const state = teamRepository.loadTeamControl()
  const members = bundle.slots.map((slot) => ({
    slot,
    role: bundle.roles.find((role) => role.id === slot.roleId)!,
    binding: state.bindings.find((binding) => binding.slotId === slot.id),
    runtime: {
      channelId: slot.channelId!,
      status: 'waiting' as const,
      online: true,
      waiting: true,
      queueDepth: 0,
      healthEvidence: ['verified'],
      workingFiles: []
    },
    readiness: 'ready' as const
  }))
  const snapshot: TeamControlSnapshot = {
    ...state,
    activeRun: bundle.run,
    members,
    runtimeChannels: [],
    standbyChannels: [],
    failovers: [],
    preflight: {
      bridgeConnected: true,
      workspaceBound: true,
      goalDefined: true,
      mcpInstalled: true,
      agentsWaiting: true,
      canLaunch: true,
      blockers: []
    }
  }
  const repository = new SqliteTeamCollaborationRepository(path)
  const slot = (key: string) => {
    const role = bundle.roles.find((candidate) => candidate.key === key)!
    return bundle.slots.find((candidate) => candidate.roleId === role.id)!
  }
  return { path, bundle, repository, teamRepository, snapshot, slot }
}

describe('TeamMessageDispatcher', () => {
  it('queues a notification for any verified online recipient and records the real QingTian submit receipt', () => {
    const data = fixture()
    const bridge = new FakeBridge()
    const team = new FakeTeam(data.snapshot)
    const message = data.repository.createMessage({
      runId: data.bundle.run.id,
      sender: { type: 'agent', slotId: data.slot('lead').id },
      recipient: { type: 'agent', slotId: data.slot('builder').id },
      kind: 'directive',
      content: '请读取持久化正文。',
      clientMessageId: 'dispatcher-directive-01'
    })
    const dispatcher = new TeamMessageDispatcher(data.repository, bridge, team)
    try {
      dispatcher.dispatchPending()
      expect(bridge.sent).toHaveLength(1)
      // 系统协作通知必须静默投递：不进用户会话时间线
      expect(bridge.sent[0]).toMatchObject({ channelId: '2', silent: true })
      expect(bridge.sent[0]?.text).toContain(message.id)
      expect(bridge.sent[0]?.text).not.toContain(message.content)
      expect(bridge.getSnapshot().conversations['2']).toBeUndefined()
      expect(bridge.getSnapshot().commandReceipts?.[bridge.sent[0]!.commandId]).toMatchObject({ silent: true })
      expect(data.repository.loadRun(data.bundle.run.id).messages[message.id]?.receipt.notificationState)
        .toBe('sending')

      bridge.finish(bridge.sent[0]!.commandId, 'complete')
      const delivered = data.repository.loadRun(data.bundle.run.id).messages[message.id]!
      expect(delivered.receipt).toMatchObject({
        notificationState: 'notified',
        notificationCommandId: bridge.sent[0]!.commandId
      })
      dispatcher.dispatchPending()
      expect(bridge.sent).toHaveLength(1)
    } finally {
      dispatcher.dispose()
      data.repository.close()
      data.teamRepository.close()
    }
  })

  it('can notify a busy online recipient but keeps the message queued while offline', () => {
    const data = fixture()
    const bridge = new FakeBridge()
    const team = new FakeTeam(data.snapshot)
    team.setWaiting(data.slot('builder').id, false)
    const message = data.repository.createMessage({
      runId: data.bundle.run.id,
      sender: { type: 'operator' },
      recipient: { type: 'agent', slotId: data.slot('builder').id },
      kind: 'question',
      content: '等待 Agent 重新待命后再通知。',
      clientMessageId: 'dispatcher-offline-01'
    })
    const dispatcher = new TeamMessageDispatcher(data.repository, bridge, team)
    try {
      dispatcher.dispatchPending()
      expect(bridge.sent).toHaveLength(1)
      expect(data.repository.loadRun(data.bundle.run.id).messages[message.id]?.receipt.notificationState)
        .toBe('sending')

      bridge.finish(bridge.sent[0]!.commandId, 'complete')
      team.setOnline(data.slot('builder').id, false)
      const offlineMessage = data.repository.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: data.slot('builder').id },
        kind: 'question',
        content: '离线期间保持排队。',
        clientMessageId: 'dispatcher-offline-02'
      })
      dispatcher.dispatchPending()
      expect(bridge.sent).toHaveLength(1)
      expect(data.repository.loadRun(data.bundle.run.id).messages[offlineMessage.id]?.receipt.notificationState)
        .toBe('queued')

      team.setOnline(data.slot('builder').id, true)
      team.setWaiting(data.slot('builder').id, true)
      dispatcher.dispatchPending()
      expect(bridge.sent).toHaveLength(2)
    } finally {
      dispatcher.dispose()
      data.repository.close()
      data.teamRepository.close()
    }
  })

  it('marks an interrupted delivery uncertain and never loops automatic retries', () => {
    const data = fixture()
    const bridge = new FakeBridge()
    const team = new FakeTeam(data.snapshot)
    const message = data.repository.createMessage({
      runId: data.bundle.run.id,
      sender: { type: 'agent', slotId: data.slot('lead').id },
      recipient: { type: 'agent', slotId: data.slot('builder').id },
      kind: 'directive',
      content: '只投递一次。',
      clientMessageId: 'dispatcher-uncertain-01'
    })
    const dispatcher = new TeamMessageDispatcher(data.repository, bridge, team)
    try {
      dispatcher.dispatchPending()
      bridge.finish(bridge.sent[0]!.commandId, 'failed', '连接中断，未自动重发以避免重复提交')
      expect(data.repository.loadRun(data.bundle.run.id).messages[message.id]?.receipt.notificationState)
        .toBe('uncertain')
      dispatcher.dispatchPending()
      dispatcher.dispatchPending()
      expect(bridge.sent).toHaveLength(1)
    } finally {
      dispatcher.dispose()
      data.repository.close()
      data.teamRepository.close()
    }
  })
})
