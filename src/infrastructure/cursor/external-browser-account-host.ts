import { CursorBrowserSessionRefresher } from './cursor-browser-session-refresher'
import { CursorInBrowserAccountDeleter, type InBrowserDeleteResult } from './cursor-in-browser-account-deleter'
import { CursorBrowserTokenReader } from './cursor-browser-token-reader'
import type { AccountAutomationBrowserHost } from './account-automation-browser-host'

/**
 * 系统浏览器（Edge/Chrome）宿主：账号自动化链的原始路径，组装旧三件套
 * （cookie 库读取 / AppleScript 会话刷新 / 页内秒级删除）为统一 BrowserHost 契约。
 *
 * 依赖（与指纹路径的差异）：
 *   - 外部浏览器必须已登录 cursor.com（cookie 库可读）
 *   - 秒级删除需 Edge 勾选「视图 → Developer → Allow JavaScript from Apple Events」
 *     （未开则 deleteWhenReady 返回 retry_legacy 回退 cookie 轮换通道）
 *   - cookie 落盘依赖 Chromium 后台批量写 SQLite（轮换等待 20-90s，远慢于指纹内存读）
 *
 * dispose 为 noop：外部浏览器是用户自己的日常浏览器，自动化链无权关闭它。
 */
export interface ExternalBrowserAccountHostOptions {
  /** 读当前登录态 token（默认：CursorBrowserTokenReader，同步抛错语义保留）。 */
  readToken?: () => string
  /** fallback 轮换（默认：CursorBrowserSessionRefresher + 旧链调优参数）。 */
  refresher?: { refresh: (previousToken: string) => Promise<string> }
  /** 秒级删除通道（默认：CursorInBrowserAccountDeleter）。 */
  deleter?: {
    prepareRefresh: () => Promise<void>
    deleteWhenReady: () => Promise<InBrowserDeleteResult>
  }
}

export class ExternalBrowserAccountHost implements AccountAutomationBrowserHost {
  private readonly readTokenImpl: () => string
  private readonly refresher: { refresh: (previousToken: string) => Promise<string> }
  private readonly deleter: {
    prepareRefresh: () => Promise<void>
    deleteWhenReady: () => Promise<InBrowserDeleteResult>
  }

  constructor(options: ExternalBrowserAccountHostOptions = {}) {
    this.readTokenImpl = options.readToken ?? (() => new CursorBrowserTokenReader().read().token)
    this.refresher = options.refresher ?? new CursorBrowserSessionRefresher({
      // 速度调优（自动化链实测）：cookie 无页面交互不可能自行轮换，
      // 自更新窗口只保留 1s「零打扰」幸运窗口；轮询 500ms 降低感知粒度
      readToken: () => new CursorBrowserTokenReader().read().token,
      selfUpdateWindowMs: 1_000,
      pollIntervalMs: 500,
      // cookie 落盘依赖 Chromium 后台批量写 SQLite；实机可超过 45s。
      // 该路径只在秒级页面内删除通道失败后启用，宁可多等也不要误判失败。
      refreshTimeoutMs: 90_000
    })
    this.deleter = options.deleter ?? new CursorInBrowserAccountDeleter()
  }

  async readToken(): Promise<string> {
    // 同步读取器（SQLite + Keychain 解密），失败抛错由 service 的 preflight 捕获中止
    return this.readTokenImpl()
  }

  async refresh(previousToken: string): Promise<string> {
    return this.refresher.refresh(previousToken)
  }

  async prepareRefresh(): Promise<void> {
    return this.deleter.prepareRefresh()
  }

  async deleteWhenReady(): Promise<InBrowserDeleteResult> {
    return this.deleter.deleteWhenReady()
  }

  async dispose(): Promise<void> {
    // noop：外部浏览器是用户日常浏览器，自动化链无权关闭。
  }
}
