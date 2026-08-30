/**
 * Cursor 账号会员档位（逆向实证 2026-08-30，workbench.desktop.main.js
 * authenticationService 的 Ga 枚举 + api2.cursor.sh/auth/full_stripe_profile 实测）：
 *
 * - 取值域封闭六值：free / free_trial / pro / pro_plus / ultra / enterprise
 * - Cursor 自带付费判定谓词：非 free 即"有档位"（ultra|pro|pro_plus|enterprise|free_trial）
 * - membershipType 缺失时 Cursor 自身按 FREE 落库（storeMembershipType 内 i = i ?? FREE）
 * - 在线权威源：GET https://api2.cursor.sh/auth/full_stripe_profile（Bearer 运行时
 *   accessToken）→ { membershipType, trialEligible, trialLengthDays, isTeamMember,
 *   lastPaymentFailed, ... }
 */

export const CURSOR_MEMBERSHIP_TIERS = ['free', 'free_trial', 'pro', 'pro_plus', 'ultra', 'enterprise'] as const

export type CursorMembershipTier = (typeof CURSOR_MEMBERSHIP_TIERS)[number]

export interface CursorMembershipProfile {
  /** 归一化档位；'unknown' = 服务端返回了枚举外的新值（前向兼容，绝非 free）。 */
  tier: CursorMembershipTier | 'unknown'
  /** 服务端原始 membershipType 字符串（unknown 时保留用于展示）。 */
  raw: string
  /** 是否在某团队中（与删除前的退团等待相关）。 */
  isTeamMember?: boolean
  /** 最近一次支付是否失败（账号健康度信号）。 */
  lastPaymentFailed?: boolean
  /** 获取时间（epoch ms）。 */
  fetchedAt: number
}

/**
 * 档位获取结果状态机：
 * - ok             拿到权威档位
 * - not_logged_in  运行态无登录（无 token 可用）
 * - auth_expired   服务端 401（运行时 token 已失效——批量会话必成僵尸）
 * - error          网络/超时/响应异常（fail-closed：过闸必须有权威结果）
 */
export type CursorMembershipStatusState = 'ok' | 'not_logged_in' | 'auth_expired' | 'error'

export interface CursorMembershipStatus {
  state: CursorMembershipStatusState
  profile?: CursorMembershipProfile
  /** 非 ok 状态的原因（截断后的可读文案）。 */
  detail?: string
}

/** 档位中文标签（弹窗/状态行/失败消息共用单一来源）。 */
export function cursorMembershipTierLabel(tier: CursorMembershipTier | 'unknown', raw?: string): string {
  switch (tier) {
    case 'free': return 'Free'
    case 'free_trial': return '试用'
    case 'pro': return 'Pro'
    case 'pro_plus': return 'Pro+'
    case 'ultra': return 'Ultra'
    case 'enterprise': return 'Enterprise'
    case 'unknown': return raw ? `未知档位（${raw.slice(0, 24)}）` : '未知档位'
  }
}
