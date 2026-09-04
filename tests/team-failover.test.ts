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
import type { CursorComposerTelemetrySource } from '../src/infrastructure/cursor/cursor-composer-telemetry'
import type { RuntimeBinding } from '../src/domain/team-control'
import type { DesktopSnapshot, SendMessageInput } from '../src/shared/desktop-api'

/** 按生产路径（recordComposerBinding）给指定通道补齐 composer 绑定。 */
function bindComposer(control: TeamControlService, runId: string, channelId: string, composerId: string): void {
  const binding = control.getSnapshot().bindings.find((candidate) => candidate.channelId === channelId)
  if (!binding) throw new Error(`CH-${channelId} 没有运行时绑定`)
  const changed = control.recordComposerBinding({
    runId,
    slotId: binding.slotId,
    generation: binding.generation,
    bindingKey: binding.composerBindingKey,
    composerId,
    method: 'channel_marker'
  })
  if (!changed) throw new Error(`CH-${channelId} composer 绑定被拒绝`)
}

/** 遥测帧按绑定生成 composers，可指定“该帧暂缺”的通道（模拟 Cursor 水合/索引延迟）。 */
function telemetryOmitting(omittedChannelIds: string[]): CursorComposerTelemetrySource {
  return {
    readWorkspace(_workspacePath: string, bindings: RuntimeBinding[]) {
      return {
        availability: 'available' as const,
        workspacePath: '/workspace/alpha',
        composers: bindings
          .filter((binding) => binding.composerId && !omittedChannelIds.includes(binding.channelId))
          .map((binding) => ({
            composerId: binding.composerId!,
            title: `CH-${binding.channelId} 会话`,
            activity: { state: 'active' as const, channelId: binding.channelId, detail: '转录活动新鲜' }
          })),
        bindingCandidates: [],
        updatedAt: 100
      }
    }
  }
}

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

  /** Cursor 明确终止 + 已投递待回复（守门开放）：presence 事实的组合形态。 */
  setChannelOwedReply(channelId: string, pendingSince: number): void {
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) => session.channelId === channelId
        ? {
            ...session,
            status: 'offline',
            online: false,
            connected: false,
            runtimeEvidence: 'stopped',
            waiting: false,
            connectionPhase: 'cursor_stopped',
            pendingOutboundId: `outbound-${channelId}`,
            pendingReplySyncSince: pendingSince,
            lastSeenAt: 1,
            healthEvidence: ['Cursor Agent 已停止监听，回复仍在途']
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

function fixture(
  withStandby: boolean,
  withSolo = false,
  telemetrySource?: CursorComposerTelemetrySource
) {
  const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-failover-')), 'team.sqlite3')
  const controlRepository = new SqliteTeamControlRepository(path)
  const taskRepository = new SqliteTaskPoolRepository(path)
  const collaborationRepository = new SqliteTeamCollaborationRepository(path)
  const continuityRepository = new SqliteTeamContinuityRepository(path)
  const memoryRepository = new SqliteTeamMemoryRepository(path)
  const standbyChannelId = withSolo ? '4' : '3'
  const memberChannelIds = withSolo ? ['1', '2', '3'] : ['1', '2']
  const bridge = new MutableBridge(desktopSnapshot(withStandby ? [...memberChannelIds, standbyChannelId] : memberChannelIds))
  const control = new TeamControlService(controlRepository, bridge, undefined, telemetrySource)
  const selected = withSolo
    ? control.configureWorkspace({
        workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha',
        members: [
          { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] },
          { channelId: '3', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }
        ]
      })
    : control.ensureWorkspace({
        workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha', channelIds: ['1', '2']
      })
  const runId = selected.activeRun!.id
  control.updateGoal('完成本轮接口重构')
  const memberByChannel = new Map(selected.members.map((member) => [member.slot.channelId!, member]))
  control.recordInstallation({
    workspaceId: 'alpha',
    runId,
    generation: 'generation123',
    agents: (withStandby ? [...memberChannelIds, standbyChannelId] : memberChannelIds).map((channelId) => {
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
  for (const member of control.getSnapshot().members.filter((candidate) => candidate.slot.solo !== true)) {
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
  it('does not create failover records when a solo seat goes offline', () => {
    const data = fixture(false, true)
    try {
      data.bridge.setChannelOnline('3', false)
      data.failover.reconcile()
      data.advance(60 * 60_000)
      data.failover.reconcile()
      expect(data.controlRepository.listFailovers(data.runId)).toEqual([])
      expect(data.control.getSnapshot().activeRun?.status).toBe('running')
    } finally {
      data.close()
    }
  })

  it('does not let an online solo seat keep a fully offline team run alive', () => {
    const data = fixture(false, true)
    try {
      data.bridge.setChannelOnline('1', false)
      data.bridge.setChannelOnline('2', false)
      // CH-3 solo remains online; team lifecycle must still complete.
      data.failover.reconcile()
      expect(data.control.getSnapshot().activeRun?.status).toBe('completed')
    } finally {
      data.close()
    }
  })

  it('never promotes an online solo seat when the lead fails', () => {
    const data = fixture(false, true)
    try {
      data.bridge.setChannelOnline('1', false)
      data.failover.reconcile()
      expect(data.control.getSnapshot().activeRun?.actingLeadSlotId).toBe(data.builder.slot.id)
      expect(data.control.getSnapshot().members.find((member) => member.slot.solo)?.slot.id)
        .not.toBe(data.control.getSnapshot().activeRun?.actingLeadSlotId)
    } finally {
      data.close()
    }
  })

  it('does not offer solo seats as manual handoff candidates', () => {
    const data = fixture(false, true)
    try {
      data.bridge.setChannelOnline('2', false)
      const options = data.failover.manualHandoffOptions(data.builder.slot.id)
      const solo = data.control.getSnapshot().members.find((member) => member.slot.solo)!
      expect(options.candidates.some((candidate) => candidate.slotId === solo.slot.id)).toBe(false)
      expect(() => data.failover.manualHandoffOptions(solo.slot.id)).toThrowError(/独立席位不参与团队交接/)
    } finally {
      data.close()
    }
  })

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
      const before = data.builder.binding!
      expect(before.sessionToken).toMatch(/^[a-zA-Z0-9_-]{8,128}$/)
      data.controlRepository.rebindSlotToStandby({
        failoverId,
        runId: data.runId,
        slotId: data.builder.slot.id,
        expectedAgentSessionId: before.agentSessionId,
        replacementAgentSessionId: 'alpha:ch-3:generation123',
        reason: '模拟换绑后进程退出',
        detectedAt: 1_000,
        bindingKey: 'takeover-binding-123'
      })
      // 会话围栏：备用会话早已在线、未持有本席令牌 → 令牌清空（按无令牌旧会话放行）；
      // 原失联 Agent 若复活并出示旧令牌，按 token_mismatch 被围栏拒绝。
      const rebound = data.controlRepository.loadTeamControl().bindings
        .find((binding) => binding.runId === data.runId && binding.slotId === data.builder.slot.id)!
      expect(rebound.agentSessionId).toBe('alpha:ch-3:generation123')
      expect(rebound.sessionToken).toBeUndefined()
      expect(data.controlRepository.resolveChannelSessionOwner(rebound.channelId))
        .toMatchObject({ runId: data.runId, bound: true, sessionToken: undefined })

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

  it('keeps the run alive while agents hold in-flight replies the telemetry frame omits (2026-09-01 incident)', () => {
    // 事故形态：两个通道刚取走消息（processing + 心跳新鲜），遥测帧因 Cursor
    // 水合/索引延迟未列出绑定 Composer——旧投影把证据缺失当成明确停止并抹掉
    // processing 相位，run 在取走消息 0.6s 后即被 all-offline 收尾。
    const data = fixture(false, false, telemetryOmitting(['1', '2']))
    try {
      bindComposer(data.control, data.runId, '1', 'composer-ch-1-alpha')
      bindComposer(data.control, data.runId, '2', 'composer-ch-2-beta')
      data.bridge.setChannelProcessing('1', true)
      data.bridge.setChannelProcessing('2', true)

      data.failover.reconcile()
      data.advance(60_000)
      data.failover.reconcile()

      const team = data.control.getSnapshot()
      expect(team.activeRun?.status).toBe('running')
      expect(data.controlRepository.listAgentRegistrations(data.runId)).toHaveLength(2)
      // processing 执行租约证据穿透投影保留（failover 的事实源未被删除）
      for (const member of team.members) {
        expect(member.runtime).toMatchObject({ online: true, connectionPhase: 'processing' })
      }
    } finally {
      data.close()
    }
  })

  it('treats a telemetry frame omitting the bound composer as unverified, never as confirmed death', () => {
    // 长任务中段：心跳过期（online=false）+ 遥测帧缺 Composer。旧代码将其判为
    // stopped（confirmed），15s 后把席位错误交给 standby；正确语义是证据待确认，
    // processing 租约继续保护席位不被接管。
    const data = fixture(true, false, telemetryOmitting(['1']))
    try {
      bindComposer(data.control, data.runId, '1', 'composer-ch-1-alpha')
      bindComposer(data.control, data.runId, '2', 'composer-ch-2-beta')
      data.bridge.setChannelProcessing('1', false)

      data.failover.reconcile()
      data.advance(60_000)
      data.failover.reconcile()

      const team = data.control.getSnapshot()
      expect(team.activeRun?.actingLeadSlotId).toBeUndefined()
      expect(data.controlRepository.listFailovers(data.runId)).toEqual([])
      expect(team.activeRun?.status).toBe('running')
      const lead = team.members.find((member) => member.role.templateKey === 'lead')!
      expect(lead.runtime).toMatchObject({
        online: false,
        runtimeEvidence: 'suspected',
        connectionPhase: 'processing'
      })
    } finally {
      data.close()
    }
  })

  it('does not mark a single telemetry-missing seat offline while its MCP heartbeat stays fresh', () => {
    // 多通道中仅一席暂缺遥测：该席保持在线（未验证），不得触发全团队收尾。
    const data = fixture(false, false, telemetryOmitting(['1']))
    try {
      bindComposer(data.control, data.runId, '1', 'composer-ch-1-alpha')
      bindComposer(data.control, data.runId, '2', 'composer-ch-2-beta')

      data.failover.reconcile()
      data.advance(60_000)
      data.failover.reconcile()

      const team = data.control.getSnapshot()
      expect(team.activeRun?.status).toBe('running')
      const lead = team.members.find((member) => member.role.templateKey === 'lead')!
      expect(lead.runtime).toMatchObject({ online: true })
      expect(lead.runtime?.runtimeEvidence).not.toBe('stopped')
      expect(lead.runtime?.status).not.toBe('offline')
    } finally {
      data.close()
    }
  })

  it('blocks all-offline completion while a delivered message still awaits its reply, then releases after the sync window', () => {
    // 全员明确停止（cursor_stopped）但 CH-1 欠一条已投递消息的 record_reply：
    // 回复契约开放期内不进入 all-offline 完成计时；超过回复同步宽限
    // （CHANNEL_REPLY_SYNC_STALE_MS）仍未回复则放行收尾，防止僵尸 run。
    const data = fixture(false)
    try {
      data.bridge.setChannelOwedReply('1', 1_000)
      data.bridge.setChannelOnline('2', false)

      data.failover.reconcile()
      data.advance(60_000)
      data.failover.reconcile()
      expect(data.control.getSnapshot().activeRun?.status).toBe('running')

      // 宽限窗口内：契约仍受保护
      data.advance(229_000)
      data.failover.reconcile()
      expect(data.control.getSnapshot().activeRun?.status).toBe('running')

      // 超过 CHANNEL_REPLY_SYNC_STALE_MS：守门视为已放弃，允许收尾
      data.advance(2_000)
      data.failover.reconcile()
      expect(data.control.getSnapshot().activeRun?.status).toBe('completed')
    } finally {
      data.close()
    }
  })
})
