/**
 * Cursor 官网账号资料识别（token → email / name / 注册时间）。
 *
 * 逆向实证（2026-08-29，本机抓包 cursor.com 前端 chunk）：
 *   GET https://cursor.com/api/auth/me
 *     Cookie: WorkosCursorSessionToken=<user_xxx::eyJ...>（URL 编码形态，与浏览器一致）
 *     Accept: application/json
 *   - 200 → { email, email_verified, name, sub, created_at, updated_at, picture, id }
 *   - 204 → 未登录（官网前端 UserContext 以 204 表示 signed-out）
 *   - 404 → User not found（token 中的 user_id 不存在）
 *
 * 该接口是官网 dashboard「用户身份」的数据源（前端 UserContext 按
 * `e.sub ?? e.email` 取身份）。导入 token 时用它把 user_xxx 换成可读的
 * 邮箱备注；失败静默降级（资料是增强信息，绝不阻塞导入主流程）。
 */

export interface CursorAccountProfile {
  email?: string
  name?: string
  /** 官网用户 id（`user_xxx`，与 WST 前缀一致）。 */
  sub?: string
  /** 账号注册时间（ISO 8601）。 */
  createdAt?: string
}

export interface CursorAccountProfileFetcherOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

interface ProfileResponse {
  email?: unknown
  name?: unknown
  sub?: unknown
  created_at?: unknown
}

const DEFAULT_BASE_URL = 'https://cursor.com'
const DEFAULT_TIMEOUT_MS = 8_000

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLength) : undefined
}

export class CursorAccountProfileFetcher {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: CursorAccountProfileFetcherOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * 用 WorkosCursorSessionToken（`user_xxx::eyJ...` 完整形态或裸 JWT）识别账号资料。
   * 任何失败（网络 / 会话失效 / 响应异常）都返回 undefined——调用方降级用 userId。
   */
  async fetch(sessionToken: string): Promise<CursorAccountProfile | undefined> {
    const token = sessionToken.trim()
    if (!token) return undefined
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/api/auth/me`, {
          method: 'GET',
          headers: {
            Cookie: `WorkosCursorSessionToken=${encodeURIComponent(token)}`,
            Accept: 'application/json'
          },
          redirect: 'manual',
          signal: controller.signal
        })
        if (response.status !== 200) return undefined
        const parsed = await response.json().catch(() => undefined) as ProfileResponse | undefined
        if (!parsed || typeof parsed !== 'object') return undefined
        return {
          email: text(parsed.email, 200),
          name: text(parsed.name, 120),
          sub: text(parsed.sub, 80),
          createdAt: text(parsed.created_at, 40)
        }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return undefined
    }
  }
}

/** vault.save 的 label 上限（与 CursorAccountVault 的校验一致，超限会抛错）。 */
const LABEL_MAX_LENGTH = 80

/**
 * 由 profile 生成账号备注（导入链路的 label 单一来源）。
 * 优先 email；无 email 时回落 userId；都缺省时用「Cursor 账号」。
 *
 * 总长恒 ≤ 80（vault.save 硬约束）：超长 email 截断主体保域名，
 * 「资料是增强信息，绝不阻塞导入」——任何输入都不能让这里产出非法 label。
 */
export function profileLabel(profile: CursorAccountProfile | undefined, userId: string, suffix: string): string {
  const wrapped = `（${suffix}）`
  const budget = LABEL_MAX_LENGTH - wrapped.length
  const email = profile?.email
  const base = fitLabelBase(email, userId, budget)
  return `${base}${wrapped}`
}

function fitLabelBase(email: string | undefined, userId: string, budget: number): string {
  if (email && email.length <= budget) return email
  if (email) {
    // 超长 email：保域名（辨识度最高），主体截断加省略号
    const at = email.lastIndexOf('@')
    const domain = at > 0 ? email.slice(at) : ''
    const keep = Math.max(1, budget - 1 - domain.length)
    return `${email.slice(0, keep)}…${domain}`
  }
  if (userId && userId.length <= budget) return userId
  if (userId) return `${userId.slice(0, Math.max(1, budget - 1))}…`
  return 'Cursor 账号'.slice(0, Math.max(1, budget))
}
