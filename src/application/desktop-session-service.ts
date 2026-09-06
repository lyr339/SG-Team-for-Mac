import type { AgentSession, AgentExecutionProfile } from '../domain/agent-session'
import { sanitizeModelDisplayText } from '../domain/model-output-sanitizer'
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
  NativeProcessStreamStatus,
  SendMessageAccepted,
  SendMessageInput
} from '../shared/desktop-api'
import { conversationTextIdentity, type ProcessBlock } from '../domain/conversation-entry'
import { partitionVirtualProcessBlocks } from '../domain/virtual-process-turn'
import type { CursorComposerTelemetrySource } from '../infrastructure/cursor/cursor-composer-telemetry'
import type { ChannelMessageRelay } from './channel-message-relay'
import type { CursorComposerRuntimeEvidence, CursorProcessStream } from '../infrastructure/cursor/cursor-cdp-session-creator'
import type { CursorNativeProcessEvent } from '../infrastructure/cursor/cursor-stream-observer'
import { verifyAgentRuntime } from './verify-agent-runtime'

// 持久遥测只负责会话索引/上下文/变更统计；过程流由 sgTeamProcess 原生事件承担。
const DEFAULT_TELEMETRY_POLL_MS = 250
/** 空闲档（无活跃 TeamRun）：遥测降频到 10s——没有活跃 Agent 时没有可刷新的内容。 */
const IDLE_TELEMETRY_POLL_MS = 10_000
const COMPOSER_SCOPE_CLOCK_SKEW_MS = 5_000

function processRevisionKey(value: unknown): string {
  const text = JSON.stringify(value)
  let hash = 2_166_136_261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(36)
}

function processBlocksFingerprint(blocks: ProcessBlock[]): string {
  return JSON.stringify(blocks.map((block) => [
    block.id,
    block.status,
    block.kind === 'thinking'
      ? `${processRevisionKey(block.text)}:${block.durationMs ?? ''}`
      : block.kind === 'message'
        ? processRevisionKey(block.text)
        : block.kind === 'tool'
          ? processRevisionKey({
              summary: block.summary, output: block.output, error: block.error,
              input: block.input, todos: block.todos
            })
          : processRevisionKey(block)
  ]))
}

/**
 * 会话传输层契约：快照已经包含内嵌通道的会话与 presence（LocalSessionBridge 在此
 * 合并 relay 数据），其事件覆盖 relay 的全部变化（回复落库、投递回填、presence 翻转）。
 * DesktopSessionService 不再二次合并 relay，只在其上叠加遥测与直播投影。
 */
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

/**
 * CDP 轮询捎带的回合用量出口（turnTokenUsage 同源值）。
 * 独立于事件通道：注入方决定聚合语义（覆盖），此处只做转发。
 */
export type TurnUsageSink = (input: {
  composerId: string
  usage: NonNullable<CursorComposerRuntimeEvidence['usage']>
  observedAt: number
}) => void

/**
 * 遥测落盘态的上下文读数出口（`state.vscdb` composerData.contextTokensUsed，
 * 即 Cursor 自家「Context: X%」同源）。持续对话模式下回合永不结束，turnEnded /
 * turnTokenUsage 恒空，CDP 读到的内存态 contextTokensUsed 在当前 Cursor 版本
 * 也恒空——这条落盘读数是长会话里唯一持续刷新的请求级活水，喂给用量聚合器的
 * 请求级采样通道即可实现近实时 TOKENS/COST（刷新率 = 遥测轮询 250ms + 聚合器
 * 800ms 节流；滞后上限由 Cursor 落盘频率决定）。注入方负责与 CDP 采样源互斥。
 */
