import type { CursorMembershipStatus } from '../../../domain/cursor-membership'

/**
 * 批量发起会话前的会员档位闸门决策（纯函数，便于单测）。
 *
 * 决策矩阵（fail-closed：过闸必须有在线权威结果）：
 * - ok + free                → 硬阻断（无「仍要发起」——产品约定 free 不能发起批量会话）
 * - ok + 其他档位/unknown    → 放行（unknown = 服务端新档位值，绝非 free）
 * - not_logged_in            → 阻断（运行态闸应已拦截，此为纵深防御）
 * - auth_expired             → 阻断（token 已死，会话必成僵尸）
 * - error                    → 阻断 + 引导刷新重试（断网时批量会话本也跑不动）
 */
export interface MembershipGateDecision {
  action: 'proceed' | 'dialog'
  message: string
}

export function resolveMembershipLaunchGate(status: CursorMembershipStatus | undefined): MembershipGateDecision {
  if (!status) return { action: 'proceed', message: '' }
  if (status.state === 'ok') {
    const profile = status.profile
    if (profile?.tier === 'free') {
      return {
        action: 'dialog',
        message: '当前 Cursor 账号为 Free 档位，无法发起批量会话。请先在账号管线对该账号执行「处理」（或更换已处理账号）后，回到此弹窗刷新档位。'
      }
    }
    return { action: 'proceed', message: '' }
  }
  if (status.state === 'not_logged_in') {
    return { action: 'dialog', message: '无法确认账号档位：Cursor 未登录。请先登录或切换账号。' }
  }
  if (status.state === 'auth_expired') {
    return { action: 'dialog', message: '无法确认账号档位：登录已过期（服务端 401）。请切换并重启或重新导入账号。' }
  }
  return {
    action: 'dialog',
    message: `无法确认账号档位（${status.detail ?? '网络错误'}）。批量会话前必须确认档位，请检查网络后点击「刷新档位并继续」。`
  }
}
