import { randomUUID } from 'node:crypto'
import type { AgentRegistrationBatch } from './agent-authorization'
import type { ComposerBindingMethod } from '../domain/cursor-telemetry'
import type { TeamControlRepository } from './team-control-repository'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { AgentSession } from '../domain/agent-session'
import type { ConversationEntry } from '../domain/conversation-entry'
import {
  buildTeamLaunchHint,
  createConfiguredTeamBundle,
  createDefaultTeamBundle,
  type TeamControlSnapshot,
  type TeamControlState,
  type TeamMemberConfiguration,
  type TeamMemberReadiness,
  type TeamMemberView,
  type TeamRun
} from '../domain/team-control'
import type {
  DesktopSnapshot,
  SendMessageAccepted,
  SendMessageInput
} from '../shared/desktop-api'
import type { CursorComposerTelemetrySource } from '../infrastructure/cursor/cursor-composer-telemetry'
import { verifyAgentRuntime } from './verify-agent-runtime'

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 10_000

export interface TeamControlBridge {
  getSnapshot(): DesktopSnapshot
  sendMessage(input: SendMessageInput): SendMessageAccepted
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void
  beginConversationScope?(input: { runId: string; startedAt: number }): DesktopSnapshot
}

export interface TeamWorkspaceSelection {
  workspaceId: string
  workspaceName: string
  workspacePath: string
  channelIds: string[]
}

interface DeliveryResult {
  status: 'delivered' | 'uncertain' | 'failed'
  detail: string
  commandId?: string
}

type TeamControlListener = (snapshot: TeamControlSnapshot) => void

function activeRunOf(state: TeamControlState) {
  if (!state.activeWorkspaceId) return undefined
  return state.runs
    .filter((run) => run.workspaceId === state.activeWorkspaceId)
    .sort((left, right) => right.createdAt - left.createdAt)[0]
}

function freshTeamRunKey(): string {
  return `run-${randomUUID()}`
}

function isLegacyMainRun(run: TeamRun): boolean {
  return run.id.endsWith(':main')
}

function readinessOf(input: {
  binding: TeamMemberView['binding']
  runtime?: AgentSession
}): TeamMemberReadiness {
  const { binding, runtime } = input
  if (!binding) return 'mcp_missing'
  if (binding.launchStatus === 'failed' || binding.launchStatus === 'uncertain') return 'attention'
  if (!runtime?.online) return 'offline'
  if (binding.launchStatus === 'acknowledged') return 'active'
  if (binding.launchStatus === 'sending' || binding.launchStatus === 'delivered') return 'launching'
  if (!runtime.waiting) return 'not_waiting'
  return 'ready'
}

function commandEntry(snapshot: DesktopSnapshot, channelId: string, commandId: string): ConversationEntry | undefined {
  return snapshot.conversations[channelId]?.find((entry) => entry.commandId === commandId)
}

function sendAndConfirm(
  bridge: TeamControlBridge,
  input: SendMessageInput,
  timeoutMs: number
): Promise<DeliveryResult> {
  return new Promise((resolve) => {
    let commandId = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = (): void => {}

    const finish = (result: DeliveryResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unsubscribe()
      resolve(result)
    }
    const inspect = (snapshot: DesktopSnapshot): void => {
      if (!commandId) return
      const entry = commandEntry(snapshot, input.channelId, commandId)
      if (entry?.status === 'complete') {
        finish({ status: 'delivered', detail: '群枢已确认指令送入 Cursor', commandId })
      }
      if (entry?.status === 'failed') {
        finish({
          status: 'failed',
          detail: entry.error || '通道拒绝了启动指令',
          commandId
        })
      }
    }

    try {
      unsubscribe = bridge.subscribe(inspect)
      commandId = bridge.sendMessage(input).commandId
      inspect(bridge.getSnapshot())
      if (settled) return
      timer = setTimeout(() => {
        finish({
          status: 'uncertain',
          detail: '等待投递回执超时；为避免重复启动，未自动重发',
          commandId
        })
      }, timeoutMs)
    } catch (error) {
      finish({
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
        commandId: commandId || undefined
      })
    }
  })
}

