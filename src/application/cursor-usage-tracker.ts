import {
  accumulateUsage,
  applyRequestSample,
  applyTurnUsage,
  type CursorSessionUsage,
  type CursorUsageEvent,
  type CursorUsageSnapshot
} from '../domain/cursor-usage'
import type { TeamRunStatus } from '../domain/team-control'

export interface CursorUsageRunState {
  runId?: string
  status?: TeamRunStatus
}

export function cursorUsageRunDecision(
  previous: CursorUsageRunState,
  next: CursorUsageRunState
): { reset: boolean; collecting: boolean } {
  const runChanged = previous.runId !== next.runId
  const sameRunRestarted = !runChanged
    && next.status === 'launching'
    && previous.status !== 'launching'
    && previous.status !== 'running'
  return {
    reset: runChanged || sameRunRestarted,
    collecting: next.status === 'launching' || next.status === 'running' || next.status === 'attention'
  }
}

/**
 * Cursor 会话用量聚合器（主进程实时态 + 本地持久化回调）。
 *
 * 输入：CursorStreamObserver 的 onUsageEvent（bundle 补丁在每回合
 * turnEnded 推送的真实计费 token）。
 * 输出：composerId → 累积用量快照（含按模型牌价估算的等价 API 成本），
 * 经 IPC 推送渲染层，与会话卡按 composerId 关联展示。
 *
 * 模型归属：事件本身不带模型——记录时向 DesktopSessionService 快照
 * 查该 composer 当前模型（resolveModelForComposer 注入），查不到按默认档。
 * 快照为深拷贝（structuredClone 同构的浅复制即可：值均为原始类型）。
 *
 * 快照由调用方按 TeamRun 持久化；团队运行时采集，结束/暂停后冻结。
 */
export interface CursorUsageTrackerOptions {
  /** composerId → 当前模型 id（费用估算用；缺省走默认价格档）。 */
  resolveModelForComposer?: (composerId: string) => string | undefined
  /** 变更通知（已节流）；测试可注入短值驱动。生产 800ms。 */
  notifyDelayMs?: number
  /** 测试时钟。 */
  now?: () => number
  /** 启动时恢复的 composer 累积快照。 */
  initialSnapshot?: CursorUsageSnapshot
  /** 每次计数变化后同步持久化；失败由 tracker 隔离。 */
  persistSnapshot?: (snapshot: CursorUsageSnapshot) => void
  /** 缺省 true；主进程按 TeamRun 状态切换。 */
  collecting?: boolean
}

const DEFAULT_NOTIFY_DELAY_MS = 800

export class CursorUsageTracker {
  private readonly resolveModelForComposer: (composerId: string) => string | undefined
  private readonly notifyDelayMs: number
  private readonly now: () => number
  private readonly persistSnapshot: (snapshot: CursorUsageSnapshot) => void
  private readonly sessions = new Map<string, CursorSessionUsage>()
  /** 快照通道已覆盖的 composer：事件通道对其让位（防双计）。 */
  private readonly polledComposers = new Set<string>()
  /** 请求级采样已接管的 composer：快照与事件通道均让位（口径一致，双计防护）。 */
  private readonly requestSampledComposers = new Set<string>()
  private readonly listeners = new Set<(snapshot: CursorUsageSnapshot) => void>()
  private notifyTimer?: ReturnType<typeof setTimeout>
  private disposed = false
  private collecting: boolean

  constructor(options: CursorUsageTrackerOptions = {}) {
    this.resolveModelForComposer = options.resolveModelForComposer ?? (() => undefined)
    this.notifyDelayMs = options.notifyDelayMs ?? DEFAULT_NOTIFY_DELAY_MS
    this.now = options.now ?? (() => Date.now())
    this.persistSnapshot = options.persistSnapshot ?? (() => {})
    this.collecting = options.collecting ?? true
    for (const [composerId, usage] of Object.entries(options.initialSnapshot ?? {})) {
      if (usage.turns > 0) this.sessions.set(composerId, { ...usage })
    }
  }

