import { BrowserWindow, session } from 'electron'
import { buildFullStealthScript } from './cursor-stealth'

/**
 * 内置浏览器删除通道：完全脱离外部浏览器依赖，在群枢内嵌 Chromium 中完成
 * 「刷新会话 → 删除账号」全流程。
 *
 * 对比 AppleScript 通道优势：
 *   - 不依赖外部浏览器（Edge/Chrome），换电脑/换浏览器仍可用；
 *   - 无需用户手动开启「Allow JavaScript from Apple Events」；
 *   - 内置 stealth 脚本绕过 Cloudflare，挑战处理更可控；
 *   - 删除脚本预注入，页面加载完成即自动执行，无外部轮询延迟。
 *
 * 会话持久化：使用独立 partition（persist:cursor-internal），cookie 存储在
 * 群枢 userData 目录，重启应用后登录状态保留。
 *
 * 注意：内置浏览器与外部浏览器会话独立。若用户在外部浏览器登录 cursor.com，
 * 内置浏览器首次使用需重新登录（或从外部导入 token）。
 */

export type InternalBrowserDeleteResult =
  | { kind: 'deleted' }
  | { kind: 'not_logged_in'; message: string }
  | { kind: 'retry_legacy'; message: string }

export interface CursorInternalBrowserDeleterOptions {
  /** 内置浏览器会话分区（持久化 cookie）。 */
  partition?: string
  /** 页面加载超时（含 Cloudflare 挑战）。 */
  readyTimeoutMs?: number
  /** 删除请求结果等待窗口。 */
  resultTimeoutMs?: number
  /** 页面持续停留在认证/登录页超过该时长 → 判定未登录。 */
  authChainGraceMs?: number
  /** 是否显示内置浏览器窗口（调试用，默认隐藏）。 */
  showWindow?: boolean
}

const DEFAULT_PARTITION = 'persist:cursor-internal'
const CURSOR_DASHBOARD_URL = 'https://cursor.com/dashboard'

export class CursorInternalBrowserDeleter {
  private readonly partition: string
  private readonly readyTimeoutMs: number
  private readonly resultTimeoutMs: number
  private readonly authChainGraceMs: number
  private readonly showWindow: boolean
  private window: BrowserWindow | undefined

  constructor(options: CursorInternalBrowserDeleterOptions = {}) {
    this.partition = options.partition ?? DEFAULT_PARTITION
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000
    this.resultTimeoutMs = options.resultTimeoutMs ?? 15_000
    this.authChainGraceMs = options.authChainGraceMs ?? 6_000
    this.showWindow = options.showWindow ?? false
  }

  /**
   * 准备内置浏览器：创建窗口、注入 stealth、加载 cursor.com。
   * 设计为与「当前会话直接删除」并行发起：会话仍有效时这次加载无害。
   */
  async prepareRefresh(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      // 复用现有窗口，刷新页面
      await this.window.loadURL(`${CURSOR_DASHBOARD_URL}?qtdash=${Date.now()}`)
      return
    }

    const ses = session.fromPartition(this.partition)

