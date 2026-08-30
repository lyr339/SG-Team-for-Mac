import type { AgentSession, AgentExecutionProfile } from '../domain/agent-session'
import { sanitizeModelGeneratedText } from '../domain/model-output-sanitizer'
import type { CursorModelOption, CursorModelSelection } from '../domain/cursor-model'
import { badgesFromParameters, contextTokensFromValue } from '../shared/model-badges'
import {
  emptyCursorTelemetrySnapshot,
  type CursorComposerTelemetry,
  type CursorTelemetrySnapshot
} from '../domain/cursor-telemetry'
import type { RuntimeBinding, TeamControlSnapshot, TeamRunStatus } from '../domain/team-control'
import type {
  DesktopSnapshot,
  LiveAgentResponseState,
  LiveProcessState,
  SendMessageAccepted,
  SendMessageInput
} from '../shared/desktop-api'
import type { ProcessBlock } from '../domain/conversation-entry'
import type { CursorComposerTelemetrySource } from '../infrastructure/cursor/cursor-composer-telemetry'
import type { ChannelMessageRelay } from './channel-message-relay'
import type { CursorComposerRuntimeEvidence, CursorProcessStream } from '../infrastructure/cursor/cursor-cdp-session-creator'
import { verifyAgentRuntime } from './verify-agent-runtime'

// 持久遥测只负责会话索引/上下文/变更统计；过程流由 sgTeamProcess 原生事件承担。
const DEFAULT_TELEMETRY_POLL_MS = 250
/** 空闲档（无活跃 TeamRun）：遥测降频到 10s——没有活跃 Agent 时没有可刷新的内容。 */
const IDLE_TELEMETRY_POLL_MS = 10_000
const COMPOSER_SCOPE_CLOCK_SKEW_MS = 5_000

export interface DesktopSessionTransport {
  getSnapshot(): DesktopSnapshot
  sendMessage(input: SendMessageInput): SendMessageAccepted
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void
}

export interface DesktopSessionBridge extends DesktopSessionTransport {}

export interface DesktopSessionTeamSource {
  getSnapshot(): TeamControlSnapshot
  subscribe(listener: (snapshot: TeamControlSnapshot) => void): () => void
  recordComposerBinding(input: {
    runId: string
    slotId: string
    generation: string
    bindingKey: string
    composerId: string
    method: 'launch_marker' | 'channel_marker'
    at?: number
  }): boolean
}

export interface CursorComposerRuntimeSource {
  inspectComposerRuntime(
    workspacePath: string | undefined,
    composerIds: string[]
  ): Promise<Record<string, CursorComposerRuntimeEvidence>>
}

type DesktopSessionListener = (snapshot: DesktopSnapshot) => void

function activeWorkspaceOf(team: TeamControlSnapshot) {
  return team.workspaces.find((workspace) => workspace.id === team.activeWorkspaceId)
}

function bindingByChannel(team: TeamControlSnapshot): Map<string, RuntimeBinding> {
  return new Map(team.bindings.map((binding) => [binding.channelId, binding]))
}

function telemetryStatus(input: {
  workspaceSelected: boolean
  telemetry: CursorTelemetrySnapshot
  binding?: RuntimeBinding
  composer?: CursorComposerTelemetry
}): NonNullable<AgentSession['telemetry']> {
  const { workspaceSelected, telemetry, binding, composer } = input
  if (!workspaceSelected) {
    return { state: 'unavailable', detail: '选择团队工作区后接入 Cursor 遥测' }
  }
  if (!binding) {
    return { state: 'unbound', detail: '尚未建立 Agent RuntimeBinding' }
  }
  if (telemetry.availability === 'error') {
    return { state: 'error', detail: telemetry.issue || 'Cursor 本机遥测读取失败' }
  }
  if (telemetry.availability === 'unavailable') {
    return { state: 'unavailable', detail: telemetry.issue || 'Cursor 本机遥测不可用' }
  }
  if (!binding.composerId) {
    return {
      state: 'unbound',
      detail: '等待下一次团队启动写入唯一会话标记',
      source: 'cursor-local',
      updatedAt: telemetry.updatedAt
    }
  }
  if (!composer) {
    return {
      state: 'stale',
      detail: '已绑定 Composer，等待 Cursor 刷新本机会话索引',
      source: 'cursor-local',
      bindingMethod: binding.composerBindingMethod,
      updatedAt: telemetry.updatedAt
    }
  }
  return {
    state: 'bound',
    detail: 'Cursor 本机会话遥测已绑定',
    source: 'cursor-local',
    bindingMethod: binding.composerBindingMethod,
    updatedAt: composer.lastUpdatedAt ?? telemetry.updatedAt
  }
}

/**
 * 运行时证据指纹瘦身：剔除大字段——process（thinking 全文 ≤48KB/composer）与
 * responseText（≤100KB）。安全性：observedAt 每拍必变且保留在指纹中，指纹相等性
 * 本就由它主导（活跃期从不相等，仅双方皆 {} 时相等），剔除大字段不改变判定结果，
 * 只省掉 150ms 快循环下 ~1MB/s 的双次无效序列化。
 */
const RUNTIME_EVIDENCE_FINGERPRINT_REPLACER = (key: string, value: unknown): unknown => (
  key === 'process' || key === 'responseText' ? undefined : value
)

