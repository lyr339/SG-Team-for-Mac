/**
 * 删除 Cursor 官网账号（cursor.com/dashboard → 高级账户设置 → Delete Account 的同款调用）。
 *
 * 逆向自 cursor.com 前端 chunk（2026-08）：
 *   POST /api/dashboard/delete-account
 *   Content-Type: application/json，body 为空的 DeleteAccountRequest（{}）
 *   会话凭证：WorkosCursorSessionToken cookie
 *   CSRF：x-csrf-token 头（值取自 csrf-token cookie，可由 GET /api/csrf-token 铸造）
 *   失败响应：{ error: { message } }
 *
 * 该操作不可逆。仅应由账号自动化链在新凭据已安全入库后调用。
 */

export interface CursorAccountDeleteResult {
  ok: boolean
  message: string
  /** 会话已失效（307 重定向到登录/401/403）——调用方应换发新 token 后重试。 */
  authExpired?: boolean
  /** 官网要求先退出团队——奥仔 completed 后「退团」副作用落地有服务端延迟（实机实测），调用方应等待重试而非识败。 */
  needLeaveTeam?: boolean
  /** 失败响应的 HTTP 状态码（请求未送达时缺省），用于区分 429 限流 / 403 封锁 / 5xx 服务端。 */
  status?: number
  /** 失败响应 Retry-After 头解析出的秒数（未携带或无法解析时缺省）。 */
  retryAfterSec?: number
  /** 限流型拒绝（HTTP 429 / 携带 Retry-After / 正文含 "Try again later"）——调用方应指数退避重试而非识败。 */
  rateLimited?: boolean
}

export interface CursorAccountDeleterOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_BASE_URL = 'https://cursor.com'
const DEFAULT_TIMEOUT_MS = 15_000

function extractSetCookie(headers: Headers, name: string): string | undefined {
  const entries = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  for (const entry of entries) {
    const pair = entry.split(';', 1)[0]
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim()
  }
  return undefined
}

function boundedError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? '')
  return text.replace(/\s+/g, ' ').trim().slice(0, 200) || '未知错误'
}

/**
 * 解析 Retry-After 响应头为秒数。支持两种合法形态：
 *   - 非负整数秒（如 "20"）；
 *   - HTTP-date（如 "Wed, 27 Aug 2026 05:30:00 GMT"），按与 nowMs 的差值折算。
 * 无法解析返回 undefined。
 */
export function parseRetryAfterSec(value: string | null | undefined, nowMs: number): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (/^\d+$/.test(trimmed)) {
    const sec = Number.parseInt(trimmed, 10)
    return Number.isFinite(sec) && sec >= 0 ? sec : undefined
  }
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, Math.round((at - nowMs) / 1000))
}

export class CursorAccountDeleter {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: CursorAccountDeleterOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      // 不跟随重定向：会话失效时官网会 307 到 WorkOS 登录链，
      // 跟随会让调用方拿到含混的最终响应；手动模式才能拿到干脆的 307 信号
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, redirect: 'manual', signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /** 铸造 CSRF token：GET /api/csrf-token 会从 Set-Cookie 种下 csrf-token。 */
  private async mintCsrfToken(sessionCookie: string): Promise<string | undefined> {
    try {
      const response = await this.request('/api/csrf-token', {
        method: 'GET',
        headers: { Cookie: sessionCookie }
      })
      if (!response.ok) return undefined
      return extractSetCookie(response.headers, 'csrf-token')
    } catch {
      return undefined
    }
  }

  async deleteAccount(sessionToken: string): Promise<CursorAccountDeleteResult> {
    const token = sessionToken.trim()
    if (!token) return { ok: false, message: '缺少会话 Token，无法加固账号' }

    const sessionCookie = `WorkosCursorSessionToken=${encodeURIComponent(token)}`
    const csrfToken = await this.mintCsrfToken(sessionCookie)

    const cookie = csrfToken ? `${sessionCookie}; csrf-token=${csrfToken}` : sessionCookie
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/dashboard`
    }
    if (csrfToken) headers['x-csrf-token'] = csrfToken

    let response: Response
    try {
      response = await this.request('/api/dashboard/delete-account', {
        method: 'POST',
        headers,
        body: '{}'
      })
    } catch (error) {
      return { ok: false, message: `删除请求未能送达：${boundedError(error)}` }
    }

    if (response.ok) return { ok: true, message: 'Cursor 官网账号已删除' }

    const status = response.status
    const retryAfterSec = parseRetryAfterSec(response.headers.get('retry-after'), Date.now())

    // 会话失效：官网 307 重定向到 WorkOS 认证链（redirect:'manual' 下直接可见）
    if (status >= 300 && status < 400) {
      return { ok: false, authExpired: true, status, retryAfterSec, message: '会话已失效（官网要求重新登录）' }
    }

    // 诊断增强：失败结果必须能直接区分 429 限流 / 403 封锁 / 5xx 服务端——
    // 统一带上 HTTP 状态码、Retry-After 与响应体截断（≤160 字符）。
    let bodySnippet = ''
    let detail = ''
    try {
      const raw = await response.text()
      bodySnippet = raw.replace(/\s+/g, ' ').trim().slice(0, 160)
      try {
        const parsed: unknown = JSON.parse(raw)
        const message = typeof parsed === 'object' && parsed !== null
          ? (parsed as { error?: { message?: unknown } }).error?.message
          : undefined
        if (typeof message === 'string' && message.trim()) detail = message.trim()
      } catch {
        // 非 JSON 响应体：诊断直接用截断后的原文
      }
    } catch {
      // 响应体读取失败：仅保留状态码
    }
    const summary = detail || bodySnippet

    if (summary === 'invalid_csrf_token') {
      return { ok: false, status, retryAfterSec, message: '官网拒绝了加固请求（CSRF 校验失败）' }
    }
    if (summary.toLowerCase().includes('leave the team')) {
      return { ok: false, needLeaveTeam: true, status, retryAfterSec, message: `官网要求先退出团队：${summary.slice(0, 200)}` }
    }
    // 限流型拒绝：HTTP 429 / 携带 Retry-After / 正文含 "Try again later"
    // （cursor.com 应用层冷却，会话本身仍有效——调用方应退避重试而非轮换 token）
    const rateLimited = status === 429 || retryAfterSec !== undefined || /try again later/i.test(summary)
    if ((status === 401 || status === 403) && !rateLimited) {
      return { ok: false, authExpired: true, status, retryAfterSec, message: `官网拒绝了删除请求（会话可能已失效：${summary || `HTTP ${status}`}）` }
    }
    // 「官网删除账号失败：」前缀被 UI 依赖，改动时不得移除
    return {
      ok: false,
      status,
      retryAfterSec,
      rateLimited: rateLimited || undefined,
      message: `官网删除账号失败：HTTP ${status}${retryAfterSec !== undefined ? `（Retry-After ${retryAfterSec}s）` : ''}：${summary || '无响应体'}`
    }
  }
}