    this.window = new BrowserWindow({
      width: 1200,
      height: 800,
      show: this.showWindow,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    // 注入 stealth 脚本绕过 Cloudflare
    await this.window.webContents.executeJavaScript(buildFullStealthScript())

    // 加载页面（带 cache-bust）
    await this.window.loadURL(`${CURSOR_DASHBOARD_URL}?qtdash=${Date.now()}`)
  }

  /**
   * 页面就绪后执行删除。
   * 优化：删除脚本在页面加载完成后自动执行，无需外部轮询触发。
   */
  async deleteWhenReady(): Promise<InternalBrowserDeleteResult> {
    if (!this.window || this.window.isDestroyed()) {
      return { kind: 'retry_legacy', message: '内置浏览器窗口未就绪' }
    }

    const readyDeadline = Date.now() + this.readyTimeoutMs
    let authChainSince: number | undefined

    // 等待页面就绪（放宽条件：在 cursor.com 且不在认证/挑战页面即执行）
    while (Date.now() < readyDeadline) {
      const state = await this.getPageState()
      if (!state) {
        await this.sleep(200)
        continue
      }

      const onCursor = state.hostname === 'cursor.com' || state.hostname.endsWith('.cursor.com')
      const onAuthChain = state.hostname.includes('authenticator.') || state.pathname.startsWith('/login')
      const challenging = state.title.includes('Just a moment')

      if (onCursor && !onAuthChain && !challenging) {
        // 页面就绪，执行删除
        return this.executeDelete()
      }

      if (onAuthChain) {
        authChainSince = authChainSince ?? Date.now()
        if (Date.now() - authChainSince > this.authChainGraceMs) {
          return { kind: 'not_logged_in', message: '内置浏览器会话已退出登录（页面停留在认证/登录页）' }
        }
      } else {
        authChainSince = undefined
      }

      await this.sleep(200)
    }

    return { kind: 'retry_legacy', message: '页面加载超时（认证链未在窗口内完成）' }
  }

  /**
   * 在页面上下文执行删除操作。
   * 删除脚本预注入：页面加载完成后自动执行，无需等待外部触发。
   */
  private async executeDelete(): Promise<InternalBrowserDeleteResult> {
    if (!this.window || this.window.isDestroyed()) {
      return { kind: 'retry_legacy', message: '内置浏览器窗口已销毁' }
    }

    // 注入删除脚本并等待结果
    const deleteScript = `
      (function() {
        window.__qtDelResult = 'pending';
        var leave = 0, transient = 0;
        var csrf = function() {
          var m = document.cookie.match(/(?:^|; )csrf-token=([^;]+)/);
          return m ? decodeURIComponent(m[1]) : '';
        };
        var done = function(st, b) {
          window.__qtDelResult = JSON.stringify({ st: st, body: String(b || '').slice(0, 160) });
        };
        var go = function() {
          fetch('/api/csrf-token', { method: 'GET', credentials: 'include' })
            .then(function() { send(); })
            .catch(function() { send(); });
        };
        var retry = function(ms) { setTimeout(go, ms); };
        var send = function() {
          var h = { 'content-type': 'application/json' };
          var c = csrf();
          if (c) h['x-csrf-token'] = c;
          fetch('/api/dashboard/delete-account', {
            method: 'POST',
            credentials: 'include',
            headers: h,
            body: '{}'
          }).then(function(r) {
            r.text().then(function(t) {
              var b = String(t || '');
              if (r.status >= 200 && r.status < 300) {
                done(r.status, b);
              } else if (b.indexOf('leave the team') >= 0 && leave < 5) {
                leave += 1;
                retry(500);
              } else if ((r.status === 401 || r.status === 403 || b.indexOf('invalid_csrf_token') >= 0 || b.indexOf('csrf') >= 0) && transient < 10) {
                transient += 1;
                retry(300);
              } else {
                done(r.status, b);
              }
            });
          }).catch(function(e) {
            if (transient < 10) {
              transient += 1;
              retry(300);
            } else {
              done(-1, String(e));
            }
          });
        };
        go();
        return 'armed';
      })()
    `

    try {
      const armed = await this.window.webContents.executeJavaScript(deleteScript)
      if (!armed || !armed.includes('armed')) {
        return { kind: 'retry_legacy', message: '页面内删除请求未能发起' }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { kind: 'retry_legacy', message: `页面内删除发起失败：${detail.replace(/\s+/g, ' ').slice(0, 120)}` }
    }

    // 轮询删除结果
    const resultDeadline = Date.now() + this.resultTimeoutMs
    while (Date.now() < resultDeadline) {
      try {
        const raw = await this.window.webContents.executeJavaScript('window.__qtDelResult || ""')
        if (typeof raw === 'string' && raw.startsWith('{')) {
          const parsed = JSON.parse(raw) as { st?: number; body?: string }
          const status = parsed.st ?? -1
          if (status >= 200 && status < 300) {
            return { kind: 'deleted' }
          }
          const body = (parsed.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
          return { kind: 'retry_legacy', message: `页面内删除被拒（HTTP ${status}${body ? `：${body}` : ''}）` }
        }
      } catch {
        // 页面可能正在导航，继续等待
      }
      await this.sleep(150)
    }

    return { kind: 'retry_legacy', message: '页面内删除结果等待超时' }
  }

  /**
   * 获取当前页面状态。
   */
  private async getPageState(): Promise<{ hostname: string; pathname: string; title: string } | undefined> {
    if (!this.window || this.window.isDestroyed()) return undefined
    try {
      const state = await this.window.webContents.executeJavaScript(`
        JSON.stringify({
          hostname: location.hostname,
          pathname: location.pathname,
          title: document.title
        })
      `)
      return JSON.parse(state)
    } catch {
      return undefined
    }
  }

  /**
   * 从内置浏览器读取当前会话 token（用于与群枢凭据校验）。
   */
  async readToken(): Promise<string> {
    if (!this.window || this.window.isDestroyed()) {
      throw new Error('内置浏览器窗口未就绪')
    }
    const token = await this.window.webContents.executeJavaScript(`
      (function() {
        var m = document.cookie.match(/(?:^|; )WorkosCursorSessionToken=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
      })()
    `)
    return typeof token === 'string' ? token : ''
  }

  /**
   * 刷新浏览器会话并返回新 token。
   * 奥仔处理后旧 token 失效，须经内置浏览器换发。
   */
  async refreshToken(_previousToken: string): Promise<string> {
    await this.prepareRefresh()
    // 等待页面加载完成（含认证链重放）
    await this.sleep(3000)
    return this.readToken()
  }

  /**
   * 清理资源。
   */
  dispose(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
    }
    this.window = undefined
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
