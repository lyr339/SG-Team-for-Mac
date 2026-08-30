import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamCollaborationAgentService } from '../src/application/team-collaboration-agent-service'
import { TeamCollaborationService } from '../src/application/team-collaboration-service'
import { TeamContinuityService } from '../src/application/team-continuity-service'
import { TeamControlService, type TeamControlBridge } from '../src/application/team-control-service'
import { TeamFailoverService } from '../src/application/team-failover-service'
import { TeamMemoryService } from '../src/application/team-memory-service'
import { TaskAgentService } from '../src/application/task-agent-service'
import { TaskPoolService } from '../src/application/task-pool-service'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { ALL_TEAM_CAPABILITIES } from '../src/domain/team-control'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamContinuityRepository } from '../src/infrastructure/team-continuity/sqlite-team-continuity-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'
import type { DesktopSnapshot, SendMessageInput } from '../src/shared/desktop-api'

class MutableBridge implements TeamControlBridge {
  private readonly listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  private command = 0

  constructor(private snapshot: DesktopSnapshot) {}

  getSnapshot(): DesktopSnapshot { return structuredClone(this.snapshot) }

  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  sendMessage(_input: SendMessageInput) { return { commandId: `command-${++this.command}` } }

  setChannelOnline(channelId: string, online: boolean): void {
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) => session.channelId === channelId
        ? {
            ...session,
            status: online ? 'waiting' : 'offline',
            online,
            connected: online,
            runtimeEvidence: online ? 'active' : 'stopped',
            waiting: online,
            connectionPhase: online ? 'waiting' : 'cursor_stopped',
            lastSeenAt: online ? Date.now() : session.lastSeenAt,
            healthEvidence: online ? ['check_messages 正在待命'] : ['Cursor Agent 已停止监听']
          }
        : session),
      updatedAt: this.snapshot.updatedAt + 1
    }
    for (const listener of this.listeners) listener(this.getSnapshot())
  }

  setChannelProcessing(channelId: string, online = false): void {
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) => session.channelId === channelId
        ? {
            ...session,
            status: 'running',
            online,
            connected: online,
            runtimeEvidence: online ? 'active' : 'suspected',
            waiting: false,
            connectionPhase: 'processing',
            lastSeenAt: 1,
            healthEvidence: ['已领取消息，正在执行长任务']
          }
        : session),
      updatedAt: this.snapshot.updatedAt + 1
    }
    for (const listener of this.listeners) listener(this.getSnapshot())
  }

  setChannelSuspectedOffline(channelId: string): void {
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) => session.channelId === channelId
        ? {
            ...session,
            status: 'offline',
            online: false,
            connected: false,
            runtimeEvidence: 'suspected',
            waiting: false,
            connectionPhase: 'waiting',
            lastSeenAt: 1,
            healthEvidence: ['MCP 租约陈旧，缺少明确终止证据']
          }
        : session),
      updatedAt: this.snapshot.updatedAt + 1
    }
    for (const listener of this.listeners) listener(this.getSnapshot())
  }
}

function desktopSnapshot(channelIds: string[]): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: 'shiguang://local-channel-runtime', attempt: 0, lastError: '' },
    sessions: channelIds.map((channelId) => ({
      id: `qingtian-channel:${channelId}`,
      channelId,
      generation: 0,
      displayName: `QingTian CH-${channelId}`,
      roleName: '未绑定外置团队',
      status: 'waiting',
      currentTask: '',
      queueDepth: 0,
      connectionPhase: 'waiting',
      online: true,
      connected: true,
      runtimeEvidence: 'active' as const,
      waiting: true,
      workingFiles: channelId === '2' ? ['src/service.ts', 'tests/service.test.ts'] : [],
      healthEvidence: ['check_messages 正在待命']
    })),
    conversations: {},
    protocolIssues: [],
    updatedAt: 1
  }
}