function applyRuntimeEvidence(
  telemetry: CursorTelemetrySnapshot,
  evidence: Record<string, CursorComposerRuntimeEvidence>,
  now = Date.now()
): CursorTelemetrySnapshot {
  let changed = false
  const composers = telemetry.composers.map((composer) => {
    const live = evidence[composer.composerId]
    // 实时证据只短暂缓存，避免 Cursor/CDP 退出后沿用陈旧的 active 判断。
    if (!live || now - live.observedAt > 3_000 || live.state === 'unknown') return composer
    changed = true
    return {
      ...composer,
      activity: {
        state: live.state,
        detail: live.detail,
        observedAt: live.observedAt,
        channelId: composer.activity?.channelId
      }
    }
  })
  return changed ? { ...telemetry, composers, updatedAt: Math.max(telemetry.updatedAt, now) } : telemetry
}

/**
 * 选定值一一对应投影：创建团队/批量发起会话时选定的模型/思考/上下文
 * 直接生成执行画像，会话卡显示与「所选」严格对应；
 * 无选定值时调用方回退 Cursor 读回（逐会话 → 全局）。
 */
function selectionExecutionProfile(
  selection: CursorModelSelection | undefined,
  models: CursorModelOption[] | undefined
): AgentExecutionProfile | undefined {
  if (!selection) return undefined
  const option = models?.find((model) => model.modelId === selection.modelId)
  const kinds = new Map<string, 'boolean' | 'enum'>(
    (option?.parameterDefinitions ?? []).map(
      (definition): [string, 'boolean' | 'enum'] => [definition.id, definition.kind]
    )
  )
  const contextTokens = contextTokensFromValue(
    selection.parameters.find((parameter) => parameter.id === 'context')?.value ?? ''
  )
  return {
    scope: 'cursor-composer-current',
    modelId: selection.modelId,
    displayName: selection.displayName,
    options: badgesFromParameters(selection.parameters, kinds),
    maxMode: selection.maxMode === true,
    contextTokenLimit: contextTokens ?? option?.contextTokenLimit
  }
}

export function enrichDesktopSnapshot(
  bridgeSnapshot: DesktopSnapshot,
  team: TeamControlSnapshot,
  telemetry: CursorTelemetrySnapshot
): DesktopSnapshot {
  const verifiedSnapshot = verifyAgentRuntime(bridgeSnapshot, team, telemetry)
  const workspace = activeWorkspaceOf(team)
  const runStartedAt = team.activeRun?.createdAt
  const bindings = bindingByChannel(team)
  const composerById = new Map(telemetry.composers.map((composer) => [composer.composerId, composer]))
  const modelDisplayById = new Map((telemetry.cursorModels ?? []).map((model) => [model.modelId, model.displayName]))
  const desiredModelByChannel = new Map(team.members.flatMap((member) => {
    const channelId = member.binding?.channelId ?? member.slot.channelId
    return channelId && member.slot.modelSelection
      ? [[channelId, member.slot.modelSelection] as const]
      : []
  }))
  const sessions = verifiedSnapshot.sessions.map((session): AgentSession => {
    const binding = bindings.get(session.channelId)
    const composer = binding?.composerId ? composerById.get(binding.composerId) : undefined
    // 无 composer 绑定时，回退到通道最新转录定位到的 composer（可能跨工作区，
    // 已由遥测层全局水合），让上下文用量在绑定缺失/滞后期间仍可读
    const channelComposerId = telemetry.channelActivities?.[session.channelId]?.composerId
    const channelComposer = channelComposerId ? composerById.get(channelComposerId) : undefined
    const channelComposerInScope = channelComposer && (
      runStartedAt === undefined
      || (channelComposer.createdAt !== undefined
        && channelComposer.createdAt + COMPOSER_SCOPE_CLOCK_SKEW_MS >= runStartedAt)
    )
      ? channelComposer
      : undefined
    const status = telemetryStatus({
      workspaceSelected: Boolean(workspace),
      telemetry,
      binding,
      composer
    })
    return {
      ...session,
      composerId: composer?.composerId ?? binding?.composerId,
      composerTitle: composer?.title,
      modelName: composer?.modelName
        ? modelDisplayById.get(composer.modelName) ?? composer.modelName
        : desiredModelByChannel.get(session.channelId)?.displayName,
      executionProfile:
        selectionExecutionProfile(desiredModelByChannel.get(session.channelId), telemetry.cursorModels)
        ?? composer?.modelProfile
        ?? telemetry.composerProfile,
      startedAt: binding?.acknowledgedAt ?? composer?.createdAt ?? session.startedAt,
      lastAgentActivityAt: composer?.activity?.observedAt,
      // 绑定 Composer 偶尔会先于 ItemTable 的 contextUsage 水合完成；此时允许
      // 同通道、同一 TeamRun 内的转录定位 Composer 做字段级回退，不能因为绑定
      // 对象存在但该字段暂缺就让会话卡的上下文条整块消失。
      contextUsage: composer?.contextUsage ?? channelComposerInScope?.contextUsage,
      changes: composer?.changes,
      telemetry: status,
      healthEvidence: [
        ...session.healthEvidence,
        status.state === 'bound' ? 'Cursor Composer 遥测已绑定' : status.detail
      ]
    }
  })
  return {
    ...verifiedSnapshot,
    sessions,
    cursorModels: telemetry.cursorModels ?? verifiedSnapshot.cursorModels,
    updatedAt: Math.max(verifiedSnapshot.updatedAt, telemetry.updatedAt)
  }
}

