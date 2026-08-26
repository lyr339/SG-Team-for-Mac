import type { AgentSession } from '../domain/agent-session'
import {
  emptyCursorTelemetrySnapshot,
  type CursorComposerTelemetry,
  type CursorTelemetrySnapshot
} from '../domain/cursor-telemetry'
import type { RuntimeBinding, TeamControlSnapshot } from '../domain/team-control'
import type {
  DesktopSnapshot,
  SendMessageAccepted,
  SendMessageInput
} from '../shared/desktop-api'
import type { CursorComposerTelemetrySource } from '../infrastructure/cursor/cursor-composer-telemetry'
import type { ChannelMessageRelay } from './channel-message-relay'
import { verifyAgentRuntime } from './verify-agent-runtime'

const DEFAULT_TELEMETRY_POLL_MS = 2_000
/** 空闲档（无活跃 TeamRun）：遥测降频到 10s——没有活跃 Agent 时没有可刷新的内容。 */
const IDLE_TELEMETRY_POLL_MS = 10_000

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

export function enrichDesktopSnapshot(
  bridgeSnapshot: DesktopSnapshot,
  team: TeamControlSnapshot,
  telemetry: CursorTelemetrySnapshot
): DesktopSnapshot {
  const verifiedSnapshot = verifyAgentRuntime(bridgeSnapshot, team, telemetry)
  const workspace = activeWorkspaceOf(team)
  const bindings = bindingByChannel(team)
  const composerById = new Map(telemetry.composers.map((composer) => [composer.composerId, composer]))
  const sessions = verifiedSnapshot.sessions.map((session): AgentSession => {
    const binding = bindings.get(session.channelId)
    const composer = binding?.composerId ? composerById.get(binding.composerId) : undefined
    // 无 composer 绑定时，回退到通道最新转录定位到的 composer（可能跨工作区，
    // 已由遥测层全局水合），让上下文用量在绑定缺失/滞后期间仍可读
    const channelComposerId = telemetry.channelActivities?.[session.channelId]?.composerId
    const displayComposer = composer
      ?? (channelComposerId ? composerById.get(channelComposerId) : undefined)
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
      modelName: composer?.modelName,
      executionProfile: telemetry.composerProfile,
      startedAt: binding?.acknowledgedAt ?? composer?.createdAt ?? session.startedAt,
      lastAgentActivityAt: composer?.activity?.observedAt,
      contextUsage: displayComposer?.contextUsage,
      changes: composer?.changes,
      workEntries: displayComposer?.workEntries,
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
  private refreshing = false
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
    private readonly embeddedRelay?: ChannelMessageRelay
  ) {
    this.activeWorkspaceId = team.getSnapshot().activeWorkspaceId
    this.activeRunId = team.getSnapshot().activeRun?.id
    this.unsubscribeBridge = bridge.subscribe(() => this.emit())
    this.unsubscribeRelay = embeddedRelay?.subscribe(() => this.emit())
    this.unsubscribeTeam = team.subscribe((snapshot) => {
      const workspaceChanged = snapshot.activeWorkspaceId !== this.activeWorkspaceId
      const runChanged = snapshot.activeRun?.id !== this.activeRunId
      this.activeWorkspaceId = snapshot.activeWorkspaceId
      this.activeRunId = snapshot.activeRun?.id
      if (workspaceChanged) {
        this.telemetry = emptyCursorTelemetrySnapshot()
        this.telemetryFingerprint = ''
        this.durationBySession.clear()
        this.refreshTelemetry()
      }
      if (runChanged && !workspaceChanged) {
        this.durationBySession.clear()
      }
      const run = snapshot.activeRun
      if (runChanged && run) this.embeddedRelay?.resetScope(run.createdAt)
      this.emit()
    })
  }

  getSnapshot(): DesktopSnapshot {
    const base = this.bridge.getSnapshot()
    const withEmbedded = this.embeddedRelay?.applyTo(base) ?? base
    const enriched = enrichDesktopSnapshot(withEmbedded, this.team.getSnapshot(), this.telemetry)
    return {
      ...enriched,
      sessions: enriched.sessions.map((session) => {
        const key = session.composerId || session.id
        const activeDurationMs = this.trackActiveDuration(key, session)
        // 增量缓存：值指纹命中即复用上轮视图引用。时长按分钟桶参与指纹
        //（与显示精度一致：分钟翻转才重建），其余字段逐值比较。
        const fingerprint = [
          session.online ? 1 : 0,
          session.status,
          session.waiting ? 1 : 0,
          session.connected ? 1 : 0,
          session.deliveryMode ?? '',
          session.lastSeenAt ?? 0,
          session.queueDepth,
          session.connectionPhase,
          session.composerId ?? '',
          session.composerTitle ?? '',
          session.modelName ?? '',
          session.telemetry?.state ?? '',
          session.telemetry?.detail ?? '',
          session.contextUsage?.ratio ?? '',
          session.contextUsage?.used ?? '',
          session.contextUsage?.limit ?? '',
          session.changes?.additions ?? '',
          session.changes?.deletions ?? '',
          session.workEntries?.length ?? 0,
          session.workEntries?.at(-1)?.turn ?? '',
          session.workEntries?.at(-1)?.line ?? '',
          session.workEntries?.at(-1)?.text.length ?? '',
          session.workEntries?.at(-1)?.status ?? '',
          session.healthEvidence.length,
          session.healthEvidence.at(-1) ?? '',
          activeDurationMs === undefined ? '' : Math.floor(activeDurationMs / 60_000)
        ].join('|')
        const cached = this.sessionViewCache.get(session.id)
        if (cached?.fingerprint === fingerprint) return cached.view
        const view: AgentSession = { ...session, activeDurationMs }
        this.sessionViewCache.set(session.id, { fingerprint, view })
        return view
      })
    }
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
    // 一体化分流：内嵌通道直写群枢 SQLite 队列，插件通道维持原 WS 链路
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
    this.refreshTelemetry()
    // 动态节拍（setTimeout 链）：活跃 TeamRun 保持原频率；空闲（无 run 或
    // 未启动/已结束）降频——遥测是最重的常驻轮询（读 vscdb + 扫转录文件），
    // 空闲时高频纯属浪费；活跃语义不变（检测延迟只在空档期变长）。
    const activeMs = Math.max(750, intervalMs)
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
      const next = workspace
        ? this.telemetrySource.readWorkspace(workspace.path, teamSnapshot.bindings)
        : emptyCursorTelemetrySnapshot('unavailable', '尚未选择团队工作区')

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

  dispose(): void {
    this.stopWatcher()
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
