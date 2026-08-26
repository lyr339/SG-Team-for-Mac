import type { TeamControlRepository } from './team-control-repository'
import type { TeamControlSnapshot, TeamRuntimeChannelView } from '../domain/team-control'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { TeamContinuityService } from './team-continuity-service'
import type { TaskPoolService } from './task-pool-service'
import { TeamHandoffService } from './team-handoff-service'
import type { ManualTeamHandoffInput, ManualTeamHandoffResult, TeamHandoffOptions } from '../domain/team-handoff'

const DEFAULT_OFFLINE_GRACE_MS = 15_000
const DEFAULT_ALL_OFFLINE_GRACE_MS = 20_000
const DEFAULT_RECONCILE_INTERVAL_MS = 1_000

interface TeamSource {
  getSnapshot(): TeamControlSnapshot
  subscribe(listener: (snapshot: TeamControlSnapshot) => void): () => void
}

export interface TeamFailoverServiceOptions {
  now?: () => number
  offlineGraceMs?: number
  allOfflineGraceMs?: number
  reconcileIntervalMs?: number
  onerror?: (error: unknown) => void
}

export class TeamFailoverService {
  private readonly suspectedSince = new Map<string, number>()
  private readonly unrecoverableBindings = new Set<string>()
  private readonly now: () => number
  private readonly offlineGraceMs: number
  private readonly allOfflineGraceMs: number
  private readonly reconcileIntervalMs: number
  private readonly onerror: (error: unknown) => void
  private unsubscribe?: () => void
  private timer?: ReturnType<typeof setInterval>
  private reconciling = false
  private allOfflineSince?: number
  private readonly closedRuns = new Set<string>()
  private readonly handoffs: TeamHandoffService

  constructor(
    private readonly repository: TeamControlRepository,
    private readonly team: TeamSource,
    private readonly tasks: TaskPoolService,
    private readonly collaboration: TeamCollaborationRepository,
    private readonly continuity: TeamContinuityService,
    options: TeamFailoverServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.offlineGraceMs = Math.max(0, options.offlineGraceMs ?? DEFAULT_OFFLINE_GRACE_MS)
    this.allOfflineGraceMs = Math.max(0, options.allOfflineGraceMs ?? DEFAULT_ALL_OFFLINE_GRACE_MS)
    this.reconcileIntervalMs = Math.max(250, options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS)
    this.onerror = options.onerror ?? (() => undefined)
    this.handoffs = new TeamHandoffService(
      repository,
      team,
      tasks,
      collaboration,
      continuity,
      this.now
    )
  }

  manualHandoffOptions(slotId: string): TeamHandoffOptions {
    return this.handoffs.options(slotId)
  }

  manualHandoff(input: ManualTeamHandoffInput): ManualTeamHandoffResult {
    const result = this.handoffs.manual(input)
    this.unrecoverableBindings.delete(result.failover.fromAgentSessionId)
    this.suspectedSince.delete(input.sourceSlotId)
    return result
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.team.subscribe(() => this.reconcile())
    this.timer = setInterval(() => this.reconcile(), this.reconcileIntervalMs)
    this.timer.unref?.()
    this.reconcile()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.suspectedSince.clear()
    this.allOfflineSince = undefined
    this.closedRuns.clear()
  }