  /** 记录一回合用量并调度快照推送（节流合并密集回合）。 */
  record(event: CursorUsageEvent): void {
    if (this.disposed || !this.collecting) return
    // 轮询/采样通道已接管该 composer（CDP 在场、实时读数更全）：事件只作降级
    // 兜底，双通道同时记账会重复计数。轮询中断（CDP 退出）后事件自动恢复接管。
    if (this.polledComposers.has(event.composerId)
      || this.requestSampledComposers.has(event.composerId)
      // 基线存在 = 采样曾接管（含跨进程重启恢复的会话），事件通道持续让位
      || this.sessions.get(event.composerId)?.contextLastUsed !== undefined) return
    const model = this.resolveModelForComposer(event.composerId)
    this.sessions.set(event.composerId, accumulateUsage(
      this.sessions.get(event.composerId),
      event,
      model ?? ''
    ))
    this.scheduleNotify()
  }

  /**
   * CDP 轮询快照通道（turnTokenUsage 同源值，生成中单调增长）：
   * 覆盖语义见 domain applyTurnUsage。接管后事件通道对该 composer 让位；
   * 请求级采样已接管的 composer 同样让位（口径一致，双通道会重复计费）。
   */
  recordTurnSnapshot(event: CursorUsageEvent): void {
    if (this.disposed || !this.collecting) return
    if (this.requestSampledComposers.has(event.composerId)
      || this.sessions.get(event.composerId)?.contextLastUsed !== undefined) return
    const model = this.resolveModelForComposer(event.composerId)
    this.sessions.set(event.composerId, applyTurnUsage(
      this.sessions.get(event.composerId),
      event,
      model ?? ''
    ))
    this.polledComposers.add(event.composerId)
    this.scheduleNotify()
  }

  /**
   * 请求级上下文采样通道（长会话主通道）：contextTokensUsed 随每次模型请求
   * 刷新，算法见 domain applyRequestSample。接管后快照与事件通道均让位
   * （单向不可逆，run 切换才重置——基线持久化于快照，跨重启延续不双计）。
   */
  recordRequestSample(sample: { composerId: string; used: number; occurredAt: number }): void {
    if (this.disposed || !this.collecting) return
    const model = this.resolveModelForComposer(sample.composerId)
    this.sessions.set(sample.composerId, applyRequestSample(
      this.sessions.get(sample.composerId),
      sample,
      model ?? ''
    ))
    this.polledComposers.add(sample.composerId)
    this.requestSampledComposers.add(sample.composerId)
    this.scheduleNotify()
  }

  setCollecting(collecting: boolean): void {
    this.collecting = collecting
  }

  /** 新 TeamRun 开始前清零；立即推送空快照，旧徽章同步消失。 */
  reset(): void {
    if (this.disposed) return
    this.sessions.clear()
    this.polledComposers.clear()
    this.requestSampledComposers.clear()
    this.persist()
    this.scheduleNotify()
  }

  /** 当前全量快照（浅复制值对象，调用方可安全持有）。 */
  getSnapshot(): CursorUsageSnapshot {
    const snapshot: CursorUsageSnapshot = {}
    for (const [composerId, usage] of this.sessions) snapshot[composerId] = { ...usage }
    return snapshot
  }

  subscribe(listener: (snapshot: CursorUsageSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.persist()
    this.disposed = true
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.notifyTimer = undefined
    this.listeners.clear()
  }

  private persist(): void {
    try {
      this.persistSnapshot(this.getSnapshot())
    } catch {
      // 用量文件损坏/磁盘只读不影响 Cursor 会话与实时事件主链。
    }
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      if (this.disposed) return
      // 持久化随通知同拍节流（生产 800ms）：请求级采样在 150ms inspect 循环上
      // 高频到达，同步落盘必须合并（织梦同款防抖语义，dispose/reset 兜底写盘）。
      this.persist()
      const snapshot = this.getSnapshot()
      for (const listener of this.listeners) {
        try {
          listener(snapshot)
        } catch {
          // 单个监听者异常不阻断其余推送
        }
      }
    }, this.notifyDelayMs)
    this.notifyTimer.unref?.()
  }
}
