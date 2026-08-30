import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * 秒级删除通道：会话被奥仔处理后失效时，刷新浏览器中的 cursor.com 标签页，
 * 然后直接在页面上下文里 fetch 删除接口（credentials:'include' 自动携带新会话 cookie）。
 *
 * 为什么比「cookie 轮换」通道快一个数量级（实机实测 ~20s → ~3s）：
 *   - 旧通道等的是 Chromium 把新 cookie **批量落盘到 SQLite**（写盘有十几秒级延迟），
 *     再解密提取 token、入库、铸造 CSRF、发协议删除；
 *   - 本通道删除动作本身不需要 token 值——认证链在页面加载过程中已在浏览器内存里完成，
 *     页面就绪即发请求，全程无落盘等待、无提取、无额外协议往返。
 *
 * 优化点（2026-08-26）：
 *   - 放宽就绪条件：检测到 cursor.com 且不在认证页面即执行，不等 readyState === 'complete'；
 *   - leave team 快速重试：首次遇错后 500ms 重试（原 2.5s），最多 5 次。
 *
 * 依赖：Edge 菜单 视图 → Developer → Allow JavaScript from Apple Events（一次性勾选）。
 * 未开启/页面异常时返回 retry_legacy，调用方回退 cookie 轮换通道（保证「不失误」）。
 *
 * 实测坑（2026-08-23）：对已有标签页 `set URL` 到相同地址在 Chromium 下是 no-op，
 * 导航目标必须携带 cache-bust 查询参数；认证链会短暂途经 authenticator.cursor.sh，
 * 因此标签页用导航时捕获的 window/tab id 稳定寻址（URL 匹配在中途会失配）。
 */

const execFileAsync = promisify(execFile)

export type InBrowserDeleteResult =
  | { kind: 'deleted' }
  | { kind: 'not_logged_in'; message: string }
  | { kind: 'retry_legacy'; message: string }

export interface CursorInBrowserAccountDeleterOptions {
  browserAppName?: string
  execFileFn?: typeof execFileAsync
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** 等待页面就绪（含认证链重放）的总窗口。 */
  readyTimeoutMs?: number
  /** 页面内删除请求的结果等待窗口。 */
  resultTimeoutMs?: number
  /** 页面持续停留在认证/登录页超过该时长 → 判定未登录（认证链正常弹跳远短于此）。 */
  authChainGraceMs?: number
  pollIntervalMs?: number
}

interface TabTarget {
  windowId: string
  tabId: string
}

const DEFAULT_BROWSER_APP = 'Microsoft Edge'
const REFRESH_URL = 'https://cursor.com/dashboard'

const READINESS_JS = 'JSON.stringify({h:location.hostname,p:location.pathname,s:document.readyState})'
// 页内删除带「退团等待」自愈：奥仔 completed 后退团副作用落地有服务端延迟，
// 撞上 leave the team 时每 500ms 自动重试（5 次 ≈ 2.5s），其余结果立即写终态。
// 指纹浏览器通道（fingerprint-account-channel）复用同一脚本，保证行为单一来源。
export const FIRE_DELETE_JS = "(function(){window.__qtDel='pending';var leave=0,transient=0;var csrf=function(){var m=document.cookie.match(/(?:^|; )csrf-token=([^;]+)/);return m?decodeURIComponent(m[1]):''};var done=function(st,b){window.__qtDel=JSON.stringify({st:st,body:String(b||'').slice(0,160)})};var go=function(){fetch('/api/csrf-token',{method:'GET',credentials:'include'}).then(function(){send()}).catch(function(){send()})};var retry=function(ms){setTimeout(go,ms)};var send=function(){var h={'content-type':'application/json'};var c=csrf();if(c){h['x-csrf-token']=c}fetch('/api/dashboard/delete-account',{method:'POST',credentials:'include',headers:h,body:'{}'}).then(function(r){r.text().then(function(t){var b=String(t||'');if(r.status>=200&&r.status<300){done(r.status,b)}else if(b.indexOf('leave the team')>=0&&leave<5){leave+=1;retry(500)}else if((r.status===401||r.status===403||b.indexOf('invalid_csrf_token')>=0||b.indexOf('csrf')>=0)&&transient<10){transient+=1;retry(300)}else{done(r.status,b)}})}).catch(function(e){if(transient<10){transient+=1;retry(300)}else{done(-1,String(e))}})};go();return 'armed'})()"
const POLL_RESULT_JS = "window.__qtDel||''"

