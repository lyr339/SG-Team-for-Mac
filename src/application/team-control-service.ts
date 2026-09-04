import { randomUUID } from 'node:crypto'
import type { AgentRegistrationBatch } from './agent-authorization'
import type { ComposerBindingMethod } from '../domain/cursor-telemetry'
import type { TeamControlRepository } from './team-control-repository'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { AgentSession } from '../domain/agent-session'
import type { AgentLaunchPlan } from '../domain/agent-launch'
import type { CursorModelSelection } from '../domain/cursor-model'
import { hasInFlightExecution, isAgentOnDuty } from '../domain/channel-message'
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
  type TeamRun,
  type WorkspaceTeamBundle
} from '../domain/team-control'
import type {
  DesktopSnapshot,
  SendMessageAccepted,
  SendMessageInput
} from '../shared/desktop-api'
import type { CursorComposerTelemetrySource } from '../infrastructure/cursor/cursor-composer-telemetry'
import { verifyAgentRuntime } from './verify-agent-runtime'

/** 逐会话模型选定的形状校验：只信结构，目录可用性由渲染层弹层选项保证。 */
function sanitizeModelSelection(value: unknown): CursorModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型配置无效')
  const candidate = value as Partial<CursorModelSelection>
  const modelId = typeof candidate.modelId === 'string' ? candidate.modelId.trim() : ''
  if (!modelId || modelId.length > 160) throw new Error('modelId 无效')
  const displayName = typeof candidate.displayName === 'string' && candidate.displayName.trim()
    ? candidate.displayName.trim().slice(0, 160)
    : modelId
  const parameters = Array.isArray(candidate.parameters)
    ? candidate.parameters.slice(0, 16).flatMap((parameter) => {
      if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) return []
      const { id, value: parameterValue } = parameter as { id?: unknown; value?: unknown }
      return typeof id === 'string' && id.trim() && typeof parameterValue === 'string' && parameterValue.trim()
        ? [{ id: id.trim().slice(0, 80), value: parameterValue.trim().slice(0, 160) }]
        : []
    })
    : []
  return { modelId, displayName, parameters, maxMode: candidate.maxMode === true }
}

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 10_000
const STALE_LAUNCH_TIMEOUT_MS = 5 * 60_000

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
  // 就绪判定与大厅/launcher 同源：online 之上认协议内相位（含 processing/keepalive），
  // 裸 waiting 会在 Agent 处理消息期间把就绪成员误标 not_waiting。
  if (!isAgentOnDuty(runtime)) return 'not_waiting'
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
        finish({ status: 'delivered', detail: '拾光已确认指令送入 Cursor', commandId })
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
  private cachedState?: TeamControlState
  /** Date.now() can repeat within one millisecond; activeRun ordering requires a strict clock. */
  private lastRunCreatedAt = 0
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
    this.lastRunCreatedAt = Math.max(0, ...state.runs.map((run) => run.createdAt))
    state = this.freshenLegacyPrelaunchMainRun(state)
    state = this.recoverStaleLaunch(state)
    this.cachedState = state
    this.lastRevision = state.revision
    this.clearPrelaunchCollaboration(state)
    this.syncConversationScope(state)
    this.unsubscribeBridge = bridge.subscribe(() => this.emit())
  }

  /**
   * 团队结构只在 revision 变化时重载。旧实现每次 getSnapshot 都执行十余条
   * SQLite 查询并重新装配全部角色/席位/绑定；多个 250–1000ms watcher 叠加后
   * 让主进程长期占用一个 CPU 核心。外部 MCP 写入仍由轻量 revision 查询发现。
   */
  private loadState(): TeamControlState {
    const revision = this.repository.revision?.()
    if (this.cachedState && revision !== undefined && revision === this.cachedState.revision) {
      return this.cachedState
    }
    const state = this.repository.loadTeamControl()
    this.cachedState = state
    return state
  }

  private nextRunCreatedAt(): number {
    const at = Math.max(Date.now(), this.lastRunCreatedAt + 1)
    this.lastRunCreatedAt = at
    return at
  }

  getSnapshot(): TeamControlSnapshot {
    const state = this.loadState()
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
    return activeRunOf(this.loadState())?.id
  }

  getActiveRunStatus(): TeamRun['status'] | undefined {
    return activeRunOf(this.loadState())?.status
  }

  getActiveTaskScope(): { workspaceId?: string; runId?: string; scopeRevision: number } {
    const state = this.loadState()
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
      runKey: freshTeamRunKey(),
      now: this.nextRunCreatedAt()
    })
    this.repository.upsertWorkspaceTeam(bundle)
    this.collaborationLifecycle?.clearRun(bundle.run.id)
    this.syncConversationScope(this.loadState())
    this.emit()
    return this.getSnapshot()
  }

  /**
   * 组建团队 run（可能替换当前独立 run / 旧团队 run）。
   *
   * 模式切换不再以「旧会话全部离线」为前提：会话围栏（session 令牌）让被替换的
   * 旧会话在下一次轮询就收到终止指令自行退出，且不能刷新新席位的 presence；
   * 作用域切换同时把全部通道的既有心跳退役。唯一硬阻塞是正在进行的团队启动
   * 投递（单飞）。后果（旧会话结束、排队消息归档）由渲染层在切换前向用户确认。
   */
  configureWorkspace(input: Omit<TeamWorkspaceSelection, 'channelIds'> & {
    members: TeamMemberConfiguration[]
  }): TeamControlSnapshot {
    this.assertNoLaunchInFlight()
    const bundle = createConfiguredTeamBundle({
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      workspacePath: input.workspacePath,
      members: input.members,
      runKey: freshTeamRunKey(),
      now: this.nextRunCreatedAt()
    })
    return this.replaceActiveRun(bundle)
  }

  /** 创建独立批次 run（可能替换当前团队 run / 旧独立批次）；守卫语义同 configureWorkspace。 */
  configureIndependentWorkspace(input: Omit<TeamWorkspaceSelection, 'channelIds'> & {
    members: TeamMemberConfiguration[]
  }): TeamControlSnapshot {
    this.assertNoLaunchInFlight()
    const bundle = createConfiguredTeamBundle({
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      workspacePath: input.workspacePath,
      members: input.members,
      mode: 'independent',
      runKey: freshTeamRunKey(),
      now: this.nextRunCreatedAt()
    })
    return this.replaceActiveRun(bundle)
  }

  /**
   * 显式结束当前 run（团队或独立批次）。独立批次此前没有任何结束出口，只能被
   * 替换或等待旧会话心跳过期；结束后携带令牌的旧会话在下一次轮询被围栏拒绝。
   */
  endActiveRun(): TeamControlSnapshot {
    const run = activeRunOf(this.loadState())
    if (!run) throw new Error('当前没有可结束的运行')
    if (run.status === 'completed') throw new Error('当前运行已经结束')
    this.assertNoLaunchInFlight()
    if (!this.repository.completeRun(run.id, Date.now())) {
      throw new Error('运行状态已变化，请刷新后重试')
    }
    this.emit()
    return this.getSnapshot()
  }

  private assertNoLaunchInFlight(): void {
    if (this.activeLaunch) throw new Error('团队启动指令正在投递，请稍后再切换')
  }

  /** 用新 run 替换当前活动 run：旧 run 显式收尾 → 写入新拓扑 → 切换会话作用域。 */
  private replaceActiveRun(bundle: WorkspaceTeamBundle): TeamControlSnapshot {
    const previous = activeRunOf(this.loadState())
    if (previous && previous.status !== 'completed' && previous.id !== bundle.run.id) {
      this.repository.completeRun(previous.id, Date.now())
    }
    this.repository.upsertWorkspaceTeam(bundle)
    this.collaborationLifecycle?.clearRun(bundle.run.id)
    this.syncConversationScope(this.loadState())
    this.emit()
    return this.getSnapshot()
  }

  createNextRun(): TeamControlSnapshot {
    let state = this.loadState()
    let previousRun = activeRunOf(state)
    const workspace = state.workspaces.find((candidate) => candidate.id === state.activeWorkspaceId)
    if (!previousRun || !workspace) throw new Error('当前没有可续建的团队工作区')
    if (previousRun.status !== 'completed') {
      const snapshot = this.getSnapshot()
      const teamMembers = snapshot.members.filter((member) => member.slot.solo !== true)
      const canExplicitlyEnd = ['launching', 'running', 'attention', 'paused'].includes(previousRun.status)
        && teamMembers.length > 0
        && teamMembers.every((member) => (
          !member.runtime?.online && !hasInFlightExecution(member.runtime)
        ))
      if (!canExplicitlyEnd) {
        throw new Error('当前仍有在线或执行中的 Agent；请先恢复当前团队，或等待任务停止后再开始新一轮')
      }
      if (!this.repository.completeRun(previousRun.id, Date.now())) {
        throw new Error('当前 TeamRun 状态已变化，请刷新后重试')
      }
      state = this.loadState()
      previousRun = activeRunOf(state)
      if (!previousRun || previousRun.status !== 'completed') {
        throw new Error('旧 TeamRun 收尾失败，请刷新后重试')
      }
    }

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
    if (!reusableChannelIds.length) throw new Error('上一轮没有可复用的拾光通道配置')

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
        if (!channelId) throw new Error('可复用的拾光通道不足')
        usedChannelIds.add(channelId)
        return {
          channelId,
          roleTemplateKey: role.templateKey,
          avatarId: slot.avatarId,
          skills: structuredClone(role.skills),
          modelSelection: slot.modelSelection ? structuredClone(slot.modelSelection) : undefined,
          solo: slot.solo === true
        }
      })
    const bundle = createConfiguredTeamBundle({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      members,
      runKey: freshTeamRunKey(),
      now: this.nextRunCreatedAt()
    })
    this.repository.upsertWorkspaceTeam(bundle)
    this.collaborationLifecycle?.clearRun(bundle.run.id)
    this.syncConversationScope(this.loadState())
    this.emit()
    return this.getSnapshot()
  }

  setActiveWorkspace(workspaceId: string): TeamControlSnapshot {
    this.repository.setActiveWorkspace(workspaceId)
    this.syncConversationScope(this.loadState())
    this.emit()
    return this.getSnapshot()
  }

  updateGoal(goal: string): TeamControlSnapshot {
    const run = activeRunOf(this.loadState())
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
    if (target.slot.solo === true) throw new Error('独立席位不能成为团队主控')
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

  prepareComposerRelaunch(channelId: string): string | undefined {
    const snapshot = this.getSnapshot()
    const member = snapshot.members.find((candidate) => (
      (candidate.binding?.channelId ?? candidate.slot.channelId) === channelId
    ))
    if (!member?.binding || !member.runtime || member.runtime.online || hasInFlightExecution(member.runtime)) return undefined
    const bindingKey = randomUUID()
    const changed = this.repository.prepareComposerRelaunch({
      runId: member.binding.runId,
      slotId: member.slot.id,
      bindingKey
    })
    if (!changed) return undefined
    this.emit()
    return bindingKey
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

  /**
   * 会话编排终态回写。失败只影响对应席位，并把本轮转入 attention；
   * 已成功/已签到席位保持原状，迟到的 check-in 仍可继续推进到 running。
   */
  settleAgentSessionLaunch(plan: AgentLaunchPlan): void {
    if (plan.state !== 'failed') return
    const snapshot = this.getSnapshot()
    const run = snapshot.activeRun
    if (!run || run.status !== 'launching') return
    const bindingByChannel = new Map(snapshot.bindings.map((binding) => [binding.channelId, binding]))
    for (const item of plan.items) {
      if (item.stage !== 'failed') continue
      const binding = bindingByChannel.get(item.channelId)
      if (!binding || binding.launchStatus === 'acknowledged') continue
      this.repository.recordLaunchDelivery({
        runId: run.id,
        slotId: binding.slotId,
        status: 'failed',
        detail: item.message || 'Cursor Agent 会话启动失败'
      })
    }
    this.emit()
  }

  /**
   * Lobby 逐会话模型配置持久化：写入当前 run 对应席位，重启/换 run 后回读仍一一对应。
   */
  setSlotModelSelection(channelId: string, selection: CursorModelSelection): TeamControlSnapshot {
    const normalized = String(channelId ?? '').trim()
    if (!/^\d{1,12}$/.test(normalized)) throw new Error('通道号无效')
    const snapshot = this.getSnapshot()
    if (!snapshot.activeRun) throw new Error('当前没有活跃 TeamRun，无法保存会话模型配置')
    const member = snapshot.members.find((candidate) => (
      (candidate.binding?.channelId ?? candidate.slot.channelId) === normalized
    ))
    if (!member) throw new Error(`CH-${normalized} 不属于当前 TeamRun`)
    this.repository.setSlotModelSelection(member.slot.id, sanitizeModelSelection(selection), Date.now())
    this.emit()
    return this.getSnapshot()
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
    const teamMembers = launchSnapshot.members.filter((member) => member.slot.solo !== true)
    this.activeLaunch = Promise.all(teamMembers.map(async (member) => {
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
      const revision = this.repository.revision?.() ?? this.repository.loadTeamControl().revision
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
          displayName: runtime?.displayName ?? `SG Team CH-${channelId}`,
          status: runtime?.status ?? 'offline' as const,
          online: runtime?.online ?? false,
          runtimeEvidence: runtime?.runtimeEvidence,
          waiting: runtime?.waiting ?? false,
          connectionPhase: runtime?.connectionPhase,
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
          runtimeEvidence: runtime.runtimeEvidence,
          waiting: runtime.waiting,
          connectionPhase: runtime.connectionPhase,
          pendingOutboundId: runtime.pendingOutboundId,
          pendingReplySyncSince: runtime.pendingReplySyncSince,
          queueDepth: runtime.queueDepth,
          lastSeenAt: runtime.lastSeenAt,
          lastAgentActivityAt: runtime.lastAgentActivityAt,
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
    const teamMembers = members.filter((member) => member.slot.solo !== true)
    const agentsWaiting = teamMembers.length > 0 && teamMembers.every((member) =>
      member.runtime?.online && member.runtime.waiting
    )
    const blockers: string[] = []
    if (!bridgeConnected) blockers.push('拾光本地通道尚未就绪')
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

  private recoverStaleLaunch(state: TeamControlState): TeamControlState {
    const run = activeRunOf(state)
    if (!run || run.status !== 'launching' || !run.launchedAt) return state
    if (Date.now() - run.launchedAt < STALE_LAUNCH_TIMEOUT_MS) return state
    const pending = state.bindings.filter((binding) => (
      binding.runId === run.id
      && binding.launchStatus !== 'acknowledged'
      && state.slots.find((slot) => slot.id === binding.slotId)?.solo !== true
    ))
    for (const binding of pending) {
      this.repository.recordLaunchDelivery({
        runId: run.id,
        slotId: binding.slotId,
        status: 'uncertain',
        detail: '启动确认窗口已结束；可重试该通道，迟到的 Agent 签到仍会被接纳'
      })
    }
    return pending.length ? this.loadState() : state
  }

  /**
   * 老版本预启动团队会复用 team-run:<workspace>:main。只在 draft/ready 且无
   * runtime bindings 的阶段一次性迁到 fresh run；已绑定或已运行的旧 run 不能在
   * 拾光重启时自动换身份，否则会影响 Cursor 中仍然活着的会话。
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
        skills: structuredClone(role.skills),
        modelSelection: slot.modelSelection ? structuredClone(slot.modelSelection) : undefined,
        solo: slot.solo === true
      } satisfies TeamMemberConfiguration]
    })
    if (members.length !== slots.length) return state
    const bundle = createConfiguredTeamBundle({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      members,
      runKey: freshTeamRunKey(),
      now: this.nextRunCreatedAt()
    })
    bundle.run.goal = run.goal
    bundle.run.status = 'draft'
    this.repository.upsertWorkspaceTeam(bundle)
    return this.loadState()
  }
}
