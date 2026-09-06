import { reduceUsage, upgradeUsageEstimate, type CursorUsageSample, type UsageObservation, type CursorSessionUsage, type CursorUsageEvent, type CursorUsageSnapshot } from '../domain/cursor-usage'
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
  return {
    // 新批次有新 runId；同 run 的 attention/launching 抖动不清账。
    reset: runChanged,
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
 * 模型归属：优先使用事件模型，缺失时查会话快照；每个原生回合固化一份牌价。
 * 快照深拷贝，隔离内部逐回合账本。
 *
 * 快照按 run 持久化；显式结束时冻结，在线状态变化不影响计数。
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
      this.sessions.set(composerId, structuredClone(usage.ledger ? upgradeUsageEstimate(usage) : { ...usage, quality: 'legacy' as const }))
    }
  }

  /** 同一 generation 的权威结算，优先替换该回合的临时估算。 */
  record(event: CursorUsageEvent): void {
    if (!event.generationId) return // 旧补丁没有归属 ID；由带 ID 的内存快照结算。
    this.observe({ kind: 'checkpoint', value: { ...event, generationId: event.generationId } })
  }

  recordTurnSnapshot(event: CursorUsageEvent): void { this.record(event) }

  recordRequestSample(sample: CursorUsageSample): void {
    this.observe({ kind: 'sample', value: sample })
  }

  private observe(observation: UsageObservation): void {
    if (this.disposed || !this.collecting) return
    const event = observation.value
    const previous = this.sessions.get(event.composerId)
    const hasPrice = previous?.ledger && Object.hasOwn(previous.ledger.turns, event.generationId)
    const next = reduceUsage(previous, { ...observation, value: {
      ...event, modelId: event.modelId || (hasPrice ? undefined : this.resolveModelForComposer(event.composerId))
    } } as UsageObservation)
    if (!next || next === previous) return
    this.sessions.set(event.composerId, next)
    if (observation.kind === 'checkpoint' || observation.value.stopped) this.persist()
    this.scheduleNotify()
  }

  setCollecting(collecting: boolean): void {
    if (this.disposed) return
    if (this.collecting && !collecting) {
      for (const [id, usage] of this.sessions) {
        if (usage.ledger) this.sessions.set(id, { ...usage, ledger: { ...usage.ledger, frozenAt: this.now() } })
      }
      this.persist()
      this.scheduleNotify()
    }
    this.collecting = collecting
  }

  /** 新 TeamRun 开始前清零；立即推送空快照，旧徽章同步消失。 */
  reset(): void {
    if (this.disposed) return
    this.sessions.clear()
    this.persist()
    this.scheduleNotify()
  }

  /** 当前全量快照（浅复制值对象，调用方可安全持有）。 */
  getSnapshot(): CursorUsageSnapshot {
    const snapshot: CursorUsageSnapshot = {}
    for (const [composerId, usage] of this.sessions) snapshot[composerId] = structuredClone(usage)
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