  reconcile(): void {
    if (this.reconciling) return
    this.reconciling = true
    try {
      const snapshot = this.team.getSnapshot()
      const run = snapshot.activeRun
      if (run?.status === 'completed') {
        this.closeRunTasks(run.id)
        this.resetTransientState()
        return
      }
      if (!run || !['launching', 'running', 'attention'].includes(run.status)) {
        this.resetTransientState()
        return
      }
      this.reconcileAcknowledgements(snapshot)
      this.recoverIncompleteFailover(snapshot)
      this.reconcileLeadFailover(snapshot)
      if (!snapshot.preflight.bridgeConnected) return

      const liveRegisteredChannels = snapshot.runtimeChannels.filter((channel) => channel.registered && channel.online)
      if (liveRegisteredChannels.length === 0) {
        const at = this.now()
        this.allOfflineSince ??= at
        if (at - this.allOfflineSince >= this.allOfflineGraceMs) {
          this.repository.completeRun(run.id, at)
          this.closeRunTasks(run.id)
          this.resetTransientState()
        }
        return
      }
      this.allOfflineSince = undefined
      if (run.status === 'launching') return
      if (this.selectStandby(snapshot.standbyChannels)) {
        for (const member of snapshot.members) {
          if (!member.runtime?.online && member.binding) {
            this.unrecoverableBindings.delete(member.binding.agentSessionId)
          }
        }
      }

      const now = this.now()
      const activeFailoverSlots = new Set(snapshot.failovers
        .filter((record) => record.status === 'waiting_for_agent')
        .map((record) => record.slotId))
      for (const member of snapshot.members) {
        if (!member.binding) continue
        if (member.runtime?.online) {
          this.suspectedSince.delete(member.slot.id)
          this.unrecoverableBindings.delete(member.binding.agentSessionId)
          continue
        }
        if (this.unrecoverableBindings.has(member.binding.agentSessionId)) continue
        const suspectedAt = this.suspectedSince.get(member.slot.id) ?? now
        this.suspectedSince.set(member.slot.id, suspectedAt)
        if (now - suspectedAt < this.offlineGraceMs) continue
        if (activeFailoverSlots.has(member.slot.id)) continue
        const standby = this.selectStandby(snapshot.standbyChannels)
        if (!standby) {
          this.unrecoverableBindings.add(member.binding.agentSessionId)
          this.suspectedSince.delete(member.slot.id)
          continue
        }
        this.handoffs.automatic(member, standby, now)
        this.suspectedSince.delete(member.slot.id)
        // Re-read the snapshot before assigning another failed slot so the same
        // standby runtime can never be selected twice in one reconciliation.
        break
      }
    } catch (error) {
      this.onerror(error)
    } finally {
      this.reconciling = false
    }
  }

