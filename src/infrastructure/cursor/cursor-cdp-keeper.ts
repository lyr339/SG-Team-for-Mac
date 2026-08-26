import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CursorCdpRestartResult } from './cursor-cdp-restart'
import { restartCursorWithCdp } from './cursor-cdp-restart'
import type { CdpAutoHealEvent } from '../../domain/cursor-cdp'

export type { CdpAutoHealEvent }

/**
 * CDP 调试端口自动保持（auto-heal）看门。
 *
 * 用户痛点：Cursor 每次启动都要手动带 --remote-debugging-port。
 * 看门每 5s 做一次低成本探测（pgrep + 带超时的 /json/version fetch）：
 * - Cursor 未运行 / 端口已就绪 → 静默；
 * - 运行但端口未就绪 → 进入「待重启」：通知渲染层显示可取消倒计时（10s），
 *   用户未取消才复用 restartCursorWithCdp 优雅退出并带参拉起。
 *
 * 防循环：进程启动指纹（pid + 启动时间）记忆——同一轮 Cursor 进程只触发一次；
 * 用户取消后该指纹不再打扰；自动重启产生的新进程若端口仍不就绪也不再重启。
 * 所有外部副作用（进程探测 / fetch / 计时 / 重启）注入化，测试用假时钟驱动。
 */

const execFileAsync = promisify(execFile)

const CURSOR_PROCESS_PATTERN = 'Cursor.app/Contents/MacOS/Cursor'
const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_COUNTDOWN_MS = 10_000
const COUNTDOWN_POLL_SLICE_MS = 200
const FETCH_TIMEOUT_MS = 1_500

export interface CursorCdpKeeperOptions {
  port: number
  /** 设置开关（cdpAutoHealEnabled）读取口；关闭时看门完全静默。 */
  isEnabled: () => boolean
  /** 事件出口：main 进程接线时桥到渲染层倒计时提示。 */
  emit: (event: CdpAutoHealEvent) => void
  workspacePath?: () => string | undefined
  restart?: (port: number, workspacePath?: string) => Promise<CursorCdpRestartResult>
  execFileFn?: typeof execFileAsync
  fetchFn?: (url: string) => Promise<{ status: number }>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  platform?: NodeJS.Platform
  intervalMs?: number
  countdownMs?: number
}

interface CursorProcess {
  pid: number
  startedAt: string
}

export class CursorCdpKeeper {
  private readonly options: CursorCdpKeeperOptions
  private readonly execFileFn: typeof execFileAsync
  private readonly fetchFn: (url: string) => Promise<{ status: number }>
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly restartFn: (port: number, workspacePath?: string) => Promise<CursorCdpRestartResult>
  private timer?: ReturnType<typeof setInterval>
  private ticking = false
  /** 已处理过的进程启动指纹（触发过倒计时 / 用户取消 / 自动重启后的新进程）。 */
  private readonly handledProcessKeys = new Set<string>()
  private countdown?: { processKey: string; cancelled: boolean }

  constructor(options: CursorCdpKeeperOptions) {
    this.options = options
    this.execFileFn = options.execFileFn ?? execFileAsync
    this.fetchFn = options.fetchFn ?? defaultFetch
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
    this.restartFn = options.restart ?? ((port, workspacePath) => restartCursorWithCdp({
      port,
      execFileFn: this.execFileFn,
      // 传 this.fetchFn（已回退到带超时的 defaultFetch），避免 restart 落入裸 fetch 挂起
      fetchFn: this.fetchFn,
      sleep: options.sleep,
      now: options.now,
      platform: options.platform,
      workspacePath
    }))
  }

  start(): void {
    this.stop()
    this.timer = setInterval(() => void this.checkNow(), Math.max(1_000, this.options.intervalMs ?? DEFAULT_INTERVAL_MS))
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 立即执行一轮探测（看门周期之外的手动入口；测试用它驱动假时钟）。 */
  async checkNow(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      if (!this.options.isEnabled()) return
      if ((this.options.platform ?? process.platform) !== 'darwin') return
      const processes = await this.cursorProcesses()
      if (!processes.length) {
        // 进程退出后指纹失效：清理不再运行的指纹，下次启动按新进程对待
        this.handledProcessKeys.clear()
        return
      }
      if (await this.portReady()) return
      const key = processKeyOf(processes[0]!)
      if (this.handledProcessKeys.has(key)) return
      // 先记录再进入倒计时：并发/重入不会重复触发
      this.handledProcessKeys.add(key)
      await this.pendingRestart(key)
    } catch {
      // 看门是旁路增强：任何探测异常都不允许影响主进程
    } finally {
      this.ticking = false
    }
  }