export class TeamControlService {
  private listeners = new Set<TeamControlListener>()
  private lastRevision: number
  private watchTimer?: ReturnType<typeof setInterval>
  private activeLaunch?: Promise<TeamControlSnapshot>
  private readonly unsubscribeBridge: () => void

  constructor(
    private readonly repository: TeamControlRepository,
    private readonly bridge: TeamControlBridge,
    private readonly confirmationTimeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
    private readonly telemetrySource?: CursorComposerTelemetrySource,
    private readonly collaborationLifecycle?: Pick<TeamCollaborationRepository, 'clearRun'>
  ) {
    let state = repository.loadTeamControl()
    state = this.freshenLegacyPrelaunchMainRun(state)
    this.lastRevision = state.revision
    this.clearPrelaunchCollaboration(state)
    this.syncConversationScope(state)
    this.unsubscribeBridge = bridge.subscribe(() => this.emit())
  }

  getSnapshot(): TeamControlSnapshot {
    const state = this.repository.loadTeamControl()
    let runtime = this.bridge.getSnapshot()
    const workspace = state.workspaces.find((candidate) => candidate.id === state.activeWorkspaceId)
    if (workspace && this.telemetrySource) {
      const run = activeRunOf(state)
      const bindings = run ? state.bindings.filter((binding) => binding.runId === run.id) : []
      const telemetry = this.telemetrySource.readWorkspace(workspace.path, bindings)
      runtime = verifyAgentRuntime(runtime, state, telemetry)
    }
    return this.project(state, runtime)
  }

  getActiveRunId(): string | undefined {
    return activeRunOf(this.repository.loadTeamControl())?.id
  }

  getActiveRunStatus(): TeamRun['status'] | undefined {
    return activeRunOf(this.repository.loadTeamControl())?.status
  }

  getActiveTaskScope(): { workspaceId?: string; runId?: string; scopeRevision: number } {
    const state = this.repository.loadTeamControl()
    return {
      workspaceId: state.activeWorkspaceId,
      runId: activeRunOf(state)?.id,
      scopeRevision: state.revision
    }
  }