export class DesktopSessionService implements DesktopSessionBridge {
  private readonly listeners = new Set<DesktopSessionListener>()
  private readonly unsubscribeBridge: () => void
  private readonly unsubscribeTeam: () => void
  private readonly unsubscribeRelay?: () => void
  private telemetry = emptyCursorTelemetrySnapshot()
  private telemetryFingerprint = ''
  private watchTimer?: ReturnType<typeof setInterval>
  private activeWorkspaceId?: string
  private activeRunId?: string
  private activeRunStatus?: TeamRunStatus
  private refreshing = false
  private runtimeInspecting = false
  private lastRuntimeInspectionAt = 0
  private readonly pendingRuntimeSignals = new Set<string>()
  /** observer 可能早于团队绑定水合完成；按 composer 暂存最后一帧，绑定就绪立即回放。 */
  private readonly pendingNativeProcessByComposer = new Map<string, {
    composerId: string
    observedAt: number
    isGenerating: boolean
    process?: CursorProcessStream
  }>()
  private runtimeSignalTimer?: ReturnType<typeof setTimeout>
  private runtimeEvidence: Record<string, CursorComposerRuntimeEvidence> = {}
  private readonly liveAgentResponses = new Map<string, LiveAgentResponseState>()
  /** Cursor 内存模型直接推送的当前回合过程流。 */
  private readonly liveCursorProcess = new Map<string, {
    view: LiveProcessState
    fingerprint: string
    generating: boolean
    updatedAt: number
    blockFirstSeen: Map<string, number>
  }>()
  /** Cursor 原生完成回合的内存归档；只贴到对应回复，不读取 transcript/SQLite 过程。 */
  private readonly nativeProcessArchive = new Map<string, LiveProcessState>()
  private runtimeFastTimer?: ReturnType<typeof setInterval>
  private lastRuntimeArgs?: { workspacePath: string; bindings: RuntimeBinding[] }
  /** 遥测短暂缺字段时保留同 Composer 最近一次上下文读数；换工作区/换轮即清空。 */
  private readonly contextUsageByComposer = new Map<string, NonNullable<AgentSession['contextUsage']>>()
  /**
   * 会话视图增量缓存：fingerprint 命中即复用引用（结构共享，渲染层 memo 红利）。
   * 指纹覆盖 relay 输出关键值 + 遥测（composer/上下文/过程）+ 后处理（分钟桶时长）；
   * 计算每轮照跑（durationBySession 副作用语义不变），缓存省的是
   * 对象分配与下游重渲，不是计算本身——语义不漂。
   */
  private readonly sessionViewCache = new Map<string, { fingerprint: string; view: AgentSession }>()
  private readonly durationBySession = new Map<string, {
    accumulatedMs: number
    onlineSince?: number
    measured: boolean
  }>()

  constructor(
    private readonly bridge: DesktopSessionTransport,
    private readonly team: DesktopSessionTeamSource,
    private readonly telemetrySource: CursorComposerTelemetrySource,
    private readonly embeddedRelay?: ChannelMessageRelay,
    private readonly runtimeSource?: CursorComposerRuntimeSource
  ) {
    const initialTeam = team.getSnapshot()
    this.activeWorkspaceId = initialTeam.activeWorkspaceId
    this.activeRunId = initialTeam.activeRun?.id
    this.activeRunStatus = initialTeam.activeRun?.status
    if (initialTeam.activeRun?.status === 'completed') this.embeddedRelay?.completeScope()
    this.unsubscribeBridge = bridge.subscribe(() => this.emit())
    this.unsubscribeRelay = embeddedRelay?.subscribe(() => this.emit())
    this.unsubscribeTeam = team.subscribe((snapshot) => {
      const workspaceChanged = snapshot.activeWorkspaceId !== this.activeWorkspaceId
      const runChanged = snapshot.activeRun?.id !== this.activeRunId
      const runCompleted = snapshot.activeRun?.status === 'completed' && this.activeRunStatus !== 'completed'
      this.activeWorkspaceId = snapshot.activeWorkspaceId
      this.activeRunId = snapshot.activeRun?.id
      this.activeRunStatus = snapshot.activeRun?.status
      if (workspaceChanged) {
        this.telemetry = emptyCursorTelemetrySnapshot()
        this.telemetryFingerprint = ''
        this.durationBySession.clear()
        this.runtimeEvidence = {}
        this.liveAgentResponses.clear()
        this.liveCursorProcess.clear()
        this.nativeProcessArchive.clear()
        this.pendingNativeProcessByComposer.clear()
        this.contextUsageByComposer.clear()
        this.refreshTelemetry()
      }
      if (runChanged && !workspaceChanged) {
        this.durationBySession.clear()
        this.liveAgentResponses.clear()
        this.liveCursorProcess.clear()
        this.nativeProcessArchive.clear()
        this.pendingNativeProcessByComposer.clear()
        this.contextUsageByComposer.clear()
      }
      const run = snapshot.activeRun
      if (runChanged && run) this.embeddedRelay?.resetScope(run.id, run.createdAt)
      if (runCompleted) this.embeddedRelay?.completeScope(snapshot.activeRun?.updatedAt ?? Date.now())
      this.emit()
    })
  }

