import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * 浏览器会话刷新器：奥仔处理完成后，旧 WorkosCursorSessionToken 已失效，
 * 新 token 只会在浏览器与 cursor.com 的下一次 HTTP 交互中换发
 * （认证跳转链途经 authenticator.cursor.sh，有 Cloudflare 防护，纯协议层无法重放）。
 *
 * 策略：
 *   1. 先轮询本机浏览器 cookie 库一小段时间——若 cookie 已自行更新则零打扰返回
 *   2. 否则用 AppleScript 让浏览器刷新 cursor.com 标签页（无则新开一个），
 *      继续轮询 cookie 库直到 token 值变化（Chromium 写盘有延迟，轮询而非固定等待）
 *
 * 实测坑（2026-08-23 端到端验证发现）：对已有 cursor.com 标签页
 * `set URL of t to <相同 URL>` 在 Chromium AppleScript 中是 no-op——
 * 不发生任何网络导航，认证链不会重放，cookie 永不轮换直至超时。
 * 因此导航目标必须携带 cache-bust 查询参数，强制一次真实导航。
 */

const execFileAsync = promisify(execFile)

export interface CursorBrowserSessionRefresherOptions {
  /** 读取当前浏览器中的 WorkosCursorSessionToken（复用现有 Cookie 解密读取器）。 */
  readToken: () => string
  browserAppName?: string
  execFileFn?: typeof execFileAsync
  sleep?: (ms: number) => Promise<void>
  /** 阶段 1：等待 cookie 自行更新的窗口。 */
  selfUpdateWindowMs?: number
  /** 阶段 2：触发页面刷新后等待新 token 落盘的超时。 */
  refreshTimeoutMs?: number
  pollIntervalMs?: number
  now?: () => number
}

const DEFAULT_BROWSER_APP = 'Microsoft Edge'
const REFRESH_URL = 'https://cursor.com/dashboard'

function buildRefreshScript(appName: string, url: string): string {
  return `tell application "${appName}"
  if not running then
    error "browser_not_running"
  end if
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "cursor.com" then
        set URL of t to "${url}"
        return "reloaded"
      end if
    end repeat
  end repeat
  if (count of windows) is 0 then
    make new window with properties {URL:"${url}"}
  else
    tell front window to make new tab with properties {URL:"${url}"}
  end if
  return "opened"
end tell`
}

export class CursorBrowserSessionRefresher {
  private readonly readToken: () => string
  private readonly browserAppName: string
  private readonly execFileFn: typeof execFileAsync
  private readonly sleep: (ms: number) => Promise<void>
  private readonly selfUpdateWindowMs: number
  private readonly refreshTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly now: () => number

  constructor(options: CursorBrowserSessionRefresherOptions) {
    this.readToken = options.readToken
    this.browserAppName = options.browserAppName ?? DEFAULT_BROWSER_APP
    this.execFileFn = options.execFileFn ?? execFileAsync
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.selfUpdateWindowMs = options.selfUpdateWindowMs ?? 3_000
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? 30_000
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.now = options.now ?? Date.now
  }

  private async pollForChange(previousToken: string, timeoutMs: number): Promise<string | undefined> {
    const deadline = this.now() + timeoutMs
    while (true) {
      let current: string | undefined
      try {
        current = this.readToken().trim()
      } catch {
        current = undefined
      }
      if (current && current !== previousToken) return current
      const remaining = deadline - this.now()
      if (remaining <= 0) return undefined
      await this.sleep(Math.min(this.pollIntervalMs, remaining))
    }
  }

  /**
   * 刷新浏览器会话并返回新 token。
   * @param previousToken 处理前的旧 token（用于识别 cookie 是否已轮换）
   */
  async refresh(previousToken: string): Promise<string> {
    const previous = previousToken.trim()
    const selfUpdated = await this.pollForChange(previous, this.selfUpdateWindowMs)
    if (selfUpdated) return selfUpdated

    // cache-bust：目标 URL 与标签页当前 URL 相同时 Chromium 不会真正导航（见文件头注释）
    const bustUrl = `${REFRESH_URL}?qtrefresh=${this.now()}`
    try {
      await this.execFileFn('osascript', ['-e', buildRefreshScript(this.browserAppName, bustUrl)])
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (detail.includes('browser_not_running')) {
        throw new Error(`请先打开 ${this.browserAppName} 浏览器（需要它刷新 cursor.com 会话来换发新 Token）`)
      }
      throw new Error(`无法驱动浏览器刷新会话：${detail.replace(/\s+/g, ' ').slice(0, 160)}`)
    }

    const refreshed = await this.pollForChange(previous, this.refreshTimeoutMs)
    if (refreshed) return refreshed
    throw new Error('浏览器会话刷新超时：cookie 未更新（请确认浏览器能正常打开 cursor.com 且账号仍处登录态）')
  }
}