function fixture(withStandby: boolean) {
  const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-failover-')), 'team.sqlite3')
  const controlRepository = new SqliteTeamControlRepository(path)
  const taskRepository = new SqliteTaskPoolRepository(path)
  const collaborationRepository = new SqliteTeamCollaborationRepository(path)
  const continuityRepository = new SqliteTeamContinuityRepository(path)
  const memoryRepository = new SqliteTeamMemoryRepository(path)
  const bridge = new MutableBridge(desktopSnapshot(withStandby ? ['1', '2', '3'] : ['1', '2']))
  const control = new TeamControlService(controlRepository, bridge)
  const selected = control.ensureWorkspace({
    workspaceId: 'alpha',
    workspaceName: 'alpha',
    workspacePath: '/workspace/alpha',
    channelIds: ['1', '2']
  })
  const runId = selected.activeRun!.id
  control.updateGoal('完成本轮接口重构')
  const memberByChannel = new Map(selected.members.map((member) => [member.slot.channelId!, member]))
  control.recordInstallation({
    workspaceId: 'alpha',
    runId,
    generation: 'generation123',
    agents: (withStandby ? ['1', '2', '3'] : ['1', '2']).map((channelId) => {
      const member = memberByChannel.get(channelId)
      return {
        agentSessionId: `alpha:ch-${channelId}:generation123`,
        workspaceId: 'alpha',
        channelId,
        generation: 'generation123',
        runId,
        capabilities: member?.role.capabilities ?? ALL_TEAM_CAPABILITIES
      }
    })
  })
  controlRepository.beginLaunch(runId, 100, 'binding-key-123')
  for (const member of control.getSnapshot().members) {
    controlRepository.recordAgentCheckIn({
      agentSessionId: member.binding!.agentSessionId,
      runId,
      slotId: member.slot.id,
      capabilities: member.role.capabilities
    }, 'ready')
  }

  const tasks = new TaskPoolService(taskRepository, control)
  const collaboration = new TeamCollaborationService(collaborationRepository, control)
  const memory = new TeamMemoryService(memoryRepository, control)
  const continuity = new TeamContinuityService(continuityRepository, collaborationRepository, {
    team: control,
    tasks,
    collaboration,
    memory
  })
  const builder = control.getSnapshot().members.find((member) => member.role.templateKey === 'builder')!
  const lead = control.getSnapshot().members.find((member) => member.role.templateKey === 'lead')!
  const task = transactTaskPool(taskRepository, (pool) => {
    const [planned] = pool.plan(runId, [{
      key: 'build-core',
      title: '实现核心接口',
      targetSlotId: builder.slot.id,
      requiredCapabilities: ['code']
    }])
    const lease = pool.leaseTask(planned!.id, {
      runId,
      slotId: builder.slot.id,
      agentSessionId: builder.binding!.agentSessionId,
      capabilities: builder.role.capabilities
    })!
    pool.startAttempt(lease.attempt.id, lease.leaseToken)
    pool.reportProgress(lease.attempt.id, lease.leaseToken, 55, '接口主体完成，正在补测试')
    return planned!
  })
  let now = 1_000
  const failover = new TeamFailoverService(
    controlRepository,
    control,
    tasks,
    collaborationRepository,
    continuity,
    { now: () => now, offlineGraceMs: 0, allOfflineGraceMs: 0 }
  )
  return {
    bridge,
    control,
    controlRepository,
    taskRepository,
    collaborationRepository,
    continuityRepository,
    memoryRepository,
    collaboration,
    memory,
    continuity,
    tasks,
    failover,
    lead,
    builder,
    task,
    runId,
    advance: (milliseconds: number) => { now += milliseconds },
    close: () => {
      failover.stop()
      continuity.dispose()
      collaboration.dispose()
      memory.dispose()
      control.dispose()
      continuityRepository.close()
      collaborationRepository.close()
      memoryRepository.close()
      taskRepository.close()
      controlRepository.close()
    }
  }
}