  getSnapshot(): DesktopSnapshot {
    const base = this.bridge.getSnapshot()
    const withEmbedded = this.embeddedRelay?.applyTo(base) ?? base
    const enriched = enrichDesktopSnapshot(withEmbedded, this.team.getSnapshot(), this.telemetry)
    const snapshot: DesktopSnapshot = {
      ...enriched,
      sessions: enriched.sessions.map((session) => {
        const key = session.composerId || session.id
        if (session.contextUsage) this.contextUsageByComposer.set(key, session.contextUsage)
        const contextUsage = session.contextUsage ?? this.contextUsageByComposer.get(key)
        const activeDurationMs = this.trackActiveDuration(key, session)
        // 增量缓存：值指纹命中即复用上轮视图引用。时长按分钟桶参与指纹
        //（与显示精度一致：分钟翻转才重建），其余字段逐值比较。
        const fingerprint = [
          session.online ? 1 : 0,
          session.status,
          session.waiting ? 1 : 0,
          session.connected ? 1 : 0,
          session.runtimeEvidence ?? '',
          session.deliveryMode ?? '',
          session.lastSeenAt ?? 0,
          session.queueDepth,
          session.connectionPhase,
          session.composerId ?? '',
          session.composerTitle ?? '',
          session.modelName ?? '',
          session.executionProfile?.modelId ?? '',
          session.executionProfile?.displayName ?? '',
          session.executionProfile?.options.join(',') ?? '',
          session.executionProfile?.maxMode ? 1 : 0,
          session.executionProfile?.contextTokenLimit ?? '',
          session.telemetry?.state ?? '',
          session.telemetry?.detail ?? '',
          contextUsage?.ratio ?? '',
          contextUsage?.used ?? '',
          contextUsage?.limit ?? '',
          contextUsage?.breakdown?.totalUsedTokens ?? '',
          contextUsage?.breakdown?.maxTokens ?? '',
          contextUsage?.breakdown?.categories
            .map((category) => `${category.id}:${category.estimatedTokens}`).join(',') ?? '',
          session.changes?.additions ?? '',
          session.changes?.deletions ?? '',
          session.healthEvidence.length,
          session.healthEvidence.at(-1) ?? '',
          activeDurationMs === undefined ? '' : Math.floor(activeDurationMs / 60_000)
        ].join('|')
        const cached = this.sessionViewCache.get(session.id)
        if (cached?.fingerprint === fingerprint) return cached.view
        const view: AgentSession = { ...session, contextUsage, activeDurationMs }
        this.sessionViewCache.set(session.id, { fingerprint, view })
        return view
      })
    }
    const withNativeHistory = this.attachNativeProcessArchive(snapshot)
    const liveAgentResponses = this.liveAgentResponseSnapshot(withNativeHistory)
    const withResponses = liveAgentResponses ? { ...withNativeHistory, liveAgentResponses } : withNativeHistory
    return this.applyLiveCursorProcess(withResponses)
  }

  /** Cursor 原生当前回合直接成为唯一 liveProcess 来源；超过时效后撤下。 */
  private applyLiveCursorProcess(snapshot: DesktopSnapshot): DesktopSnapshot {
    const now = Date.now()
    const liveProcess: Record<string, LiveProcessState> = {}
    for (const [channelId, state] of this.liveCursorProcess) {
      const staleMs = state.generating ? 8_000 : 3_500
      if (now - state.updatedAt > staleMs) {
        this.liveCursorProcess.delete(channelId)
        continue
      }
      liveProcess[channelId] = state.view
    }
    if (!Object.keys(liveProcess).length) {
      if (!snapshot.liveProcess) return snapshot
      const { liveProcess: _legacy, ...withoutLegacyProcess } = snapshot
      return withoutLegacyProcess
    }
    return { ...snapshot, liveProcess }
  }