  /** 用户在倒计时提示上点「取消」：本次启动不再打扰（指纹已记录）。 */
  cancelCountdown(): void {
    if (this.countdown) this.countdown.cancelled = true
  }

  /** 当前是否有进行中的倒计时（IPC 查询/测试用）。 */
  get countdownActive(): boolean {
    return this.countdown !== undefined
  }

  private async pendingRestart(processKey: string): Promise<void> {
    const port = this.options.port
    this.options.emit({
      phase: 'countdown',
      processKey,
      deadlineAt: this.now() + (this.options.countdownMs ?? DEFAULT_COUNTDOWN_MS),
      port
    })
    const cancelled = await this.waitCountdown(processKey, this.options.countdownMs ?? DEFAULT_COUNTDOWN_MS)
    if (cancelled) {
      this.options.emit({ phase: 'cancelled', processKey })
      return
    }
    // 到期复检：倒计时窗口内用户可能已手动带参重启（端口就绪）、直接退出 Cursor，
    // 或进程已更换——任一成立都跳过 restart，绝不把已修好/已关闭的 Cursor 再拉一次
    if (await this.portReady()) {
      this.options.emit({ phase: 'done', processKey, ok: true, message: '端口已就绪，无需重启' })
      return
    }
    const currentProcesses = await this.cursorProcesses()
    if (!currentProcesses.length) {
      this.options.emit({ phase: 'done', processKey, ok: true, message: 'Cursor 已退出，跳过重启' })
      return
    }
    if (processKeyOf(currentProcesses[0]!) !== processKey) {
      this.options.emit({ phase: 'done', processKey, ok: true, message: 'Cursor 进程已更换，按新进程重新评估' })
      return
    }
    this.options.emit({ phase: 'restarting', processKey })
    const result = await this.restartFn(port, this.options.workspacePath?.())
    this.options.emit({ phase: 'done', processKey, ok: result.ok, message: result.message })
    // 防循环：自动重启产生的新进程若端口仍不就绪，不再二次自动重启
    const processes = await this.cursorProcesses()
    if (processes.length) this.handledProcessKeys.add(processKeyOf(processes[0]!))
  }

  /** 倒计时等待：切片轮询取消标记（sleep 注入不可中断，切片检查最稳）。 */
  private async waitCountdown(processKey: string, ms: number): Promise<boolean> {
    this.countdown = { processKey, cancelled: false }
    const deadline = this.now() + ms
    try {
      while (this.now() < deadline) {
        if (this.countdown.cancelled) return true
        await this.sleep(Math.min(COUNTDOWN_POLL_SLICE_MS, Math.max(1, deadline - this.now())))
      }
      return false
    } finally {
      this.countdown = undefined
    }
  }

  private async cursorProcesses(): Promise<CursorProcess[]> {
    try {
      const { stdout } = await this.execFileFn('pgrep', ['-f', CURSOR_PROCESS_PATTERN])
      const pids = stdout.split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0)
      if (!pids.length) return []
      const mainPid = pids[0]!
      let startedAt = ''
      try {
        const ps = await this.execFileFn('ps', ['-o', 'lstart=', '-p', String(mainPid)])
        startedAt = ps.stdout.trim()
      } catch {
        startedAt = ''
      }
      return [{ pid: mainPid, startedAt }]
    } catch {
      // pgrep 无匹配时退出码为 1 → Cursor 未运行
      return []
    }
  }

  private async portReady(): Promise<boolean> {
    try {
      const response = await this.fetchFn(`http://127.0.0.1:${this.options.port}/json/version`)
      return response.status >= 200 && response.status < 300
    } catch {
      return false
    }
  }
}

function processKeyOf(process: CursorProcess): string {
  return `${process.pid}:${process.startedAt}`
}

/** 默认探测：带超时的 /json/version（看门成本必须极低）。 */
async function defaultFetch(url: string): Promise<{ status: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return { status: response.status }
  } finally {
    clearTimeout(timer)
  }
}