  subscribe(listener: TeamControlListener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  ensureWorkspace(input: TeamWorkspaceSelection): TeamControlSnapshot {
    const bundle = createDefaultTeamBundle({
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      workspacePath: input.workspacePath,
      channelIds: input.channelIds,
      runKey: freshTeamRunKey()
    })
    this.repository.upsertWorkspaceTeam(bundle)
    this.collaborationLifecycle?.clearRun(bundle.run.id)
    this.syncConversationScope(this.repository.loadTeamControl())
    this.emit()
    return this.getSnapshot()
  }

  configureWorkspace(input: Omit<TeamWorkspaceSelection, 'channelIds'> & {
    members: TeamMemberConfiguration[]
  }): TeamControlSnapshot {
    const bundle = createConfiguredTeamBundle({
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      workspacePath: input.workspacePath,
      members: input.members,
      runKey: freshTeamRunKey()
    })
    this.repository.upsertWorkspaceTeam(bundle)
    this.collaborationLifecycle?.clearRun(bundle.run.id)
    this.syncConversationScope(this.repository.loadTeamControl())
    this.emit()
    return this.getSnapshot()
  }

  createNextRun(): TeamControlSnapshot {
    const state = this.repository.loadTeamControl()
    const previousRun = activeRunOf(state)
    const workspace = state.workspaces.find((candidate) => candidate.id === state.activeWorkspaceId)
    if (!previousRun || !workspace) throw new Error('当前没有可续建的团队工作区')
    if (previousRun.status !== 'completed') throw new Error('只有上一轮全部 Agent 掉线结束后才能创建新团队')

    const previousRoles = state.roles
      .filter((role) => role.runId === previousRun.id)
      .sort((left, right) => left.order - right.order)
    const previousSlots = state.slots
      .filter((slot) => slot.runId === previousRun.id)
      .sort((left, right) => left.order - right.order)
    const roleById = new Map(previousRoles.map((role) => [role.id, role]))
    const previousBindings = state.bindings.filter((binding) => binding.runId === previousRun.id)
    const previousBindingBySlot = new Map(previousBindings.map((binding) => [binding.slotId, binding]))
    const reusableChannelIds = [...new Set(previousSlots.flatMap((slot) => {
      const channelId = slot.channelId ?? previousBindingBySlot.get(slot.id)?.channelId
      return channelId ? [channelId] : []
    }))]
      .sort((left, right) => Number(left) - Number(right) || left.localeCompare(right))
    if (!reusableChannelIds.length) throw new Error('上一轮没有可复用的群枢通道配置')

    const leadSlot = previousSlots.find((slot) => roleById.get(slot.roleId)?.templateKey === 'lead')
    if (!leadSlot) throw new Error('上一轮团队缺少主控角色，无法自动建立新一轮')
    const selectedSlots = [leadSlot, ...previousSlots.filter((slot) => slot.id !== leadSlot.id)]
      .slice(0, Math.min(previousSlots.length, reusableChannelIds.length))
    const usedChannelIds = new Set<string>()
    const members: TeamMemberConfiguration[] = selectedSlots.map((slot) => {
        const role = roleById.get(slot.roleId)
        if (!role) throw new Error('上一轮团队角色数据不完整')
        const preferredChannelId = slot.channelId ?? previousBindingBySlot.get(slot.id)?.channelId
        const channelId = preferredChannelId && !usedChannelIds.has(preferredChannelId)
          ? preferredChannelId
          : reusableChannelIds.find((candidate) => !usedChannelIds.has(candidate))
        if (!channelId) throw new Error('可复用的群枢通道不足')
        usedChannelIds.add(channelId)
        return {
          channelId,
          roleTemplateKey: role.templateKey,
          avatarId: slot.avatarId,
          skills: structuredClone(role.skills)
        }
      })
    const bundle = createConfiguredTeamBundle({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      members,
      runKey: freshTeamRunKey()
    })
    this.repository.upsertWorkspaceTeam(bundle)
    this.collaborationLifecycle?.clearRun(bundle.run.id)
    this.syncConversationScope(this.repository.loadTeamControl())
    this.emit()
    return this.getSnapshot()
  }

  setActiveWorkspace(workspaceId: string): TeamControlSnapshot {
    this.repository.setActiveWorkspace(workspaceId)
    this.syncConversationScope(this.repository.loadTeamControl())
    this.emit()
    return this.getSnapshot()
  }

  updateGoal(goal: string): TeamControlSnapshot {
    const run = activeRunOf(this.repository.loadTeamControl())
    if (!run) throw new Error('请先选择团队工作区')
    this.repository.updateRunGoal(run.id, goal)
    this.emit()
    return this.getSnapshot()
  }

  /**
   * 显式主控转移（P0）：将主控权限临时转移给指定在线成员。
   * 权限：仅当前 lead 或 acting lead 可调用。
   */
  transferLead(input: { targetSlotId: string; reason?: string }): TeamControlSnapshot {
    const snapshot = this.getSnapshot()
    const run = snapshot.activeRun
    if (!run || !['launching', 'running', 'attention'].includes(run.status)) {
      throw new Error('只有运行中的 TeamRun 可以转移主控')
    }
    const currentLead = snapshot.members.find((member) => member.role.templateKey === 'lead')
    const actingLead = run.actingLeadSlotId
      ? snapshot.members.find((member) => member.slot.id === run.actingLeadSlotId)
      : undefined
    const effectiveLead = actingLead ?? currentLead
    if (!effectiveLead?.binding) throw new Error('当前没有有效的主控绑定')
    const target = snapshot.members.find((member) => member.slot.id === input.targetSlotId.trim())
    if (!target) throw new Error('目标 AgentSlot 不属于当前 TeamRun')
    if (!target.binding) throw new Error('目标 Agent 尚未完成 MCP 绑定')
    if (!target.runtime?.online) throw new Error('目标 Agent 当前不在线')
    if (target.slot.id === effectiveLead.slot.id) throw new Error('目标已是当前主控')
    const at = Date.now()
    this.repository.setActingLead({ runId: run.id, slotId: target.slot.id, at })
    this.emit()
    return this.getSnapshot()
  }

  /** 清除临时主控，恢复原始 lead 角色。 */
  clearActingLead(): TeamControlSnapshot {
    const snapshot = this.getSnapshot()
    const run = snapshot.activeRun
    if (!run || !['launching', 'running', 'attention'].includes(run.status)) {
      throw new Error('只有运行中的 TeamRun 可以清除临时主控')
    }
    const at = Date.now()
    this.repository.setActingLead({ runId: run.id, slotId: null, at })
    this.emit()
    return this.getSnapshot()
  }

  recordInstallation(batch: AgentRegistrationBatch): TeamControlSnapshot {
    this.repository.recordInstallation(batch)
    this.emit()
    return this.getSnapshot()
  }

  recordComposerBinding(input: {
    runId: string
    slotId: string
    generation: string
    bindingKey: string
    composerId: string
    method: ComposerBindingMethod
    at?: number
  }): boolean {
    const changed = this.repository.recordComposerBinding({
      ...input,
      at: input.at ?? Date.now()
    })
    if (changed) this.emit()
    return changed
  }

  /**
   * 会话创建路径的状态兜底：投递启动提示前幂等推进 run 到 launching。
   * 仅当 run 仍是 draft/ready 且有目标时生效；不重置 bindings，不影响已在线会话。
   */
  ensureRunLaunched(): void {
    const snapshot = this.getSnapshot()
    const run = snapshot.activeRun
    if (!run || !run.goal.trim()) return
    if (run.status !== 'draft' && run.status !== 'ready') return
    this.collaborationLifecycle?.clearRun(run.id)
    this.repository.ensureRunLaunching(run.id, Date.now())
    this.emit()
  }

  launch(): Promise<TeamControlSnapshot> {
    if (this.activeLaunch) return this.activeLaunch
    const snapshot = this.getSnapshot()
    if (!snapshot.activeRun) throw new Error('请先选择团队工作区')
    if (!snapshot.preflight.canLaunch) {
      throw new Error(snapshot.preflight.blockers[0] || '启动前检查尚未通过')
    }

    const runId = snapshot.activeRun.id
    const at = Date.now()
    if (snapshot.activeRun.status === 'ready') {
      this.collaborationLifecycle?.clearRun(runId, at)
    }
    const bindingKey = randomUUID()
    this.repository.beginLaunch(runId, at, bindingKey)
    this.emit()
    const launchSnapshot = this.getSnapshot()
    this.activeLaunch = Promise.all(launchSnapshot.members.map(async (member) => {
      if (!member.binding) throw new Error(`${member.slot.name} 尚未安装 MCP`)
      this.repository.recordLaunchDelivery({
        runId,
        slotId: member.slot.id,
        status: 'sending',
        detail: '正在向 Cursor 投递角色指令'
      })
      this.emit()
      const result = await sendAndConfirm(
        this.bridge,
        {
          channelId: member.binding.channelId,
          text: buildTeamLaunchHint({ channelId: member.binding.channelId, binding: member.binding })
        },
        this.confirmationTimeoutMs
      )
      this.repository.recordLaunchDelivery({
        runId,
        slotId: member.slot.id,
        ...result
      })
      this.emit()
    }))
      .then(() => this.getSnapshot())
      .finally(() => {
        this.activeLaunch = undefined
      })
    return this.activeLaunch
  }

  startWatcher(intervalMs = 1_000): void {
    this.stopWatcher()
    this.watchTimer = setInterval(() => {
      const revision = this.repository.loadTeamControl().revision
      if (revision !== this.lastRevision) this.emit()
    }, Math.max(250, intervalMs))
    this.watchTimer.unref?.()
  }

  stopWatcher(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = undefined
  }

  dispose(): void {
    this.stopWatcher()
    this.unsubscribeBridge()
    this.listeners.clear()
  }

  private project(state: TeamControlState, bridgeSnapshot: DesktopSnapshot): TeamControlSnapshot {
    const activeRun = activeRunOf(state)
    const roles = activeRun
      ? state.roles.filter((role) => role.runId === activeRun.id).sort((left, right) => left.order - right.order)
      : []
    const slots = activeRun
      ? state.slots.filter((slot) => slot.runId === activeRun.id).sort((left, right) => left.order - right.order)
      : []
    const bindings = activeRun
      ? state.bindings.filter((binding) => binding.runId === activeRun.id)
      : []
    const roleById = new Map(roles.map((role) => [role.id, role]))
    const bindingBySlot = new Map(bindings.map((binding) => [binding.slotId, binding]))
    const bindingByChannel = new Map(bindings.map((binding) => [binding.channelId, binding]))
    const runtimeByChannel = new Map(bridgeSnapshot.sessions.map((session) => [session.channelId, session]))
    const registrations = activeRun ? this.repository.listAgentRegistrations(activeRun.id) : []
    const registrationByChannel = new Map(registrations.map((registration) => [registration.channelId, registration]))
    const runtimeChannelIds = new Set([
      ...bridgeSnapshot.sessions.map((session) => session.channelId),
      ...slots.flatMap((slot) => slot.channelId ? [slot.channelId] : []),
      ...bindings.map((binding) => binding.channelId),
      ...registrations.map((registration) => registration.channelId)
    ])
    const runtimeChannels = [...runtimeChannelIds]
      .sort((left, right) => Number(left) - Number(right) || left.localeCompare(right))
      .map((channelId) => {
        const runtime = runtimeByChannel.get(channelId)
        const registration = registrationByChannel.get(channelId)
        const binding = bindingByChannel.get(channelId)
        return {
          channelId,
          displayName: runtime?.displayName ?? `Qunshu CH-${channelId}`,
          status: runtime?.status ?? 'offline' as const,
          online: runtime?.online ?? false,
          waiting: runtime?.waiting ?? false,
          queueDepth: runtime?.queueDepth ?? 0,
          registered: Boolean(registration),
          assignedSlotId: binding?.slotId,
          agentSessionId: registration?.agentSessionId,
          generation: registration?.generation
        }
      })
    const standbyChannels = runtimeChannels.filter((channel) => channel.registered && !channel.assignedSlotId)
    const failovers = activeRun ? this.repository.listFailovers(activeRun.id) : []
    const members: TeamMemberView[] = slots.flatMap((slot) => {
      const role = roleById.get(slot.roleId)
      if (!role) return []
      const binding = bindingBySlot.get(slot.id)
      const runtimeChannelId = binding?.channelId ?? slot.channelId
      const runtime = runtimeChannelId ? runtimeByChannel.get(runtimeChannelId) : undefined
      const readiness = slot.channelId
        ? readinessOf({ binding, runtime })
        : 'unbound'
      return [{
        slot,
        role,
        binding,
        runtime: runtime ? {
          channelId: runtime.channelId,
          status: runtime.status,
          online: runtime.online,
          waiting: runtime.waiting,
          queueDepth: runtime.queueDepth,
          lastSeenAt: runtime.lastSeenAt,
          healthEvidence: [...runtime.healthEvidence],
          workingFiles: [...runtime.workingFiles]
        } : undefined,
        readiness
      }]
    })

    const bridgeConnected = bridgeSnapshot.connection.state === 'connected'
    const workspaceBound = Boolean(state.activeWorkspaceId && activeRun)
    const goalDefined = Boolean(activeRun?.goal.trim())
    const activeMembersInstalled = members.length > 0 && members.every((member) =>
      Boolean(member.binding && member.slot.channelId === member.binding.channelId)
    )
    const activeMemberChannelsRegistered = members.length > 0 && members.every((member) =>
      Boolean(member.slot.channelId && registrationByChannel.has(member.slot.channelId))
    )
    const mcpInstalled = activeMembersInstalled && activeMemberChannelsRegistered
    const agentsWaiting = members.length > 0 && members.every((member) =>
      member.runtime?.online && member.runtime.waiting
    )
    const blockers: string[] = []
    if (!bridgeConnected) blockers.push('群枢本地通道尚未就绪')
    if (!workspaceBound) blockers.push('尚未绑定 Cursor 工作区')
    if (activeRun && !goalDefined) blockers.push('请先填写并保存团队目标')
    if (workspaceBound && !mcpInstalled) blockers.push('Agent MCP 尚未接入全部本轮通道')
    if (mcpInstalled && !agentsWaiting && activeRun && !['running', 'completed'].includes(activeRun.status)) {
      blockers.push('并非所有 Agent 通道都已在线待命')
    }
    if (activeRun?.status === 'launching') blockers.push('团队启动指令正在投递')
    if (activeRun?.status === 'running' && agentsWaiting) blockers.push('团队已经运行')
    if (activeRun?.status === 'paused') blockers.push('团队已暂停，当前版本尚未开放恢复')
    if (activeRun?.status === 'completed') blockers.push('本次团队运行已经完成')

    return {
      ...state,
      roles,
      slots,
      bindings,
      activeRun,
      members,
      runtimeChannels,
      standbyChannels,
      failovers,
      preflight: {
        bridgeConnected,
        workspaceBound,
        goalDefined,
        mcpInstalled,
        agentsWaiting,
        canLaunch: blockers.length === 0,
        blockers
      }
    }
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    this.lastRevision = snapshot.revision
    for (const listener of this.listeners) listener(snapshot)
  }

  private syncConversationScope(state: TeamControlState): void {
    const run = activeRunOf(state)
    if (run) this.bridge.beginConversationScope?.({ runId: run.id, startedAt: run.createdAt })
  }

  private clearPrelaunchCollaboration(state: TeamControlState): void {
    const run = activeRunOf(state)
    if (run && (run.status === 'draft' || run.status === 'ready')) {
      this.collaborationLifecycle?.clearRun(run.id)
    }
  }

  /**
   * 老版本预启动团队会复用 team-run:<workspace>:main。只在 draft/ready 且无
   * runtime bindings 的阶段一次性迁到 fresh run；已绑定或已运行的旧 run 不能在
   * 群枢重启时自动换身份，否则会影响 Cursor 中仍然活着的会话。
   */
  private freshenLegacyPrelaunchMainRun(state: TeamControlState): TeamControlState {
    const run = activeRunOf(state)
    if (!run || !isLegacyMainRun(run) || (run.status !== 'draft' && run.status !== 'ready')) return state
    if (state.bindings.some((binding) => binding.runId === run.id)) return state
    const workspace = state.workspaces.find((candidate) => candidate.id === run.workspaceId)
    if (!workspace) return state
    const roles = state.roles
      .filter((role) => role.runId === run.id)
      .sort((left, right) => left.order - right.order)
    const slots = state.slots
      .filter((slot) => slot.runId === run.id)
      .sort((left, right) => left.order - right.order)
    const roleById = new Map(roles.map((role) => [role.id, role]))
    const members = slots.flatMap((slot) => {
      const role = roleById.get(slot.roleId)
      if (!role?.templateKey || !slot.channelId) return []
      return [{
        channelId: slot.channelId,
        roleTemplateKey: role.templateKey,
        avatarId: slot.avatarId,
        skills: structuredClone(role.skills)
      } satisfies TeamMemberConfiguration]
    })
    if (members.length !== slots.length) return state
    const bundle = createConfiguredTeamBundle({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      members,
      runKey: freshTeamRunKey()
    })
    bundle.run.goal = run.goal
    bundle.run.status = 'draft'
    this.repository.upsertWorkspaceTeam(bundle)
    return this.repository.loadTeamControl()
  }
}
