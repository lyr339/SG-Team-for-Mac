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
    if (!token) return { ok: false, message: '缺少会话 Token，无法删除官网账号' }

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

    // 会话失效：官网 307 重定向到 WorkOS 认证链（redirect:'manual' 下直接可见）
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, authExpired: true, message: '会话已失效（官网要求重新登录）' }
    }

    let detail = `HTTP ${response.status}`
    try {
      const body: unknown = await response.json()
      const message = typeof body === 'object' && body !== null
        ? (body as { error?: { message?: unknown } }).error?.message
        : undefined
      if (typeof message === 'string' && message.trim()) detail = message.trim().slice(0, 200)
    } catch {
      // 保留 HTTP 状态码
    }
    if (detail === 'invalid_csrf_token') {
      return { ok: false, message: '官网拒绝了删除请求（CSRF 校验失败）' }
    }
    if (detail.toLowerCase().includes('leave the team')) {
      return { ok: false, needLeaveTeam: true, message: `官网要求先退出团队：${detail}` }
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, authExpired: true, message: `官网拒绝了删除请求（会话可能已失效：${detail}）` }
    }
    return { ok: false, message: `官网删除账号失败：${detail}` }
  }
}
