import {
  accumulateUsage,
  type CursorSessionUsage,
  type CursorUsageEvent,
  type CursorUsageSnapshot
} from '../domain/cursor-usage'

/**
 * Cursor 会话用量聚合器（主进程内存态）。
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
 * 应用重启后从零计（Cursor 侧 turnTokenUsage 不落盘，无历史可恢复）。
 */
export interface CursorUsageTrackerOptions {
  /** composerId → 当前模型 id（费用估算用；缺省走默认价格档）。 */
  resolveModelForComposer?: (composerId: string) => string | undefined
  /** 变更通知（已节流）；测试可注入短值驱动。生产 800ms。 */
  notifyDelayMs?: number
  /** 测试时钟。 */
  now?: () => number
}

const DEFAULT_NOTIFY_DELAY_MS = 800

export class CursorUsageTracker {
  private readonly resolveModelForComposer: (composerId: string) => string | undefined
  private readonly notifyDelayMs: number
  private readonly now: () => number
  private readonly sessions = new Map<string, CursorSessionUsage>()
  private readonly listeners = new Set<(snapshot: CursorUsageSnapshot) => void>()
  private notifyTimer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(options: CursorUsageTrackerOptions = {}) {
    this.resolveModelForComposer = options.resolveModelForComposer ?? (() => undefined)
    this.notifyDelayMs = options.notifyDelayMs ?? DEFAULT_NOTIFY_DELAY_MS
    this.now = options.now ?? (() => Date.now())
  }

  /** 记录一回合用量并调度快照推送（节流合并密集回合）。 */
  record(event: CursorUsageEvent): void {
    if (this.disposed) return
    const model = this.resolveModelForComposer(event.composerId)
    this.sessions.set(event.composerId, accumulateUsage(
      this.sessions.get(event.composerId),
      event,
      model ?? ''
    ))
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
    this.disposed = true
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.notifyTimer = undefined
    this.listeners.clear()
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      if (this.disposed) return
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
