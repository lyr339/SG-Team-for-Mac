import type { CursorMembershipStatus, CursorMembershipTier } from '../../domain/cursor-membership'
import { CURSOR_MEMBERSHIP_TIERS } from '../../domain/cursor-membership'

export interface CursorMembershipFetcherOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => number
}

const DEFAULT_BASE_URL = 'https://api2.cursor.sh'
const DEFAULT_TIMEOUT_MS = 8_000

interface ProfileResponse {
  membershipType?: unknown
  isTeamMember?: unknown
  lastPaymentFailed?: unknown
}

function boundedDetail(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason ?? '')
  return text.replace(/\s+/g, ' ').trim().slice(0, 120)
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Cursor 会员档位在线抓取器（逆向实证：编辑器 authenticationService.refreshMembership
 * 的同款数据源；生产 backendUrl 常量为 api2.cursor.sh，api.cursor.com 上该路由不存在）。
 *
 * token 明文只在主进程内流转，不经过渲染进程。抓取失败返回 error 状态
 * （fail-closed 语义由调用方的闸门决定，这里只如实报告）。
 */
export class CursorMembershipFetcher {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(options: CursorMembershipFetcherOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = options.now ?? Date.now
  }

  async fetch(accessToken: string): Promise<CursorMembershipStatus> {
    const token = accessToken.trim()
    if (!token) return { state: 'not_logged_in', detail: '缺少运行时访问令牌' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/auth/full_stripe_profile`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: controller.signal
      })
    } catch (reason) {
      const detail = boundedDetail(reason)
      return { state: 'error', detail: detail.includes('abort') ? `网络超时（${Math.round(this.timeoutMs / 1000)}s）` : `网络错误：${detail || '请求未能送达'}` }
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 401) {
      return { state: 'auth_expired', detail: '服务端已撤销当前会话（HTTP 401）' }
    }
    if (!response.ok) {
      return { state: 'error', detail: `服务端响应 HTTP ${response.status}` }
    }

    const parsed: unknown = await response.json().catch(() => undefined)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: 'error', detail: '响应格式异常（非 JSON 对象）' }
    }
    const data = parsed as ProfileResponse
    const raw = typeof data.membershipType === 'string' ? data.membershipType.trim() : ''
    // 与 Cursor 客户端同语义：membershipType 缺失 → free（storeMembershipType 内 i = i ?? FREE）；
    // 枚举外的新值 → unknown（前向兼容：新档位绝非 free，不误拦付费用户）。
    const tier: CursorMembershipTier | 'unknown' = raw === ''
      ? 'free'
      : (CURSOR_MEMBERSHIP_TIERS as readonly string[]).includes(raw)
        ? raw as CursorMembershipTier
        : 'unknown'
    return {
      state: 'ok',
      profile: {
        tier,
        raw,
        isTeamMember: booleanOf(data.isTeamMember),
        lastPaymentFailed: booleanOf(data.lastPaymentFailed),
        fetchedAt: this.now()
      }
    }
  }
}