  /** 把完成的 Cursor 原生过程贴到该通道随后落地的助手回复。 */
  private attachNativeProcessArchive(snapshot: DesktopSnapshot): DesktopSnapshot {
    if (!this.nativeProcessArchive.size) return snapshot
    let conversations = snapshot.conversations
    let changed = false
    for (const [channelId, archived] of this.nativeProcessArchive) {
      const entries = conversations[channelId]
      if (!entries?.length) continue
      let replyIndex = -1
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]
        if (entry?.role === 'assistant' && entry.timestamp >= archived.startedAt - 5_000) {
          replyIndex = index
          break
        }
      }
      if (replyIndex < 0) continue
      const reply = entries[replyIndex]!
      if (reply.processBlocks === archived.blocks) continue
      if (!changed) conversations = { ...conversations }
      const nextEntries = [...entries]
      nextEntries[replyIndex] = { ...reply, processBlocks: archived.blocks, turn: archived.turn }
      conversations[channelId] = nextEntries
      changed = true
    }
    return changed ? { ...snapshot, conversations } : snapshot
  }

  private trackActiveDuration(key: string, session: AgentSession): number | undefined {
    const now = Date.now()
    let state = this.durationBySession.get(key)
    if (!state) {
      if (session.online) {
        const startedAt = session.startedAt && session.startedAt <= now ? session.startedAt : now
        state = { accumulatedMs: 0, onlineSince: startedAt, measured: true }
      } else {
        const endAt = session.lastAgentActivityAt ?? session.disconnectedAt
        const measured = Boolean(session.startedAt && endAt && endAt >= session.startedAt)
        state = {
          accumulatedMs: measured ? endAt! - session.startedAt! : 0,
          measured
        }
      }
      this.durationBySession.set(key, state)
    } else if (session.online && state.onlineSince === undefined) {
      state.onlineSince = now
      state.measured = true
    } else if (!session.online && state.onlineSince !== undefined) {
      const evidenceAt = session.disconnectedAt ?? session.lastAgentActivityAt
      const endAt = evidenceAt && evidenceAt >= state.onlineSince && evidenceAt <= now + 5_000
        ? evidenceAt
        : now
      state.accumulatedMs += Math.max(0, endAt - state.onlineSince)
      state.onlineSince = undefined
      state.measured = true
    }
    if (!state.measured) return undefined
    return Math.max(0, Math.round(state.accumulatedMs + (state.onlineSince === undefined ? 0 : now - state.onlineSince)))
  }

  sendMessage(input: SendMessageInput): SendMessageAccepted {
    // 一体化分流：内嵌通道直写拾光 SQLite 队列，插件通道维持原 WS 链路
    if (this.embeddedRelay?.handlesChannel(String(input.channelId ?? '').trim())) {
      return this.embeddedRelay.sendMessage(input)
    }
    return this.bridge.sendMessage(input)
  }

  subscribe(listener: DesktopSessionListener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  startWatcher(intervalMs = DEFAULT_TELEMETRY_POLL_MS): void {
    this.stopWatcher()
    this.startRuntimeFastLoop()
    this.refreshTelemetry()
    // 动态节拍（setTimeout 链）：活跃 TeamRun 保持原频率；空闲（无 run 或
    // 未启动/已结束）降频——遥测是最重的常驻轮询（读 vscdb + 扫转录文件），
    // 空闲时高频纯属浪费；活跃语义不变（检测延迟只在空档期变长）。
    const activeMs = Math.max(200, intervalMs)
    const loop = (): void => {
      this.watchTimer = setTimeout(() => {
        this.refreshTelemetry()
        loop()
      }, this.telemetryIdle() ? IDLE_TELEMETRY_POLL_MS : activeMs)
      this.watchTimer.unref?.()
    }
    loop()
  }

  stopWatcher(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = undefined
    this.stopRuntimeFastLoop()
  }

  /** 空闲判定：无 active run，或 run 处于未启动/已结束相位（无活跃 Agent 可产生遥测变化）。 */
  private telemetryIdle(): boolean {
    const run = this.team.getSnapshot().activeRun
    if (!run) return true
    return ['draft', 'ready', 'completed'].includes(run.status)
  }

  refreshTelemetry(): void {
    if (this.refreshing) return
    this.refreshing = true
    try {
      let teamSnapshot = this.team.getSnapshot()
      const workspace = activeWorkspaceOf(teamSnapshot)
      const local = workspace
        ? this.telemetrySource.readWorkspace(workspace.path, teamSnapshot.bindings)
        : emptyCursorTelemetrySnapshot('unavailable', '尚未选择团队工作区')
      const next = applyRuntimeEvidence(local, this.runtimeEvidence)

      const bindingByChannelId = bindingByChannel(teamSnapshot)
      for (const candidate of next.bindingCandidates) {
        const binding = bindingByChannelId.get(candidate.channelId)
        if (
          !binding ||
          binding.composerId ||
          binding.generation !== candidate.generation ||
          binding.composerBindingKey !== candidate.bindingKey
        ) continue
        this.team.recordComposerBinding({
          runId: binding.runId,
          slotId: binding.slotId,
          generation: binding.generation,
          bindingKey: binding.composerBindingKey,
          composerId: candidate.composerId,
          method: candidate.method
        })
      }
      teamSnapshot = this.team.getSnapshot()
      const fingerprint = JSON.stringify({
        availability: next.availability,
        workspacePath: next.workspacePath,
        composers: next.composers,
        channelActivities: next.channelActivities,
        issue: next.issue,
        bindings: teamSnapshot.bindings.map((binding) => [
          binding.id,
          binding.composerId,
          binding.composerBindingMethod
        ])
      })
      const changed = fingerprint !== this.telemetryFingerprint
      this.telemetry = next
      this.telemetryFingerprint = fingerprint
      if (changed) this.emit()
      if (workspace) this.refreshRuntimeEvidence(workspace.path, teamSnapshot.bindings)
    } catch (error) {
      const failed = emptyCursorTelemetrySnapshot(
        'error',
        error instanceof Error ? error.message.slice(0, 300) : 'Cursor 本机遥测刷新失败'
      )
      const fingerprint = JSON.stringify({
        availability: failed.availability,
        issue: failed.issue
      })
      const changed = fingerprint !== this.telemetryFingerprint
      this.telemetry = failed
      this.telemetryFingerprint = fingerprint
      if (changed) this.emit()
    } finally {
      this.refreshing = false
    }
  }

  private refreshRuntimeEvidence(workspacePath: string, bindings: RuntimeBinding[]): void {
    if (!this.runtimeSource || this.runtimeInspecting) return
    const now = Date.now()
    if (now - this.lastRuntimeInspectionAt < 120) return
    const composerIds = bindings.flatMap((binding) => binding.composerId ? [binding.composerId] : [])
    if (!composerIds.length) return
    this.runtimeInspecting = true
    this.lastRuntimeInspectionAt = now
    this.lastRuntimeArgs = { workspacePath, bindings }
    this.flushPendingNativeProcess(bindings)
    const workspaceId = this.activeWorkspaceId
    const runId = this.activeRunId
    void this.runtimeSource.inspectComposerRuntime(workspacePath, composerIds)
      .then((evidence) => {
        if (workspaceId !== this.activeWorkspaceId || runId !== this.activeRunId) return
        let liveChanged = false
        for (const binding of bindings) {
          if (!binding.composerId) continue
          const live = evidence[binding.composerId]
          if (live?.state === 'stopped') {
            this.embeddedRelay?.markCursorStopped(binding.channelId, live.observedAt)
          }
          if (live) {
            liveChanged = this.updateLiveAgentResponse(binding.channelId, live) || liveChanged
            liveChanged = this.updateLiveCursorProcess(binding.channelId, live) || liveChanged
          }
        }
        const fingerprint = JSON.stringify(evidence, RUNTIME_EVIDENCE_FINGERPRINT_REPLACER)
        if (fingerprint === JSON.stringify(this.runtimeEvidence, RUNTIME_EVIDENCE_FINGERPRINT_REPLACER)) return
        this.runtimeEvidence = evidence
        const next = applyRuntimeEvidence(this.telemetry, evidence)
        if (next !== this.telemetry) {
          this.telemetry = next
          this.telemetryFingerprint = ''
          this.emit()
        } else if (liveChanged) {
          this.emit()
        }
      })
      .catch(() => {})
      .finally(() => {
        this.runtimeInspecting = false
        this.flushPendingRuntimeSignals()
      })
  }

  /**
   * 写信号入口（CursorStreamObserver 事件驱动）：Cursor 模型写入的即时通知。
   * 触发立即 inspect（120ms 节流防 burst 风暴）只刷新会话存活与正文；过程流
   * 由同一 observer 的 sgTeamProcess 写后快照直推，不经过 inspect。
   */
  notifyComposerWriteSignal(composerId: string): void {
    if (!this.runtimeSource) return
    const args = this.lastRuntimeArgs
    if (!args?.bindings.length) return
    if (!composerId || !args.bindings.some((binding) => binding.composerId === composerId)) return
    this.pendingRuntimeSignals.add(composerId)
    this.flushPendingRuntimeSignals()
  }

  /** Cursor 写后直接推送的过程快照：无需再做 CDP evaluate 往返。 */
  notifyNativeProcessSnapshot(event: {
    composerId: string
    observedAt: number
    isGenerating: boolean
    process?: CursorProcessStream
  }): void {
    const binding = this.lastRuntimeArgs?.bindings.find((item) => item.composerId === event.composerId)
    if (!binding) {
      this.pendingNativeProcessByComposer.set(event.composerId, event)
      if (this.pendingNativeProcessByComposer.size > 32) {
        const oldest = this.pendingNativeProcessByComposer.keys().next().value
        if (oldest) this.pendingNativeProcessByComposer.delete(oldest)
      }
      return
    }
    this.applyNativeProcessSnapshot(binding.channelId, event)
  }

  private flushPendingNativeProcess(bindings: RuntimeBinding[]): void {
    for (const binding of bindings) {
      if (!binding.composerId) continue
      const event = this.pendingNativeProcessByComposer.get(binding.composerId)
      if (!event) continue
      this.pendingNativeProcessByComposer.delete(binding.composerId)
      this.applyNativeProcessSnapshot(binding.channelId, event)
    }
  }

  private applyNativeProcessSnapshot(channelId: string, event: {
    composerId: string
    observedAt: number
    isGenerating: boolean
    process?: CursorProcessStream
  }): void {
    const changed = this.updateLiveCursorProcess(channelId, {
      composerId: event.composerId,
      state: event.isGenerating ? 'active' : 'unknown',
      detail: event.isGenerating ? 'Cursor 原生过程事件正在推送' : 'Cursor 原生过程回合已结束',
      observedAt: event.observedAt,
      isGenerating: event.isGenerating,
      process: event.process
    })
    if (!event.isGenerating) {
      const completed = this.liveCursorProcess.get(channelId)?.view
      if (completed?.blocks.length) this.nativeProcessArchive.set(channelId, completed)
    }
    if (changed) this.emit()
  }

  /**
   * 120ms 合并窗口采用 trailing-edge：inspect 进行中/节流窗口内到达的最后一帧
   * 必须在窗口结束后补读，绝不静默丢弃。这样最终正文与会话终态即使落在
   * 上一轮 inspect 中，也能被下一轮读取。
   */
  private flushPendingRuntimeSignals(): void {
    if (!this.pendingRuntimeSignals.size || !this.runtimeSource) return
    if (this.runtimeInspecting) return
    if (this.runtimeSignalTimer) return
    const delay = Math.max(0, 120 - (Date.now() - this.lastRuntimeInspectionAt))
    this.runtimeSignalTimer = setTimeout(() => {
      this.runtimeSignalTimer = undefined
      if (this.runtimeInspecting) {
        this.flushPendingRuntimeSignals()
        return
      }
      const args = this.lastRuntimeArgs
      if (!args?.bindings.length) return
      const relevant = args.bindings.some((binding) => (
        binding.composerId && this.pendingRuntimeSignals.has(binding.composerId)
      ))
      this.pendingRuntimeSignals.clear()
      if (relevant) this.refreshRuntimeEvidence(args.workspacePath, args.bindings)
    }, delay)
    this.runtimeSignalTimer.unref?.()
  }

  /**
   * 生成期加速采样：任一绑定 Composer 正在生成时以 150ms 直采运行时证据
   * （默认随遥测 250ms），打字机流感知更新率 4Hz→约 7Hz；前端 rAF 插值补齐帧感。
   * 空闲零开销（布尔短路直接返回）。
   */
  private startRuntimeFastLoop(): void {
    this.stopRuntimeFastLoop()
    this.runtimeFastTimer = setInterval(() => {
      if (!this.runtimeSource || this.runtimeInspecting) return
      const args = this.lastRuntimeArgs
      if (!args || !args.bindings.length) return
      const generating = Object.values(this.runtimeEvidence).some((evidence) => evidence.isGenerating === true)
        || [...this.liveCursorProcess.values()].some((state) => state.generating)
      if (!generating) return
      this.refreshRuntimeEvidence(args.workspacePath, args.bindings)
    }, 150)
    this.runtimeFastTimer.unref?.()
  }

  private stopRuntimeFastLoop(): void {
    if (this.runtimeFastTimer) clearInterval(this.runtimeFastTimer)
    this.runtimeFastTimer = undefined
  }

  /**
   * CDP 过程流状态维护：evidence.process（当前回合 thinking/工具/todos）映射为
   * ProcessBlock 序列。块 id 稳定（cursor:<bubbleId>），firstSeen/状态翻转按观测推进；
   * 生成结束后短暂保留（applyLiveCursorProcess 按时效撤下），随后由
   * nativeProcessArchive 贴到 Agent 回复。
   */
  private updateLiveCursorProcess(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean {
    if (evidence.state === 'stopped') {
      const removed = this.liveCursorProcess.delete(channelId)
      return removed
    }
    const stream = evidence.process
    if (!stream) {
      // 生成已结束（最后一帧可能只携带终止标记）：把仍为 running 的观测块
      // 原子收尾后归档，避免历史过程永久显示“进行中”。
      const previous = this.liveCursorProcess.get(channelId)
      if (previous?.generating) {
        const blocks = previous.view.blocks.map((block) => block.status === 'running'
          ? { ...block, status: 'done' as const, completedAt: evidence.observedAt }
          : block)
        const view: LiveProcessState = {
          ...previous.view,
          blocks,
          updatedAt: evidence.observedAt
        }
        this.liveCursorProcess.set(channelId, {
          ...previous,
          view,
          fingerprint: JSON.stringify(blocks.map((block) => [block.id, block.status, block.completedAt ?? ''])),
          generating: false,
          updatedAt: evidence.observedAt
        })
        return true
      }
      return false
    }
    const now = evidence.observedAt
    const previous = this.liveCursorProcess.get(channelId)
    const generating = evidence.isGenerating === true || stream.generatingBubbleCount > 0
    const incomingIds = new Set(stream.items.map((item) => item.id))
    if (stream.todos?.length) incomingIds.add('cursor:todos')
    const overlapsPrevious = previous?.view.blocks.some((block) => incomingIds.has(block.id)) === true
    // 回合延续以稳定 bubble id 为主证据；只靠时间会把用户快速发起的下一轮误并
    // 到上一轮。上一轮仍在生成时允许新 bubble 直接追加。
    const sameTurn = previous !== undefined
      && (previous.generating || overlapsPrevious)
    const turn = sameTurn && previous ? previous.view.turn : `cursor:${now}`
    const blockFirstSeen = sameTurn && previous
      ? previous.blockFirstSeen
      : new Map<string, number>()
    const blockById = new Map<string, ProcessBlock>()
    const blockOrder: string[] = []
    if (sameTurn && previous) {
      for (const block of previous.view.blocks) {
        blockById.set(block.id, block)
        blockOrder.push(block.id)
      }
    }
    const upsert = (block: ProcessBlock): void => {
      const existing = blockById.get(block.id)
      if (!existing) blockOrder.push(block.id)
      blockById.set(block.id, existing ? { ...block, startedAt: existing.startedAt ?? block.startedAt } : block)
    }
    const seen = (id: string): number => {
      const existing = blockFirstSeen.get(id)
      if (existing !== undefined) return existing
      const at = now
      blockFirstSeen.set(id, at)
      return at
    }
    for (const item of stream.items) {
      const startedAt = seen(item.id)
      if (item.kind === 'thinking') {
        const status = !generating && item.status === 'running' ? 'done' : item.status
        upsert({
          kind: 'thinking', id: item.id, text: item.text, status,
          durationMs: item.durationMs,
          startedAt,
          completedAt: status === 'done' ? now : undefined,
          timingEstimated: item.durationMs === undefined
        })
        continue
      }
      if (item.kind === 'message') {
        const status = !generating && item.status === 'running' ? 'done' : item.status
        upsert({
          kind: 'message', id: item.id, text: item.text, status,
          startedAt,
          completedAt: status === 'done' ? now : undefined,
          timingEstimated: true
        })
        continue
      }
      const status = !generating && item.status === 'running' ? 'done' : item.status
      upsert({
        kind: 'tool', id: item.id, toolName: item.toolName, toolKind: item.toolKind,
        summary: item.summary || undefined,
        input: item.input,
        output: item.output,
        error: item.error,
        status,
        startedAt,
        completedAt: status === 'done' || status === 'failed' ? now : undefined,
        timingEstimated: true
      })
    }
    if (stream.todos?.length) {
      const id = 'cursor:todos'
      const startedAt = seen(id)
      upsert({
        kind: 'tool',
        id,
        toolName: 'todos',
        toolKind: 'todo',
        summary: `待办清单 ${stream.todos.filter((todo) => todo.status === 'completed').length}/${stream.todos.length}`,
        todos: stream.todos,
        status: generating ? 'running' : 'done',
        startedAt,
        completedAt: generating ? undefined : now,
        timingEstimated: true
      })
    }
    const blocks = blockOrder.flatMap((id) => {
      const block = blockById.get(id)
      return block ? [block] : []
    })
    if (!blocks.length) return false
    const fingerprint = JSON.stringify(blocks.map((block) => [
      block.id,
      block.status,
      block.kind === 'thinking'
        ? `${block.text.length}:${block.durationMs ?? ''}`
        : block.kind === 'message'
          ? block.text.length
        : block.kind === 'tool'
          ? `${block.summary ?? ''}:${block.output ?? ''}:${block.error ?? ''}:${JSON.stringify(block.input ?? {})}:${JSON.stringify(block.todos ?? [])}`
          : ''
    ]))
    if (previous?.fingerprint === fingerprint && sameTurn) {
      // 心跳续命：长工具执行（>8s 无新输出）期间提取内容不变，fingerprint 命中
      // 早退——但必须刷新 entry 时效戳，否则 mergeLiveCursorProcess 按 8s 时效
      // 误撤、过程卡在执行中途凭空消失。view 引用保持恒定（内容未变，快照指纹
      // 与渲染层 memo 不受扰动）。
      if (previous && generating && previous.updatedAt < now) {
        this.liveCursorProcess.set(channelId, { ...previous, updatedAt: now })
      }
      return false
    }
    this.liveCursorProcess.set(channelId, {
      view: {
        turn,
        blocks,
        startedAt: sameTurn && previous ? previous.view.startedAt : now,
        updatedAt: now
      },
      fingerprint,
      generating,
      updatedAt: now,
      blockFirstSeen
    })
    return true
  }

  private updateLiveAgentResponse(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean {
    const responseId = evidence.responseId?.trim()
    // composer DOM 文本同样可能含工具调用标记泄漏（生成缺陷）；实时层只展示
    // 截断后的干净前缀，断流恢复由转录侧 interrupted 条目触发（回合确已结束）。
    const responseText = sanitizeModelGeneratedText(evidence.responseText ?? '').text
    const existing = this.liveAgentResponses.get(channelId)
    if (evidence.state === 'stopped') {
      return this.liveAgentResponses.delete(channelId)
    }
    if (evidence.isGenerating && responseId) {
      this.liveAgentResponses.set(channelId, {
        id: responseId,
        channelId,
        text: responseText,
        status: 'streaming',
        startedAt: existing?.id === responseId ? existing.startedAt : evidence.observedAt,
        updatedAt: evidence.observedAt
      })
      const next = this.liveAgentResponses.get(channelId)!
      return !existing
        || existing.id !== next.id
        || existing.text !== next.text
        || existing.status !== next.status
    }
    if (existing && responseId === existing.id) {
      // 只在首次结束时固定 completed 时间；后续 getStatus 仍会返回 lastAiText，
      // 不能不断续命导致最终 record_reply 到来前实时层永不消失。
      if (existing.status === 'streaming') {
        this.liveAgentResponses.set(channelId, {
          ...existing,
          text: responseText || existing.text,
          status: 'complete',
          updatedAt: evidence.observedAt
        })
        return true
      }
    }
    return false
  }

  private liveAgentResponseSnapshot(snapshot: DesktopSnapshot): Record<string, LiveAgentResponseState> | undefined {
    const now = Date.now()
    const result: Record<string, LiveAgentResponseState> = {}
    for (const [channelId, response] of this.liveAgentResponses) {
      const finalized = snapshot.conversations[channelId]?.some((entry) => (
        entry.role === 'assistant'
        && entry.status === 'complete'
        && entry.timestamp >= response.startedAt - 5_000
        && entry.text.trim() === response.text.trim()
      ))
      const stale = response.status === 'streaming'
        ? now - response.updatedAt > 2_500
        : now - response.updatedAt > 3_000
      if (finalized || stale) {
        this.liveAgentResponses.delete(channelId)
        continue
      }
      result[channelId] = response
    }
    return Object.keys(result).length ? result : undefined
  }

  dispose(): void {
    this.stopWatcher()
    if (this.runtimeSignalTimer) clearTimeout(this.runtimeSignalTimer)
    this.runtimeSignalTimer = undefined
    this.pendingRuntimeSignals.clear()
    this.unsubscribeBridge()
    this.unsubscribeTeam()
    this.unsubscribeRelay?.()
    this.listeners.clear()
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