  /**
   * 自动 lead 故障转移（P1）：检测 lead 离线并自动选择最资深在线成员接管。
   * 策略：优先选择 standby 通道，其次选择其他在线成员（按 channelId 排序）。
   */
  private reconcileLeadFailover(snapshot: TeamControlSnapshot): void {
    const run = snapshot.activeRun
    if (!run || run.status !== 'running') return
    const lead = snapshot.members.find((member) => member.role.templateKey === 'lead')
    if (!lead?.binding) return
    const actingLeadSlotId = run.actingLeadSlotId
    const effectiveLeadSlotId = actingLeadSlotId ?? lead.slot.id
    const effectiveLead = snapshot.members.find((member) => member.slot.id === effectiveLeadSlotId)
    if (!effectiveLead?.binding) return
    if (effectiveLead.runtime?.online) {
      this.suspectedSince.delete(effectiveLead.slot.id)
      return
    }
    const now = this.now()
    const suspectedAt = this.suspectedSince.get(effectiveLead.slot.id) ?? now
    this.suspectedSince.set(effectiveLead.slot.id, suspectedAt)
    if (now - suspectedAt < this.offlineGraceMs) return
    const standby = this.selectStandby(snapshot.standbyChannels)
    if (standby?.agentSessionId) {
      // standby 接管：slot 绑定直接转移，无需 actingLead
      this.handoffs.automatic(effectiveLead, standby, now)
      this.suspectedSince.delete(effectiveLead.slot.id)
      return
    }
    const onlineMembers = snapshot.members
      .filter((member) => member.slot.id !== effectiveLead.slot.id && member.binding && member.runtime?.online)
      .sort((left, right) => Number(left.binding!.channelId) - Number(right.binding!.channelId))
    const successor = onlineMembers[0]
    if (successor?.binding) {
      // 成员接管：设置 actingLead，保留原 slot 绑定
      this.repository.setActingLead({ runId: run.id, slotId: successor.slot.id, at: now })
      this.collaboration.createMessage({
        runId: run.id,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: successor.slot.id },
        kind: 'notice',
        subject: '自动接管主控权限',
        content: `【系统自动】主控 ${effectiveLead.role.name} 已离线超过宽限期，您已被自动指定为临时主控。请立即调用 team_check_in 确认，并使用 team_transfer_lead 或 team_clear_acting_lead 管理主控权限。`,
        clientMessageId: `auto-lead-failover:${run.id}:${now}`
      })
      this.suspectedSince.delete(effectiveLead.slot.id)
    }
  }

  private selectStandby(channels: TeamRuntimeChannelView[]): TeamRuntimeChannelView | undefined {
    return channels
      .filter((channel) => channel.online && channel.waiting && channel.queueDepth === 0 && channel.agentSessionId)
      .sort((left, right) => Number(left.channelId) - Number(right.channelId) || left.channelId.localeCompare(right.channelId))[0]
  }

  private reconcileAcknowledgements(snapshot: TeamControlSnapshot): void {
    const collaboration = snapshot.activeRun
      ? this.collaboration.loadRun(snapshot.activeRun.id)
      : undefined
    if (!collaboration) return
    for (const record of snapshot.failovers) {
      if (record.status !== 'waiting_for_agent' || !record.messageId) continue
      const message = collaboration.messages[record.messageId]
      if (!message) continue
      if (message.receipt.respondedAt !== undefined) {
        this.repository.updateFailoverStatus({
          failoverId: record.id,
          status: 'completed',
          at: message.receipt.respondedAt
        })
      } else if (message.receipt.notificationState === 'failed') {
        this.repository.updateFailoverStatus({
          failoverId: record.id,
          status: 'failed',
          reason: message.receipt.notificationDetail,
          at: message.receipt.updatedAt
        })
      }
    }
  }

  private recoverIncompleteFailover(snapshot: TeamControlSnapshot): void {
    const record = snapshot.failovers.find((candidate) => (
      candidate.status === 'waiting_for_agent'
      && !candidate.messageId
      && candidate.toAgentSessionId
      && candidate.toChannelId
    ))
    if (!record?.toAgentSessionId || !record.toChannelId) return
    const member = snapshot.members.find((candidate) => candidate.slot.id === record.slotId)
    const bindingKey = member?.binding?.composerBindingKey
    if (!member || !bindingKey) return
    try {
      const capsule = this.continuity.createTakeoverCapsule({
        slotId: record.slotId,
        failoverId: record.id,
        previousAgentSessionId: record.fromAgentSessionId,
        replacementChannelId: record.toChannelId,
        bindingKey,
        checkpointId: record.checkpointId,
        mode: record.id.startsWith('team-handoff:manual:') ? 'manual' : 'automatic'
      })
      const transferredTaskIds = this.tasks.transferAgentWork({
        fromAgentSessionId: record.fromAgentSessionId,
        toAgentSessionId: record.toAgentSessionId,
        slotId: record.slotId
      })
      const message = this.collaboration.createMessage({
        runId: record.runId,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: record.slotId },
        kind: 'notice',
        subject: `自动接替：${record.roleName}`,
        content: capsule.content,
        clientMessageId: record.id
      })
      this.repository.attachFailoverContext({
        failoverId: record.id,
        checkpointId: capsule.checkpointId,
        messageId: message.id,
        taskIds: [...new Set([...capsule.taskIds, ...transferredTaskIds])],
        at: this.now()
      })
    } catch (error) {
      this.repository.updateFailoverStatus({
        failoverId: record.id,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        at: this.now()
      })
      this.onerror(error)
    }
  }

  private resetTransientState(): void {
    this.suspectedSince.clear()
    this.unrecoverableBindings.clear()
    this.allOfflineSince = undefined
  }

  private closeRunTasks(runId: string): void {
    if (this.closedRuns.has(runId)) return
    this.tasks.closeRun(runId, '本轮全部 Agent 已离线，未完成任务自动取消')
    this.closedRuns.add(runId)
  }
}