function escapeForAppleScript(js: string): string {
  return js.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildNavigateScript(appName: string, url: string): string {
  return `tell application "${appName}"
  if not running then
    error "browser_not_running"
  end if
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "cursor.com" then
        set URL of t to "${url}"
        return ((id of w) as string) & ":" & (id of t as string)
      end if
    end repeat
  end repeat
  if (count of windows) is 0 then
    set w to make new window with properties {URL:"${url}"}
    set t to active tab of w
  else
    set w to front window
    tell w to make new tab with properties {URL:"${url}"}
    set t to active tab of w
  end if
  return ((id of w) as string) & ":" & (id of t as string)
end tell`
}

function buildEvalScript(appName: string, target: TabTarget, js: string): string {
  return `tell application "${appName}"
  if not running then
    error "browser_not_running"
  end if
  repeat with w in windows
    if (id of w) as string is "${target.windowId}" then
      repeat with t in tabs of w
        if (id of t) as string is "${target.tabId}" then
          tell t
            set r to execute javascript "${escapeForAppleScript(js)}"
          end tell
          return r
        end if
      end repeat
    end if
  end repeat
  return "tab_gone"
end tell`
}

function isJsDisabledError(detail: string): boolean {
  return detail.includes('JavaScript through AppleScript is turned off')
    || detail.includes('Allow JavaScript from Apple Events')
}

export class CursorInBrowserAccountDeleter {
  private readonly browserAppName: string
  private readonly execFileFn: typeof execFileAsync
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly readyTimeoutMs: number
  private readonly resultTimeoutMs: number
  private readonly authChainGraceMs: number
  private readonly pollIntervalMs: number
  private target: TabTarget | undefined
  private prepareError: string | undefined

  constructor(options: CursorInBrowserAccountDeleterOptions = {}) {
    this.browserAppName = options.browserAppName ?? DEFAULT_BROWSER_APP
    this.execFileFn = options.execFileFn ?? execFileAsync
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000
    // 页面内 delete 遇 leave team 会自愈重试至 ~2.5s，结果窗须覆盖（其余失败立即写终态不受影响）
    this.resultTimeoutMs = options.resultTimeoutMs ?? 10_000
    this.authChainGraceMs = options.authChainGraceMs ?? 6_000
    this.pollIntervalMs = options.pollIntervalMs ?? 150
  }

  /**
   * 刷新浏览器中的 cursor.com 标签页（无则新开），并捕获标签页 id 供后续稳定寻址。
   * 设计为与「当前会话直接删除」并行发起：会话仍有效时这次导航无害（仅一次页面重载）。
   */
  async prepareRefresh(): Promise<void> {
    this.target = undefined
    this.prepareError = undefined
    const bustUrl = `${REFRESH_URL}?qtdash=${this.now()}`
    try {
      const { stdout } = await this.execFileFn('osascript', ['-e', buildNavigateScript(this.browserAppName, bustUrl)])
      const match = /(\d+)\s*:\s*(\d+)/.exec(stdout.trim())
      const [, windowId, tabId] = match ?? []
      if (!windowId || !tabId) throw new Error(`unexpected_navigate_result:${stdout.trim().slice(0, 80)}`)
      this.target = { windowId, tabId }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (detail.includes('browser_not_running')) {
        this.prepareError = `请先打开 ${this.browserAppName} 浏览器（需要它刷新 cursor.com 会话）`
      } else {
        this.prepareError = `无法驱动浏览器刷新会话：${detail.replace(/\s+/g, ' ').slice(0, 160)}`
      }
      throw new Error(this.prepareError)
    }
  }

  private async evalInTab(js: string): Promise<string> {
    if (!this.target) throw new Error('no_target')
    const { stdout } = await this.execFileFn('osascript', ['-e', buildEvalScript(this.browserAppName, this.target, js)])
    return stdout.trim()
  }

  /**
   * 页面就绪（认证链重放完成）后，在页面上下文里直接调用删除接口。
   * 优化：放宽就绪条件，只要检测到 cursor.com 且不在认证页面即执行，不等 readyState === 'complete'。
   */
  async deleteWhenReady(): Promise<InBrowserDeleteResult> {
    if (!this.target) {
      return { kind: 'retry_legacy', message: this.prepareError ?? '浏览器页面刷新未就绪' }
    }

    const readyDeadline = this.now() + this.readyTimeoutMs
    let authChainSince: number | undefined
    let ready = false
    while (this.now() < readyDeadline && !ready) {
      let state: { h?: string; p?: string; s?: string } | undefined
      try {
        const raw = await this.evalInTab(READINESS_JS)
        if (raw === 'tab_gone') return { kind: 'retry_legacy', message: '刷新标签页已被关闭' }
        state = JSON.parse(raw) as typeof state
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (isJsDisabledError(detail)) {
          return {
            kind: 'retry_legacy',
            message: 'Edge 未允许 Apple 事件执行 JavaScript（视图 → Developer → Allow JavaScript from Apple Events，一次性勾选后秒级通道可用）'
          }
        }
        state = undefined // 导航中途瞬时失败，按未就绪继续等
      }
      if (state) {
        const host = state.h ?? ''
        const path = state.p ?? ''
        const onCursor = host === 'cursor.com' || host.endsWith('.cursor.com')
        const onAuthChain = host.includes('authenticator.') || path.startsWith('/login')
        // 放宽条件：只要在 cursor.com 且不在认证页面即视为就绪，不等 readyState
        if (onCursor && !onAuthChain) {
          ready = true
        } else if (onAuthChain) {
          authChainSince = authChainSince ?? this.now()
          if (this.now() - authChainSince > this.authChainGraceMs) {
            return { kind: 'not_logged_in', message: '浏览器会话已退出登录（页面停留在认证/登录页）' }
          }
        } else {
          authChainSince = undefined
        }
      }
      if (!ready) await this.sleep(this.pollIntervalMs)
    }
    if (!ready) return { kind: 'retry_legacy', message: '页面加载超时（认证链未在窗口内完成）' }

    try {
      const armed = await this.evalInTab(FIRE_DELETE_JS)
      if (!armed.includes('armed')) return { kind: 'retry_legacy', message: '页面内加固请求未能发起' }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { kind: 'retry_legacy', message: `页面内加固发起失败：${detail.replace(/\s+/g, ' ').slice(0, 120)}` }
    }

    const resultDeadline = this.now() + this.resultTimeoutMs
    while (this.now() < resultDeadline) {
      let raw = ''
      try {
        raw = await this.evalInTab(POLL_RESULT_JS)
      } catch {
        raw = ''
      }
      if (raw.startsWith('{')) {
        try {
          const parsed = JSON.parse(raw) as { st?: number; body?: string }
          const status = parsed.st ?? -1
          if (status >= 200 && status < 300) return { kind: 'deleted' }
          const body = (parsed.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
          return { kind: 'retry_legacy', message: `页面内加固被拒（HTTP ${status}${body ? `：${body}` : ''}）` }
        } catch {
          // 半截 JSON，继续等
        }
      }
      await this.sleep(this.pollIntervalMs)
    }
    return { kind: 'retry_legacy', message: '页面内加固结果等待超时' }
  }
}