export type ContextUsageSampleSink = (input: {
  composerId: string
  used: number
  observedAt: number
}) => void

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
      telemetryChannelComposerId: channelComposerId,
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
  private emitScheduled = false
  private disposed = false
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
  private readonly pendingNativeProcessByComposer = new Map<string, CursorNativeProcessEvent>()
  private runtimeSignalTimer?: ReturnType<typeof setTimeout>
  private runtimeEvidence: Record<string, CursorComposerRuntimeEvidence> = {}
  private readonly liveAgentResponses = new Map<string, LiveAgentResponseState>()
  /** 已由 record_reply/会话仓库接管的 Cursor response，防轮询 lastAiText 后重复回灌。 */
  private readonly finalizedLiveResponseIds = new Set<string>()
  /** 首次 runtime inspect 完成前暂缓 transcript 回退，避免页面先显示转录、再切 CDP。 */
  private readonly runtimeInspectedComposerIds = new Set<string>()
  /** Cursor 内存模型直接推送的当前回合过程流。 */
  private readonly liveCursorProcess = new Map<string, {
    view: LiveProcessState
    source: 'native' | 'transcript'
    fingerprint: string
    generating: boolean
    updatedAt: number
    blockFirstSeen: Map<string, number>
  }>()
  /** 已写入回复的原生 block；只保留 Observer 当前 256 项窗口内的交集。 */
  private readonly committedProcessBlockIds = new Map<string, Set<string>>()
  /** Cursor 原生完成回合 FIFO：等待封口到对应回复；支持回复落库延迟与连续多回合。 */
  private readonly nativeProcessArchive = new Map<string, LiveProcessState[]>()
  private nativeProcessStream: NativeProcessStreamStatus = {
    state: 'reconnecting',
    detail: '正在连接 Cursor 原生过程流',
    updatedAt: Date.now()
  }
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
    private readonly runtimeSource?: CursorComposerRuntimeSource,
    private readonly turnUsageSink?: TurnUsageSink,
    private readonly contextUsageSink?: ContextUsageSampleSink
  ) {
    const initialTeam = team.getSnapshot()
    this.activeWorkspaceId = initialTeam.activeWorkspaceId
    this.activeRunId = initialTeam.activeRun?.id
    this.activeRunStatus = initialTeam.activeRun?.status
    if (initialTeam.activeRun?.status === 'completed') this.embeddedRelay?.completeScope()
    // 传输层事件（回复落库、deliveredAt 回填、completeScope、presence 翻转）是封口的
    // 触发源之一：先封口再推送——getSnapshot 本身不触碰 SQLite（阶段 E）。只在这里
    // 响应一次；此前同时订阅 bridge 与 relay，每个 relay 事件会推两份快照，且第一份
    // 尚未封口。
    this.unsubscribeBridge = bridge.subscribe(() => {
      this.sealEmbeddedVirtualProcess()
      this.emit()
    })
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
        this.finalizedLiveResponseIds.clear()
        this.runtimeInspectedComposerIds.clear()
        this.liveCursorProcess.clear()
        this.committedProcessBlockIds.clear()
        this.nativeProcessArchive.clear()
        this.pendingNativeProcessByComposer.clear()
        this.contextUsageByComposer.clear()
        this.refreshTelemetry()
      }
      if (runChanged && !workspaceChanged) {
        this.durationBySession.clear()
        this.liveAgentResponses.clear()
        this.finalizedLiveResponseIds.clear()
        this.runtimeInspectedComposerIds.clear()
        this.liveCursorProcess.clear()
        this.committedProcessBlockIds.clear()
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
    const enriched = enrichDesktopSnapshot(base, this.team.getSnapshot(), this.telemetry)
    const snapshot: DesktopSnapshot = {
      ...enriched,
      nativeProcessStream: this.nativeProcessStream,
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
          // 回复同步守门字段参与指纹：checkMessages 的 290s 自放行只改 presence
          // updated_at（relay 侧指纹含它），此处不列会让视图缓存返回 stale 守门。
          session.pendingOutboundId ?? '',
          session.pendingReplySyncSince ?? '',
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
    const liveAgentResponses = this.liveAgentResponseSnapshot(snapshot)
    const withResponses = liveAgentResponses ? { ...snapshot, liveAgentResponses } : snapshot
    return this.applyLiveCursorProcess(withResponses)
  }

  setNativeProcessStreamStatus(status: NativeProcessStreamStatus): void {
    if (status.state === this.nativeProcessStream.state && status.detail === this.nativeProcessStream.detail) return
    this.nativeProcessStream = { ...status }
    this.emit()
  }

  /**
   * Cursor 原生当前回合直接成为唯一 liveProcess 来源。
   *
   * 直播视图是「当前原生回合 − 已封口块」的稳定投影，只在封口（sealChannelVirtualProcess
   * 撤下已持久化块）、原生 turn 切换、TeamRun/工作区切换时收缩；不再按启发式丢弃：
   * - 旧版「下一条用户消息到来即撤下」：持续会话的原生 turn 贯穿整个会话，下一帧
   *   （权威全量快照）会把整批块原样送回来，结果就是用户一发消息过程卡整体消失、
   *   几秒后 Agent 取走消息开始写入时又整体重现；虚拟回合分段已按 deliveredAt 把旧块
   *   锚在旧消息上，本无需删除。
   * - 旧版「生成中 8s 无帧即撤下」：observer 只在 Cursor 写入时推帧，长命令/长思考
   *   期间没有写入，卡片会先消失再在下一次写入时整体重现（闪烁）。
   * transcript 兜底视图被持久化过程取代时仍撤下（它只是无 CDP 时的低保真回退）。
   */
  private applyLiveCursorProcess(snapshot: DesktopSnapshot): DesktopSnapshot {
    const liveProcess: Record<string, LiveProcessState> = {}
    for (const [channelId, state] of this.liveCursorProcess) {
      const entries = snapshot.conversations[channelId] ?? []
      const latestAssistant = [...entries].reverse().find((entry) => (
        entry.role === 'assistant' && entry.status === 'complete'
      ))
      const transcriptSuperseded = state.source === 'transcript' && Boolean(latestAssistant?.processBlocks?.length)
      const persisted = entries.some((entry) => (
        entry.role === 'assistant'
        && entry.status === 'complete'
        && entry.turn === state.view.turn
        && Boolean(entry.processBlocks?.length)
      ))
      if (transcriptSuperseded || persisted) {
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


  /**
   * 事件驱动封口（阶段 E，RC-7）：把「虚拟回合过程 → 已落库回复」的持久化从
   * getSnapshot() 移出，改为由过程帧事件（notifyNativeProcessSnapshot /
   * refreshRuntimeEvidence）与 relay 事件（回复落库、deliveredAt 回填、
   * completeScope）触发。getSnapshot() 从此对 SQLite 零写入（§8.4-2）。
   *
   * 封口语义：
   * - 定位：outboundId 精确关联（replyToEntryId）的回复即关闭边界；
   * - 结算：封口时仍为 running 的前置块结算为完成态（完成时间 = 回复时间，§E.3）；
   * - 不可变：已封口为 done/failed 的块不再被后续帧重写——同会话与重启后均
   *   字节稳定（§8.4-1/3）；仅 running 遗留（旧版封口数据）允许刷新自愈；
   * - 补块：迟到的前置块（关闭边界前开始、稍后才出现在帧里）追加封存——
   *   这是 §E.7「由下一过程事件完成封口」的落地，不引入任何固定延迟；
   * - 防回流：只在其它回复上的块跳过（Cursor 256 窗口回流不二次持久化）。
   */
  private sealEmbeddedVirtualProcess(): boolean {
    if (!this.embeddedRelay) return false
    let changed = false
    for (const channelId of new Set([...this.liveCursorProcess.keys(), ...this.nativeProcessArchive.keys()])) {
      try {
        if (this.sealChannelVirtualProcess(channelId)) changed = true
      } catch {
        // 单通道封口失败不影响其余通道；归档/直播源仍在，下一事件重试。
      }
    }
    return changed
  }

  /** 单通道封口扫描；返回是否产生持久化或直播视图变化（需要重推快照）。 */
  private sealChannelVirtualProcess(channelId: string): boolean {
    const relay = this.embeddedRelay
    if (!relay || !relay.handlesChannel(channelId)) return false
    const entries = relay.conversationsOf(channelId)
    if (!entries?.length) {
      const archive = this.nativeProcessArchive.get(channelId)?.filter((item) => (
        item.updatedAt >= Date.now() - 30 * 60_000
      ))
      if (archive?.length) this.nativeProcessArchive.set(channelId, archive)
      else this.nativeProcessArchive.delete(channelId)
      return false
    }
    const live = this.liveCursorProcess.get(channelId)
    const sources = new Map<string, LiveProcessState>()
    for (const archived of this.nativeProcessArchive.get(channelId) ?? []) sources.set(archived.turn, archived)
    if (live?.source === 'native') sources.set(live.view.turn, live.view)
    if (!sources.size) return false

    const visibleUserIds = new Set(entries.filter((entry) => entry.role === 'user').map((entry) => entry.id))
    // 跨回复防回流（8.2-6）：已随任一回复持久化的块集合（含本回复——用于
    // 区分「封口块不可变跳过」与「迟到新块补写」）。
    const persistedBlockIds = new Set(entries.flatMap((entry) => (
      entry.processBlocks?.map((block) => block.id) ?? []
    )))
    const sealedIds = new Set<string>()
    const consumedArchiveTurns = new Set<string>()
    let changed = false

    for (const source of sources.values()) {
      let archiveReady = true
      for (const segment of partitionVirtualProcessBlocks(entries, source.blocks, source.startedAt)) {
        if (segment.gap || !segment.anchorEntryId || !segment.blocks.length) continue
        const anchorIndex = entries.findIndex((entry) => entry.id === segment.anchorEntryId)
        if (anchorIndex < 0) {
          archiveReady = false
          continue
        }
        let nextUserIndex = entries.findIndex((entry, index) => index > anchorIndex && entry.role === 'user')
        if (nextUserIndex < 0) nextUserIndex = entries.length
        const explicitReplyIndex = entries.findIndex((entry, index) => (
          index > anchorIndex && index < nextUserIndex
          && entry.role === 'assistant' && entry.replyToEntryId === segment.anchorEntryId
        ))
        const replyIndex = explicitReplyIndex >= 0 ? explicitReplyIndex : entries.findIndex((entry, index) => (
          index > anchorIndex && index < nextUserIndex
          && entry.role === 'assistant'
          && (!entry.replyToEntryId || !visibleUserIds.has(entry.replyToEntryId))
        ))
        if (replyIndex < 0) {
          archiveReady = false
          continue
        }
        const reply = entries[replyIndex]!
        const turn = `${source.turn}:virtual:${segment.anchorEntryId}`
        const compatibleExisting = Boolean(reply.processBlocks?.length
          && reply.turn === turn
          && !reply.turn.startsWith('transcript:'))
        const existingBlocks = compatibleExisting ? reply.processBlocks! : []
        const blockById = new Map(existingBlocks.map((block) => [block.id, block]))
        const blockOrder = existingBlocks.map((block) => block.id)
        const incoming: ProcessBlock[] = []
        // §8.4-4 防线：与回复正文同身份的 message 块不进封口——最终回答只
        // 存在于 reply.content。laterWork 中间帧误判（如 MCP pending 首帧让
        // 尾部 thinking 被当业务思考）会把最终正文判成 cursor-msg，若随封口
        // 持久化，过程卡与正文气泡将渲染同一文本两次（2026-09-03 事故）。
        const replyIdentity = conversationTextIdentity(reply.text)
        for (const block of segment.blocks) {
          if (replyIdentity && block.kind === 'message'
            && conversationTextIdentity(block.text) === replyIdentity) {
            sealedIds.add(block.id)
            continue
          }
          const existing = blockById.get(block.id)
          if (existing) {
            // 封口块不可变：done/failed 跳过写入但仍计入 sealedIds（从直播视图
            // 撤下，防重启后回流帧重复展示）；running 是旧版封口遗留，允许
            // 后续帧刷新为完成态（重启后旧数据自愈迁移）。
            if (existing.status === 'running') incoming.push(block)
            else sealedIds.add(block.id)
            continue
          }
          if (persistedBlockIds.has(block.id)) continue
          incoming.push(block)
        }
        if (!incoming.length) continue
        // §E.3：封口时仍为 running 的前置块结算为完成态（完成时间 = 回复关闭边界）。
        const settled = incoming.map((block): ProcessBlock => (
          block.status === 'running'
            ? { ...block, status: 'done', completedAt: reply.timestamp, timingEstimated: true }
            : block
        ))
        for (const block of settled) {
          if (!blockById.has(block.id)) blockOrder.push(block.id)
          blockById.set(block.id, block)
          sealedIds.add(block.id)
        }
        const persistedBlocks = blockOrder.flatMap((id) => {
          const block = blockById.get(id)
          return block ? [block] : []
        })
        const sameBlocks = reply.processBlocks?.length === persistedBlocks.length
          && reply.processBlocks.every((block, index) => block === persistedBlocks[index])
        if (!sameBlocks || reply.turn !== turn || reply.replyToEntryId !== segment.anchorEntryId) {
          const virtualProcess: LiveProcessState = {
            turn, blocks: persistedBlocks, startedAt: segment.startedAt, updatedAt: source.updatedAt
          }
          if (reply.id.startsWith('reply:')
            && !relay.attachProcessToReply(reply.id, virtualProcess, segment.anchorEntryId)) {
            archiveReady = false
            continue
          }
          changed = true
        }
      }
      if (archiveReady && this.nativeProcessArchive.get(channelId)?.some((item) => item.turn === source.turn)) {
        consumedArchiveTurns.add(source.turn)
      }
    }

    if (sealedIds.size && live?.source === 'native') {
      const committed = this.committedProcessBlockIds.get(channelId) ?? new Set<string>()
      for (const id of sealedIds) committed.add(id)
      this.committedProcessBlockIds.set(channelId, committed)
      const remaining = live.view.blocks.filter((block) => !sealedIds.has(block.id))
      for (const id of sealedIds) live.blockFirstSeen.delete(id)
      if (remaining.length !== live.view.blocks.length) {
        this.liveCursorProcess.set(channelId, {
          ...live,
          view: { ...live.view, blocks: remaining },
          fingerprint: processBlocksFingerprint(remaining)
        })
        changed = true
      }
    }
    const archive = this.nativeProcessArchive.get(channelId)
    if (archive?.length) {
      const expireBefore = Date.now() - 30 * 60_000
      const remaining = archive.filter((item) => (
        !consumedArchiveTurns.has(item.turn) && item.updatedAt >= expireBefore
      ))
      if (remaining.length) this.nativeProcessArchive.set(channelId, remaining)
      else this.nativeProcessArchive.delete(channelId)
    }
    return changed
  }

  private archiveNativeProcess(channelId: string, completed: LiveProcessState): void {
    const queue = this.nativeProcessArchive.get(channelId) ?? []
    const existing = queue.findIndex((item) => item.turn === completed.turn)
    const next = existing >= 0
      ? queue.map((item, index) => index === existing ? completed : item)
      : [...queue, completed].slice(-20)
    this.nativeProcessArchive.set(channelId, next)
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
    const channelId = String(input.channelId ?? '').trim()
    // 一体化分流：内嵌通道直写拾光 SQLite 队列，插件通道维持原 WS 链路
    if (this.embeddedRelay?.handlesChannel(channelId)) {
      // 「等待新会话」保持位 = 席位现任会话令牌：持有它的会话取不到该消息，只有
      // 之后重建出来的新会话（令牌轮换）才收到。渲染层只声明意图，令牌在此换算。
      const { holdUntilNewSession, ...rest } = input
      if (holdUntilNewSession) {
        const token = this.currentSessionToken(channelId)
        if (!token) throw new Error(`CH-${channelId} 当前席位没有会话令牌，无法区分新旧会话；请按普通排队投递`)
        return this.embeddedRelay.sendMessage({ ...rest, holdSessionToken: token })
      }
      return this.embeddedRelay.sendMessage(rest)
    }
    return this.bridge.sendMessage(input)
  }

  /** 席位现任 Cursor 会话的围栏令牌（活动 run 内该通道的 RuntimeBinding）。 */
  currentSessionToken(channelId: string): string | undefined {
    const team = this.team.getSnapshot()
    const runId = team.activeRun?.id
    const binding = team.bindings.find((candidate) => (
      candidate.channelId === channelId && (!runId || candidate.runId === runId)
    ))
    return binding?.sessionToken?.trim() || undefined
  }

  withdrawQueuedMessage(channelId: string, entryId: string): boolean {
    return this.embeddedRelay?.withdrawQueuedMessage(String(channelId).trim(), String(entryId).trim()) ?? false
  }

  releaseQueuedMessage(channelId: string, entryId: string): boolean {
    return this.embeddedRelay?.releaseQueuedMessage(String(channelId).trim(), String(entryId).trim()) ?? false
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

      // Cursor 转录是耐久事实源：即使 record_reply 被身份门禁拒绝、CDP 完成态随后离线，
      // 也要把最后完整回复恢复到会话视图，不能只依赖 3 秒 live map。
      const composerByIdForReplies = new Map(next.composers.map((composer) => [composer.composerId, composer]))
      let transcriptResponseChanged = false
      for (const binding of teamSnapshot.bindings) {
        if (!binding.composerId) continue
        if (this.runtimeSource && !this.runtimeInspectedComposerIds.has(binding.composerId)) continue
        const response = composerByIdForReplies.get(binding.composerId)?.lastAssistantResponse
        const responsePersisted = Boolean(response
          && this.embeddedRelay?.hasPersistedAssistantText(binding.channelId, response.text))
        // 已落库的回复不再走转录兜底：record_reply 成功后转录每次写盘（含
        // Agent 的 check_messages 轮询）都会更新 mtime，过去会以新 id 反复回灌
        // 同一回复，且 finalize 时间窗对新 mtime 恒不命中 → 「正在归档…」永挂。
        if (response && !responsePersisted) {
          transcriptResponseChanged = this.updateLiveAgentResponse(binding.channelId, {
            composerId: binding.composerId,
            state: 'unknown',
            detail: 'Cursor 转录完整回复',
            observedAt: response.observedAt,
            isGenerating: false,
            responseId: response.id,
            responseText: response.text
          }) || transcriptResponseChanged
        }
        const process = composerByIdForReplies.get(binding.composerId)?.lastAssistantProcess
        if (process?.blocks.length && !responsePersisted && !this.liveCursorProcess.has(binding.channelId)) {
          const turn = `transcript:${binding.composerId}:${Math.round(process.observedAt)}`
          const view: LiveProcessState = {
            turn,
            // 首次观测时间盖章（8.2-6）：转录兜底块没有原生 startedAt，若沿用
            // mtime 回退，check_messages 轮询持续刷新 mtime 会让旧块在重连水合
            // 后被挪进新投递消息的回合。以本服务首次观测时刻为稳定边界。
            blocks: process.blocks.map((block) => (
              block.startedAt === undefined ? { ...block, startedAt: process.observedAt } : block
            )),
            startedAt: process.observedAt,
            updatedAt: process.observedAt,
            // 转录兜底是历史恢复快照，不是进行中的生成：不参与打字机播放。
            generating: false
          }
          this.liveCursorProcess.set(binding.channelId, {
            view,
            source: 'transcript',
            fingerprint: JSON.stringify(process.blocks.map((block) => [block.id, block.status])),
            generating: false,
            updatedAt: process.observedAt,
            blockFirstSeen: new Map(process.blocks.map((block) => [block.id, process.observedAt]))
          })
          transcriptResponseChanged = true
        }
      }

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
      if (changed || transcriptResponseChanged) this.emit()
      // 用量采样不依赖 changed 分支（记账语义独立于快照推送），也不进 getSnapshot()：
      // 每次成功刷新都把已绑定 Composer 的落盘上下文读数交给聚合器，同值由
      // applyRequestSample 去重，零额外轮询。
      this.forwardContextUsageSamples(teamSnapshot.bindings, composerByIdForReplies)
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

  /** 遥测刷新后的用量采样转发：只转发已绑定 Composer 的有效正读数，转发失败不影响遥测主链。 */
  private forwardContextUsageSamples(
    bindings: RuntimeBinding[],
    composerById: Map<string, CursorComposerTelemetry>
  ): void {
    if (!this.contextUsageSink) return
    const observedAt = Date.now()
    for (const binding of bindings) {
      if (!binding.composerId) continue
      const used = composerById.get(binding.composerId)?.contextUsage?.used
      if (typeof used !== 'number' || !Number.isFinite(used) || used <= 0) continue
      try {
        this.contextUsageSink({ composerId: binding.composerId, used, observedAt })
      } catch {
        // 用量聚合异常不得打断遥测/活性主链。
      }
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
        for (const binding of bindings) {
          if (binding.composerId) this.runtimeInspectedComposerIds.add(binding.composerId)
        }
        let liveChanged = false
        for (const binding of bindings) {
          if (!binding.composerId) continue
          const live = evidence[binding.composerId]
          if (live?.state === 'stopped') {
            this.embeddedRelay?.markCursorStopped(binding.channelId, live.observedAt)
          }
          if (live?.state === 'active') {
            // P0-1：生成中的 CDP 证据写回 presence（runtimeActiveAt）——长任务
            // （>5min shell/推理）期间 MCP 心跳停刷，此前该证据只停留在内存
            // telemetry，processing 窗口 5 分钟后照样误判离线。
            this.embeddedRelay?.noteRuntimeActivity(binding.channelId, live.observedAt)
          }
          if (live) {
            liveChanged = this.updateLiveAgentResponse(binding.channelId, live) || liveChanged
            liveChanged = this.updateLiveCursorProcess(binding.channelId, live) || liveChanged
            // 用量捎带：轮询快照与事件同源，交给注入方做覆盖式聚合。
            if (live.usage) {
              try {
                this.turnUsageSink?.({ composerId: binding.composerId, usage: live.usage, observedAt: live.observedAt })
              } catch { /* 用量转发失败不影响活性/过程主链 */ }
            }
          }
        }
        // inspect 证据可能携带过程载荷（旧路径）/触发直播收尾：先封口再判定推送。
        const sealed = this.sealEmbeddedVirtualProcess()
        const fingerprint = JSON.stringify(evidence, RUNTIME_EVIDENCE_FINGERPRINT_REPLACER)
        if (fingerprint === JSON.stringify(this.runtimeEvidence, RUNTIME_EVIDENCE_FINGERPRINT_REPLACER)) {
          if (liveChanged || sealed) this.emit()
          return
        }
        this.runtimeEvidence = evidence
        const next = applyRuntimeEvidence(this.telemetry, evidence)
        if (next !== this.telemetry) {
          this.telemetry = next
          this.telemetryFingerprint = ''
          this.emit()
        } else if (liveChanged || sealed) {
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
  notifyNativeProcessSnapshot(event: CursorNativeProcessEvent): void {
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

  private applyNativeProcessSnapshot(channelId: string, event: CursorNativeProcessEvent): void {
    const evidence: CursorComposerRuntimeEvidence = {
      composerId: event.composerId,
      state: event.isGenerating ? 'active' : 'unknown',
      detail: event.isGenerating ? 'Cursor 原生过程事件正在推送' : 'Cursor 原生过程回合已结束',
      observedAt: event.observedAt,
      isGenerating: event.isGenerating,
      process: event.process
    }
    let changed = this.updateLiveCursorProcess(channelId, evidence, { authoritative: true })
    // 直播正文的撤下路径：正文候选被改判为中间过程时立即收回（见方法注释）。
    if (event.process && this.revokeReclassifiedLiveResponse(channelId, event.process)) changed = true
    // 写后快照携带的流式正文：与 inspect 轮询同一 responseId（bubbleId），走同一
    // 合并入口；粒度对齐 Cursor 原生 token 批次，打字机不再吃 150–250ms 粗 chunk。
    if (event.response) {
      changed = this.updateLiveAgentResponse(channelId, {
        ...evidence,
        responseId: event.response.id,
        responseText: event.response.text
      }) || changed
    }
    if (!event.isGenerating) {
      const completed = this.liveCursorProcess.get(channelId)?.view
      if (completed?.blocks.length) this.archiveNativeProcess(channelId, completed)
    }
    // 过程帧事件驱动封口（阶段 E）：回复先落库时由本帧完成封口/补块。
    const sealed = this.sealEmbeddedVirtualProcess()
    if (changed || sealed) this.emit()
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
   * 生成结束后保留至持久化回复或下一用户回合接管，随后由 nativeProcessArchive
   * 贴到 Agent 回复。
   */
  private updateLiveCursorProcess(
    channelId: string,
    evidence: CursorComposerRuntimeEvidence,
    options: { authoritative?: boolean } = {}
  ): boolean {
    const changed = this.mergeProcessEvidence(channelId, evidence, options.authoritative === true)
    if (changed) {
      // 阶段 E：过程帧落位（新增内容/收尾/权威空集撤回）立即封口——observer
      // 事件、inspect 证据与测试注入统一经此触发持久化；getSnapshot 零写入。
      this.sealEmbeddedVirtualProcess()
    }
    return changed
  }

  /**
   * 不携带过程载荷、且声称「未在生成」的证据是否有资格结束直播回合。
   * observer（authoritative）帧的终结语义可信；runtime inspect 的 isGenerating 来自
   * 桥接层 composer 摘要，与 composer 数据模型可能短暂不一致——若每 150ms 一次
   * 的 inspect 在 observer 帧之间把回合判成结束，running 块会在 done/running 之间
   * 往复、`实时` 标记闪烁、completedAt 被反复盖章。规则：observer 在线且直播视图
   * 来自 observer 时，inspect 不参与生命周期；observer 离线时才由 inspect 兜底，
   * 且要求该视图已 2s 没有任何帧/心跳刷新。
   */
  private inspectMayEndTurn(
    previous: { source: 'native' | 'transcript'; updatedAt: number },
    observedAt: number
  ): boolean {
    if (this.nativeProcessStream.state === 'connected' && previous.source === 'native') return false
    return observedAt - previous.updatedAt >= 2_000
  }

  private mergeProcessEvidence(
    channelId: string,
    evidence: CursorComposerRuntimeEvidence,
    authoritative: boolean
  ): boolean {
    if (evidence.state === 'stopped') {
      const previous = this.liveCursorProcess.get(channelId)
      if (!previous || !previous.generating) return false
      const blocks = previous.view.blocks.map((block) => block.status === 'running'
        ? { ...block, status: 'done' as const, completedAt: evidence.observedAt }
        : block)
      const view: LiveProcessState = {
        ...previous.view,
        blocks,
        updatedAt: evidence.observedAt,
        generating: false
      }
      this.liveCursorProcess.set(channelId, {
        ...previous,
        view,
        fingerprint: JSON.stringify(blocks.map((block) => [block.id, block.status, block.completedAt ?? ''])),
        generating: false,
        updatedAt: evidence.observedAt
      })
      this.archiveNativeProcess(channelId, view)
      return true
    }
    const stream = evidence.process
    if (!stream) {
      // runtime inspect 设计上只携带状态/正文，不携带 observer 的过程载荷；
      // isGenerating=true 时缺 process 只表示“本帧没有过程”，必须保留上一帧。
      if (evidence.isGenerating === true) {
        const previous = this.liveCursorProcess.get(channelId)
        if (previous?.generating && previous.updatedAt < evidence.observedAt) {
          this.liveCursorProcess.set(channelId, { ...previous, updatedAt: evidence.observedAt })
        }
        return false
      }
      // 明确生成已结束（最后一帧可能只携带终止标记）：把仍为 running 的观测块
      // 原子收尾后归档，避免历史过程永久显示“进行中”。
      const previous = this.liveCursorProcess.get(channelId)
      if (previous?.generating && !authoritative && !this.inspectMayEndTurn(previous, evidence.observedAt)) {
        return false
      }
      if (previous?.generating) {
        const blocks = previous.view.blocks.map((block) => block.status === 'running'
          ? { ...block, status: 'done' as const, completedAt: evidence.observedAt }
          : block)
        const view: LiveProcessState = {
          ...previous.view,
          blocks,
          updatedAt: evidence.observedAt,
          generating: false
        }
        this.liveCursorProcess.set(channelId, {
          ...previous,
          view,
          fingerprint: JSON.stringify(blocks.map((block) => [block.id, block.status, block.completedAt ?? ''])),
          generating: false,
          updatedAt: evidence.observedAt
        })
        this.archiveNativeProcess(channelId, view)
        return true
      }
      return false
    }
    const now = evidence.observedAt
    const previous = this.liveCursorProcess.get(channelId)
    const generating = evidence.isGenerating === true || stream.generatingBubbleCount > 0
    const rawStreamItems = stream.items.map((item) => item.id === 'cursor:plan'
      ? { ...item, id: `cursor:plan:${processRevisionKey({
          summary: item.kind === 'tool' ? item.summary : '',
          input: item.kind === 'tool' ? item.input : undefined
        })}` }
      : item)
    const todoId = stream.todos?.length
      ? `cursor:todos:${processRevisionKey(stream.todos)}`
      : undefined
    const rawIncomingIds = new Set(rawStreamItems.map((item) => item.id))
    if (todoId) rawIncomingIds.add(todoId)
    const overlapsPrevious = previous?.view.blocks.some((block) => rawIncomingIds.has(block.id)) === true
    const nativeTurn = stream.turnId ? `cursor:${stream.turnId}` : undefined
    // 优先使用 Cursor 原生 user bubble id。仅旧版事件缺 turnId 时回退重叠判断。
    const sameTurn = previous !== undefined && (nativeTurn
      ? previous.view.turn === nativeTurn
      : previous.generating || overlapsPrevious)
    const turn = nativeTurn ?? (sameTurn && previous ? previous.view.turn : `cursor:${now}`)
    if (!sameTurn) {
      // 回合切换且上一 turn 仍在生成（中断场景：没有 !generating 终结帧）——
      // 先进 FIFO 归档，迟到的 record_reply 仍可从归档完成封口，过程不随直播
      // 视图替换而丢失。非生成态视图已由收尾路径归档（upsert 幂等）；transcript
      // 兜底视图 generating=false，天然不进该分支。
      if (previous?.generating && previous.view.blocks.length) {
        this.archiveNativeProcess(channelId, previous.view)
      }
      this.committedProcessBlockIds.delete(channelId)
    }
    const committed = this.committedProcessBlockIds.get(channelId)
    if (committed) {
      for (const id of committed) if (!rawIncomingIds.has(id)) committed.delete(id)
      if (!committed.size) this.committedProcessBlockIds.delete(channelId)
    }
    const activeCommitted = this.committedProcessBlockIds.get(channelId)
    const streamItems = activeCommitted
      ? rawStreamItems.filter((item) => !activeCommitted.has(item.id))
      : rawStreamItems
    const includeTodos = Boolean(todoId && !activeCommitted?.has(todoId))
    const blockFirstSeen = sameTurn && previous
      ? previous.blockFirstSeen
      : new Map<string, number>()
    const blockById = new Map<string, ProcessBlock>()
    const blockOrder: string[] = []
    // 上一帧全部块的查找表：权威帧会先清空再按本帧重建顺序，但 completedAt 等
    // 「首次观测即定格」的字段必须能从上一帧继承。
    const previousById = new Map<string, ProcessBlock>(
      sameTurn && previous ? previous.view.blocks.map((block) => [block.id, block] as const) : []
    )
    if (sameTurn && previous) {
      // 权威帧（snapshotComplete，observer 写后快照）：本帧集合即当前回合可见
      // 窗口的权威状态，缺席块撤下——「部分水合 MCP 占位 → 完整水合后被过滤」
      // 的旧占位块由此撤回；截断帧只保护窗口外历史（startedAt 早于本帧窗口
      // 起点），窗口内仍以当前帧为准。非权威帧（旧版 hook / inspect 兜底）维持
      // 追加合并语义。
      const authoritative = stream.snapshotComplete === true
      const windowStart = authoritative && stream.truncatedItemCount
        ? rawStreamItems.reduce<number | undefined>((oldest, item) => (
            typeof item.startedAt === 'number' && item.startedAt > 0
              && (oldest === undefined || item.startedAt < oldest)
              ? item.startedAt
              : oldest
          ), undefined)
        : undefined
      for (const block of previous.view.blocks) {
        // plan/todos 是当前 Composer 全局快照，不是追加日志；每帧先移除旧版本，
        // 再按本帧内容写回，避免清空后残留或后续回合仍黏在第一次出现的位置。
        if (block.id.startsWith('cursor:todos:') || block.id.startsWith('cursor:plan:')) continue
        if (authoritative) {
          // 完整权威帧：缺席即撤下。
          if (!stream.truncatedItemCount) continue
          // 截断帧：窗口起点可判定时只保留窗口外历史；不可判定（帧内项全部缺
          // startedAt）fail-open 保留旧块——误撤历史的不可恢复性高于暂留噪声。
          if (windowStart !== undefined && (block.startedAt ?? Number.POSITIVE_INFINITY) >= windowStart) continue
        }
        blockById.set(block.id, block)
        blockOrder.push(block.id)
      }
    }
    const upsert = (block: ProcessBlock): void => {
      if (!blockById.has(block.id)) blockOrder.push(block.id)
      const existing = blockById.get(block.id) ?? previousById.get(block.id)
      if (!existing) {
        blockById.set(block.id, block)
        return
      }
      // 已收尾块的 completedAt 只盖一次章：本帧 now 是采样时刻不是完成时刻，若每帧
      // 覆盖，所有已完成步骤的「~Ns」时长会随回合推进持续增长（过程卡数字抖动）。
      const settled = existing.status !== 'running' && block.status !== 'running'
      blockById.set(block.id, {
        ...block,
        startedAt: existing.startedAt ?? block.startedAt,
        completedAt: settled ? existing.completedAt ?? block.completedAt : block.completedAt
      })
    }
    const seen = (id: string, nativeStartedAt?: number): number => {
      const existing = blockFirstSeen.get(id)
      if (existing !== undefined) return existing
      const at = nativeStartedAt && Number.isFinite(nativeStartedAt) && nativeStartedAt > 0
        ? nativeStartedAt
        : now
      blockFirstSeen.set(id, at)
      return at
    }
    for (const [index, item] of streamItems.entries()) {
      const startedAt = seen(item.id, item.startedAt)
      if (item.kind === 'thinking') {
        // 直播尾部 Thinking 的 done 逐帧抖动：Cursor 在两次写入之间会把该 bubble 暂时
        // 移出 generatingBubbleIds，observer 照抄成 done，下一帧又回到 running。若原样
        // 投影，头部会在「• thinking」与「for ~Ns」之间来回换元素、completedAt 反复盖章
        // ——用户看到的就是「每来一段新内容就闪一下」。规则：回合仍在生成、该块仍是过程
        // 尾部、上一帧为 running 且没有原生 thinkingDurationMs 时，本帧的 done 视为抖动
        // 保持 running；真正收尾由「其后出现新块 / 原生时长到达 / 回合停止生成」之一决定。
        const heldRunning = generating
          && index === streamItems.length - 1
          && item.status === 'done'
          && item.durationMs === undefined
          && previousById.get(item.id)?.status === 'running'
        const status = heldRunning
          ? 'running'
          : !generating && item.status === 'running' ? 'done' : item.status
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
    if (stream.todos?.length && includeTodos) {
      const id = todoId!
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
    if (!blocks.length) {
      // 权威空快照：当前回合可见过程确实为空（如整轮只有被过滤的内部协议
      // 噪声）——撤下旧块而非保留。非权威空帧维持原语义（本帧没有过程载荷，
      // 保留上一帧）。turn 切换语义与既有行为一致：不留旧 turn 孤儿块。
      if (stream.snapshotComplete === true && previous) {
        this.liveCursorProcess.delete(channelId)
        return true
      }
      return false
    }
    const fingerprint = processBlocksFingerprint(blocks)
    if (previous?.fingerprint === fingerprint && sameTurn) {
      // 心跳续命/生成翻转：长工具执行（>8s 无新输出）期间提取内容不变，
      // fingerprint 命中早退——但必须刷新 entry 时效戳（否则 8s 时效误撤），
      // 且 generating 翻转（终结帧）时同步 view，直播标记不得悬挂到时效清除。
      // view 引用在内容未变时保持恒定（除 generating 字段外）。
      if (previous && (generating !== previous.generating || (generating && previous.updatedAt < now))) {
        this.liveCursorProcess.set(channelId, {
          ...previous,
          view: previous.view.generating === generating
            ? previous.view
            : { ...previous.view, generating },
          updatedAt: now
        })
      }
      return false
    }
    this.liveCursorProcess.set(channelId, {
      view: {
        turn,
        blocks,
        truncatedItemCount: stream.truncatedItemCount,
        startedAt: sameTurn && previous ? previous.view.startedAt : now,
        updatedAt: now,
        // RC-9：生成状态随 view 下发——渲染层据此识别「全部块已 done 但仍在
        // 生成」的直播过程（Cursor 常把生成中的 Thinking 标记为 done），
        // 不再靠「某块 running」猜测而误跳打字机播放器。
        generating
      },
      source: 'native',
      fingerprint,
      generating,
      updatedAt: now,
      blockFirstSeen
    })
    return true
  }

  /**
   * 直播正文的撤下路径（2026-09-04 双打字机事故）。
   *
   * 「最终正文候选」不是气泡的固有属性，而是「其后没有业务工作」这一相对判定：
   * 模型先写正文 B1 再调用业务工具时，B1 会从最终候选改判为中间过程 message
   * （processSnapshot 把它放进 items 的 cursor-msg:B1），写后快照随之不再携带
   * response。此前 updateLiveAgentResponse 只有建立/推进路径，把「不携带」一律当
   * 「本帧无信息」保留旧值——这对 inspect 等不带正文的帧是必要的，但对改判场景意味着
   * 同一段文字同时以 cursor-msg（过程卡，新打字机从头播放）和直播正文（TurnResponseText，
   * 带光标）双份出现，直到 2.5s 流式断帧时效才把后者清掉。
   *
   * 撤下只认正面证据：权威完整帧（snapshotComplete）里出现了 `cursor-msg:<直播正文 id>`
   * ——同一 bubble 已被过程卡接管。缺席、空文本抖动、非权威帧都不触发，避免误撤闪烁。
   * 不写入 finalizedLiveResponseIds：若后续帧撤回该 cursor-msg（该 bubble 重新成为
   * 最终候选），直播正文照常恢复。
   */
  private revokeReclassifiedLiveResponse(channelId: string, stream: CursorProcessStream): boolean {
    if (stream.snapshotComplete !== true) return false
    const existing = this.liveAgentResponses.get(channelId)
    if (!existing || existing.id.startsWith('transcript:')) return false
    const reclassifiedId = `cursor-msg:${existing.id}`
    if (!stream.items.some((item) => item.kind === 'message' && item.id === reclassifiedId)) return false
    this.liveAgentResponses.delete(channelId)
    return true
  }

  private updateLiveAgentResponse(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean {
    const responseId = evidence.responseId?.trim()
    // composer DOM 文本同样可能含工具调用标记泄漏（生成缺陷）；实时层只展示
    // 截断后的干净前缀，断流恢复由转录侧 interrupted 条目触发（回合确已结束）。
    const responseText = sanitizeModelDisplayText(evidence.responseText ?? '').text
    const existing = this.liveAgentResponses.get(channelId)
    const incomingIsTranscript = responseId?.startsWith('transcript:') === true
    const existingIsTranscript = existing?.id.startsWith('transcript:') === true
    // 同一完成回合有两个观测源：Cursor CDP 的真实可见正文 + transcript 耐久回退。
    // transcript 每个 250ms 遥测 tick 都会重放；若它覆盖 CDP，下一次 runtime inspect
    // 又覆盖回来，就形成截图中的两种排版闪烁。优先级固定为 streaming > CDP complete
    // > transcript complete；transcript 只在没有 CDP 完成态时兜底。
    if (incomingIsTranscript && existing && !existingIsTranscript) return false
    // 完成态只允许时间单调前进。Cursor 重启水合期间 team/telemetry 快照会短暂错拍，
    // 较旧 Composer 的 transcript 若晚到，过去会覆盖当前通道再被纠正，形成闪烁。
    if (!evidence.isGenerating && existing?.status === 'complete'
      && responseId && existing.id !== responseId
      && evidence.observedAt <= existing.updatedAt) return false
    if (evidence.state === 'stopped') {
      if (!existing) return false
      if (existing.status === 'complete') return false
      this.liveAgentResponses.set(channelId, {
        ...existing,
        text: responseText || existing.text,
        status: 'complete',
        updatedAt: evidence.observedAt
      })
      return true
    }
    if (responseId && this.finalizedLiveResponseIds.has(responseId)) return false
    // 同一回复的迟到短帧（inspect 往返慢于写后直推 / 写信号与轮询交错）：流式
    // 正文是追加式的，严格前缀的较短读数只可能是过期帧——丢弃，否则渲染层播放器
    // 会看到文本回退而整体重对齐（打字机闪断）。非前缀的变短是真实改写，照常接受。
    if (existing && responseId === existing.id && existing.status === 'streaming'
      && responseText.length < existing.text.length && existing.text.startsWith(responseText)) return false
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
    if (!evidence.isGenerating && responseId && responseText && (!existing || existing.id !== responseId)) {
      this.liveAgentResponses.set(channelId, {
        id: responseId,
        channelId,
        text: responseText,
        status: 'complete',
        startedAt: evidence.observedAt,
        updatedAt: evidence.observedAt
      })
      return true
    }
    return false
  }

  private liveAgentResponseSnapshot(snapshot: DesktopSnapshot): Record<string, LiveAgentResponseState> | undefined {
    const now = Date.now()
    const result: Record<string, LiveAgentResponseState> = {}
    for (const [channelId, response] of this.liveAgentResponses) {
      // 转录兜底是历史恢复：按文本身份判定 finalize（其 startedAt 是转录 mtime，
      // 恒新于落库回复，时间窗永不命中）。CDP 来源维持原时间窗 + 精确文本。
      const transcriptSourced = response.id.startsWith('transcript:')
      const finalized = snapshot.conversations[channelId]?.some((entry) => (
        entry.role === 'assistant'
        && entry.status === 'complete'
        && (transcriptSourced
          ? conversationTextIdentity(entry.text) === conversationTextIdentity(response.text)
          : entry.timestamp >= response.startedAt - 5_000 && entry.text.trim() === response.text.trim())
      ))
      // completed Cursor 原生回复在 record_reply 落库前就是唯一历史来源；此前 3s
      // 自动删除导致截图中的回复/过程“过一会消失”。仅流式断帧做时效清理，完成态
      // 保留到持久化回复接管或 TeamRun/工作区切换。
      const stale = response.status === 'streaming' && now - response.updatedAt > 2_500
      if (finalized || stale) {
        this.liveAgentResponses.delete(channelId)
        if (finalized) {
          this.finalizedLiveResponseIds.add(response.id)
          if (this.finalizedLiveResponseIds.size > 200) {
            const oldest = this.finalizedLiveResponseIds.values().next().value
            if (oldest) this.finalizedLiveResponseIds.delete(oldest)
          }
        }
        continue
      }
      result[channelId] = response
    }
    return Object.keys(result).length ? result : undefined
  }

  dispose(): void {
    this.disposed = true
    this.stopWatcher()
    if (this.runtimeSignalTimer) clearTimeout(this.runtimeSignalTimer)
    this.runtimeSignalTimer = undefined
    this.pendingRuntimeSignals.clear()
    this.unsubscribeBridge()
    this.unsubscribeTeam()
    this.listeners.clear()
  }

  /**
   * 推送合并到微任务：同一个事件会从多条路径到达这里（传输层事件本身、
   * TeamControlService 因同一事件重算后的团队快照、遥测刷新），同步逐次推送会让
   * 渲染层在一个 tick 内收到多份快照，且最先一份还没封口。合并后只在全部同步
   * 处理（含封口）完成后算一次快照、推一次。
   */
  private emit(): void {
    if (this.emitScheduled) return
    this.emitScheduled = true
    queueMicrotask(() => {
      this.emitScheduled = false
      if (this.disposed) return
      const snapshot = this.getSnapshot()
      for (const listener of this.listeners) listener(snapshot)
    })
  }
}