describe('TeamFailoverService', () => {
  it('moves one stable role, its active lease and takeover capsule to an idle standby agent', () => {
    const data = fixture(true)
    try {
      data.bridge.setChannelOnline('2', false)
      data.failover.reconcile()

      const team = data.control.getSnapshot()
      const builder = team.members.find((member) => member.slot.id === data.builder.slot.id)!
      expect(builder.binding).toMatchObject({
        channelId: '3',
        agentSessionId: 'alpha:ch-3:generation123',
        launchStatus: 'sending'
      })
      expect(team.standbyChannels).toHaveLength(0)
      expect(team.failovers[0]).toMatchObject({
        slotId: builder.slot.id,
        fromChannelId: '2',
        toChannelId: '3',
        status: 'waiting_for_agent',
        taskIds: [data.task.id]
      })
      expect(() => data.controlRepository.resolveAgentRuntimeIdentity(
        'alpha:ch-2:generation123',
        data.runId
      )).toThrow(/撤销/)
      expect(data.controlRepository.resolveAgentRuntimeIdentity(
        'alpha:ch-3:generation123',
        data.runId
      )).toMatchObject({ slotId: builder.slot.id, capabilities: builder.role.capabilities })

      const taskState = data.taskRepository.load()
      const transferred = taskState.tasks[data.task.id]!
      expect(transferred).toMatchObject({
        status: 'running',
        progress: 55,
        assigneeSessionId: 'alpha:ch-3:generation123'
      })
      expect(taskState.attempts[transferred.currentAttemptId!]!.summary).toBe('接口主体完成，正在补测试')

      const messageId = team.failovers[0]!.messageId!
      const message = data.collaborationRepository.loadRun(data.runId).messages[messageId]!
      expect(message.content).toContain('拾光 自动接替胶囊')
      expect(message.content).toContain('src/service.ts')
      expect(message.content).toContain('接口主体完成，正在补测试')

      const identity = data.controlRepository.resolveAgentRuntimeIdentity(
        'alpha:ch-3:generation123',
        data.runId
      )
      const taskAgent = new TaskAgentService(data.taskRepository, identity, data.taskRepository, data.controlRepository)
      const collaborationAgent = new TeamCollaborationAgentService(
        data.collaborationRepository,
        { ...identity, slotId: identity.slotId! },
        taskAgent
      )
      collaborationAgent.respondMessage({ messageId, content: '已接替，继续补齐测试。' })
      data.failover.reconcile()
      expect(data.control.getSnapshot().failovers[0]?.status).toBe('completed')
      expect(data.control.getSnapshot().activeRun?.status).toBe('running')
    } finally {
      data.close()
    }
  })

  it('manually hands effective lead authority to an online busy member without moving its role binding', () => {
    const data = fixture(false)
    try {
      data.bridge.setChannelOnline('1', false)
      const [leadTask] = transactTaskPool(data.taskRepository, (pool) => {
        const [planned] = pool.plan(data.runId, [{
          key: 'lead-coordination', title: '继续主控协调', targetSlotId: data.lead.slot.id,
          requiredCapabilities: ['coordination']
        }])
        const lease = pool.leaseTask(planned!.id, {
          runId: data.runId,
          slotId: data.lead.slot.id,
          agentSessionId: data.lead.binding!.agentSessionId,
          capabilities: data.lead.role.capabilities
        })
        pool.startAttempt(lease.attempt.id, lease.leaseToken)
        return [planned]
      })
      const pendingLeadMessage = data.collaborationRepository.createMessage({
        runId: data.runId,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: data.lead.slot.id },
        kind: 'directive',
        content: '原主控尚未处理的用户决策请求',
        clientMessageId: 'manual-handoff-pending-lead-message'
      })
      const options = data.failover.manualHandoffOptions(data.lead.slot.id)
      const candidate = options.candidates.find((item) => item.slotId === data.builder.slot.id)!
      expect(candidate).toMatchObject({
        eligible: true,
        kind: 'member',
        mode: 'lead_authority',
        channelId: '2'
      })
      expect(candidate.impact).toContain('保留')

      const result = data.failover.manualHandoff({
        sourceSlotId: data.lead.slot.id,
        replacementAgentSessionId: candidate.agentSessionId
      })
      const team = data.control.getSnapshot()
      expect(result).toMatchObject({
        mode: 'lead_authority',
        actingLeadSlotId: data.builder.slot.id,
        recoveredTaskIds: [leadTask!.id]
      })
      expect(team.activeRun?.actingLeadSlotId).toBe(data.builder.slot.id)
      expect(team.members.find((member) => member.slot.id === data.builder.slot.id)?.binding)
        .toMatchObject({ channelId: '2', agentSessionId: data.builder.binding!.agentSessionId })
      expect(team.members.find((member) => member.slot.id === data.lead.slot.id)?.binding)
        .toMatchObject({ channelId: '1', agentSessionId: data.lead.binding!.agentSessionId })
      const promotedIdentity = data.controlRepository.resolveAgentRuntimeIdentity(
        data.builder.binding!.agentSessionId,
        data.runId
      )
      expect(promotedIdentity).toMatchObject({ slotId: data.builder.slot.id })
      expect(promotedIdentity.capabilities).toEqual(expect.arrayContaining(['coordination', 'planning']))
      const demotedIdentity = data.controlRepository.resolveAgentRuntimeIdentity(
        data.lead.binding!.agentSessionId,
        data.runId
      )
      expect(demotedIdentity.capabilities).not.toContain('coordination')
      expect(data.taskRepository.load().tasks[leadTask!.id]).toMatchObject({
        status: 'queued',
        assigneeSessionId: undefined,
        targetSlotId: data.builder.slot.id
      })
      expect(data.taskRepository.load().tasks[data.task.id]).toMatchObject({
        status: 'running', assigneeSessionId: data.builder.binding!.agentSessionId
      })
      const handoffMessage = data.collaborationRepository.loadRun(data.runId).messages[result.messageId]!
      expect(handoffMessage.content).toContain('拾光真实主控交接')
      expect(handoffMessage.content).toContain('team_check_in')
      expect(handoffMessage.content).toContain(pendingLeadMessage.id)
      expect(handoffMessage.content).toContain('原主控尚未处理的用户决策请求')
      expect(new Set(team.bindings.map((binding) => binding.agentSessionId)).size).toBe(team.bindings.length)
    } finally {
      data.close()
    }
  })

  it('never vacates the only online lead to cover a non-lead role', () => {
    const data = fixture(false)
    try {
      data.bridge.setChannelOnline('2', false)
      const options = data.failover.manualHandoffOptions(data.builder.slot.id)
      expect(options.candidates).toEqual([
        expect.objectContaining({
          slotId: data.lead.slot.id,
          eligible: false,
          blocker: '不能挪走当前唯一主控'
        })
      ])
    } finally {
      data.close()
    }
  })

  it('leaves the role visibly offline when no standby agent exists', () => {
    const data = fixture(false)
    try {
      data.bridge.setChannelOnline('2', false)
      data.failover.reconcile()
      const team = data.control.getSnapshot()
      const builder = team.members.find((member) => member.slot.id === data.builder.slot.id)!
      expect(builder.binding?.channelId).toBe('2')
      expect(builder.runtime?.online).toBe(false)
      expect(team.failovers).toEqual([])
      expect(team.activeRun?.status).toBe('running')
    } finally {
      data.close()
    }
  })

  it('recovers a crash after atomic role rebind but before task and capsule delivery', () => {
    const data = fixture(true)
    try {
      const failoverId = 'team-failover:crash-recovery'
      data.controlRepository.rebindSlotToStandby({
        failoverId,
        runId: data.runId,
        slotId: data.builder.slot.id,
        expectedAgentSessionId: data.builder.binding!.agentSessionId,
        replacementAgentSessionId: 'alpha:ch-3:generation123',
        reason: '模拟换绑后进程退出',
        detectedAt: 1_000,
        bindingKey: 'takeover-binding-123'
      })

      data.failover.reconcile()

      const record = data.control.getSnapshot().failovers.find((candidate) => candidate.id === failoverId)!
      expect(record).toMatchObject({ status: 'waiting_for_agent', taskIds: [data.task.id] })
      expect(record.messageId).toBeTruthy()
      expect(data.taskRepository.load().tasks[data.task.id]?.assigneeSessionId)
        .toBe('alpha:ch-3:generation123')
    } finally {
      data.close()
    }
  })

  it('ends the ephemeral TeamRun and revokes every runtime after all agents disconnect', () => {
    const data = fixture(true)
    try {
      data.bridge.setChannelOnline('1', false)
      data.bridge.setChannelOnline('2', false)
      data.bridge.setChannelOnline('3', false)
      data.failover.reconcile()
      expect(data.control.getSnapshot().activeRun?.status).toBe('completed')
      expect(data.controlRepository.listAgentRegistrations(data.runId)).toEqual([])
      const taskState = data.taskRepository.load()
      expect(taskState.tasks[data.task.id]).toMatchObject({
        status: 'cancelled',
        failureReason: '本轮全部 Agent 已离线，未完成任务自动取消'
      })
      expect(taskState.attempts[taskState.tasks[data.task.id]!.currentAttemptId!]).toMatchObject({
        status: 'cancelled',
        leaseToken: undefined,
        leaseExpiresAt: undefined
      })
      expect(() => data.collaboration.send({
        recipientSlotId: data.builder.slot.id,
        kind: 'question',
        content: '本轮结束后不应继续发送'
      })).toThrowError(/本轮团队已经结束/)
      expect(() => data.controlRepository.resolveAgentRuntimeIdentity(
        'alpha:ch-1:generation123',
        data.runId
      )).toThrow(/撤销/)
    } finally {
      data.close()
    }
  })

  it('repairs unfinished tasks left by a previously completed run on startup', () => {
    const data = fixture(true)
    try {
      data.controlRepository.completeRun(data.runId, 1_000)
      expect(data.taskRepository.load().tasks[data.task.id]?.status).toBe('running')

      data.failover.reconcile()

      expect(data.taskRepository.load().tasks[data.task.id]).toMatchObject({
        status: 'cancelled',
        failureReason: '本轮全部 Agent 已离线，未完成任务自动取消'
      })
    } finally {
      data.close()
    }
  })

  it('explicitly transfers lead permissions to an online member via team_transfer_lead', () => {
    const data = fixture(true)
    try {
      const lead = data.lead
      const builder = data.builder
      const leadIdentity = data.controlRepository.resolveAgentRuntimeIdentity(
        lead.binding!.agentSessionId,
        data.runId
      )
      const leadAgent = new TeamCollaborationAgentService(
        data.collaborationRepository,
        { ...leadIdentity, slotId: leadIdentity.slotId! },
        new TaskAgentService(data.taskRepository, leadIdentity, data.taskRepository, data.controlRepository)
      )
      expect(leadAgent.isCoordinator()).toBe(true)
      const preTransferBuilderIdentity = data.controlRepository.resolveAgentRuntimeIdentity(
        data.builder.binding!.agentSessionId,
        data.runId
      )
      expect(preTransferBuilderIdentity.capabilities).not.toContain('coordination')

      data.control.transferLead({ targetSlotId: builder.slot.id, reason: '主控暂时离线' })
      const team = data.control.getSnapshot()
      expect(team.activeRun?.actingLeadSlotId).toBe(builder.slot.id)

      const builderIdentity = data.controlRepository.resolveAgentRuntimeIdentity(
        builder.binding!.agentSessionId,
        data.runId
      )
      expect(builderIdentity.capabilities).toEqual(expect.arrayContaining(['coordination', 'planning']))
      const builderAgent = new TeamCollaborationAgentService(
        data.collaborationRepository,
        { ...builderIdentity, slotId: builderIdentity.slotId! },
        new TaskAgentService(data.taskRepository, builderIdentity, data.taskRepository, data.controlRepository)
      )
      expect(builderAgent.isCoordinator()).toBe(true)
      expect(() => builderAgent.broadcast({ kind: 'notice', content: '测试广播' })).not.toThrow()
      expect(() => builderAgent.listTaskBoard()).not.toThrow()

      const demotedLeadIdentity = data.controlRepository.resolveAgentRuntimeIdentity(
        lead.binding!.agentSessionId,
        data.runId
      )
      expect(demotedLeadIdentity.capabilities).not.toContain('coordination')
      const demotedLead = new TeamCollaborationAgentService(
        data.collaborationRepository,
        { ...demotedLeadIdentity, slotId: demotedLeadIdentity.slotId! },
        new TaskAgentService(data.taskRepository, demotedLeadIdentity, data.taskRepository, data.controlRepository)
      )
      expect(demotedLead.isCoordinator()).toBe(false)
      expect(() => demotedLead.listTaskBoard()).toThrowError(/只有主控协调/)
      const statusMessage = demotedLead.reportTaskStatus({
        taskId: data.task.id,
        subject: '交接后状态上报',
        content: '状态应发给当前临时主控',
        eventKey: 'effective-lead-routing'
      })
      expect(statusMessage?.recipient).toMatchObject({ type: 'agent', slotId: builder.slot.id })
    } finally {
      data.close()
    }
  })

  it('automatically promotes the most senior online member when lead goes offline without standby', () => {
    const data = fixture(false)
    try {
      const [leadTask] = transactTaskPool(data.taskRepository, (pool) => {
        const planned = pool.plan(data.runId, [{
          key: 'auto-lead-work', title: '自动接管前的主控任务',
          targetSlotId: data.lead.slot.id, requiredCapabilities: ['coordination']
        }])[0]!
        const lease = pool.leaseTask(planned.id, {
          runId: data.runId,
          slotId: data.lead.slot.id,
          agentSessionId: data.lead.binding!.agentSessionId,
          capabilities: data.lead.role.capabilities
        })
        pool.startAttempt(lease.attempt.id, lease.leaseToken)
        return [planned]
      })
      data.bridge.setChannelOnline('1', false)
      data.failover.reconcile()

      const team = data.control.getSnapshot()
      expect(team.activeRun?.actingLeadSlotId).toBe(data.builder.slot.id)

      const builderIdentity = data.controlRepository.resolveAgentRuntimeIdentity(
        data.builder.binding!.agentSessionId,
        data.runId
      )
      const builderAgent = new TeamCollaborationAgentService(
        data.collaborationRepository,
        { ...builderIdentity, slotId: builderIdentity.slotId! },
        new TaskAgentService(data.taskRepository, builderIdentity, data.taskRepository, data.controlRepository)
      )
      expect(builderAgent.isCoordinator()).toBe(true)
      expect(data.taskRepository.load().tasks[leadTask!.id]).toMatchObject({
        status: 'queued', targetSlotId: data.builder.slot.id, assigneeSessionId: undefined
      })
      const takeoverNotice = Object.values(data.collaborationRepository.loadRun(data.runId).messages)
        .find((message) => message.content.includes('自动指定为临时主控'))!
      expect(takeoverNotice.content).toContain(leadTask!.id)
    } finally {
      data.close()
    }
  })

  it('does not promote or notify another lead while the original lead owns an in-flight execution', () => {
    const data = fixture(false)
    try {
      data.bridge.setChannelProcessing('1', false)
      data.failover.reconcile()
      data.advance(60 * 60_000)
      data.failover.reconcile()

      const team = data.control.getSnapshot()
      expect(team.activeRun?.actingLeadSlotId).toBeUndefined()
      expect(team.members.find((member) => member.slot.id === data.lead.slot.id)?.runtime)
        .toMatchObject({ online: false, status: 'running', connectionPhase: 'processing' })
      expect(Object.values(data.collaborationRepository.loadRun(data.runId).messages)
        .filter((message) => message.content.includes('自动指定为临时主控'))).toHaveLength(0)
    } finally {
      data.close()
    }
  })

  it('does not promote a lead from a passive waiting timeout without confirmed stop evidence', () => {
    const data = fixture(false)
    try {
      data.bridge.setChannelSuspectedOffline('1')
      data.failover.reconcile()
      data.advance(60 * 60_000)
      data.failover.reconcile()
      expect(data.control.getSnapshot().activeRun?.actingLeadSlotId).toBeUndefined()
      expect(Object.values(data.collaborationRepository.loadRun(data.runId).messages)
        .filter((message) => message.content.includes('自动指定为临时主控'))).toHaveLength(0)
    } finally {
      data.close()
    }
  })

  it('does not complete the run when every registered Agent is executing with stale MCP timestamps', () => {
    const data = fixture(false)
    try {
      data.bridge.setChannelProcessing('1', false)
      data.bridge.setChannelProcessing('2', false)
      data.failover.reconcile()
      data.advance(60 * 60_000)
      data.failover.reconcile()
      expect(data.control.getSnapshot().activeRun?.status).toBe('running')
      expect(data.controlRepository.listAgentRegistrations(data.runId)).toHaveLength(2)
    } finally {
      data.close()
    }
  })

  it('completes the one-shot run when every channel is offline and no work is in flight', () => {
    const data = fixture(false)
    try {
      data.bridge.setChannelSuspectedOffline('1')
      data.bridge.setChannelSuspectedOffline('2')
      data.failover.reconcile()
      data.advance(60 * 60_000)
      data.failover.reconcile()
      expect(data.control.getSnapshot().activeRun?.status).toBe('completed')
      expect(data.controlRepository.listAgentRegistrations(data.runId)).toHaveLength(0)
    } finally {
      data.close()
    }
  })

  it('transfers lead slot binding to standby when lead goes offline with standby available', () => {
    const data = fixture(true)
    try {
      data.bridge.setChannelOnline('1', false)
      data.failover.reconcile()

      const team = data.control.getSnapshot()
      const lead = team.members.find((member) => member.role.templateKey === 'lead')!
      expect(lead.binding?.channelId).toBe('3')
      expect(team.activeRun?.actingLeadSlotId).toBeUndefined()

      const newLeadIdentity = data.controlRepository.resolveAgentRuntimeIdentity(
        'alpha:ch-3:generation123',
        data.runId
      )
      expect(newLeadIdentity.slotId).toBe(lead.slot.id)
    } finally {
      data.close()
    }
  })

  it('clears acting lead and restores original lead permissions', () => {
    const data = fixture(true)
    try {
      data.control.transferLead({ targetSlotId: data.builder.slot.id })
      expect(data.control.getSnapshot().activeRun?.actingLeadSlotId).toBe(data.builder.slot.id)

      data.control.clearActingLead()
      expect(data.control.getSnapshot().activeRun?.actingLeadSlotId).toBeUndefined()

      const leadIdentity = data.controlRepository.resolveAgentRuntimeIdentity(
        data.lead.binding!.agentSessionId,
        data.runId
      )
      const leadAgent = new TeamCollaborationAgentService(
        data.collaborationRepository,
        { ...leadIdentity, slotId: leadIdentity.slotId! },
        new TaskAgentService(data.taskRepository, leadIdentity, data.taskRepository, data.controlRepository)
      )
      expect(leadAgent.isCoordinator()).toBe(true)
      const restoredBuilderIdentity = data.controlRepository.resolveAgentRuntimeIdentity(
        data.builder.binding!.agentSessionId,
        data.runId
      )
      expect(restoredBuilderIdentity.capabilities).not.toContain('coordination')
    } finally {
      data.close()
    }
  })
})
