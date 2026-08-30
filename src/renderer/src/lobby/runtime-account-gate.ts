import type { CursorRuntimeAccountMatch } from '../../../domain/cursor-account'

/**
 * 发起会话前的运行态闸门决策（纯函数，便于单测）。
 *
 * 决策矩阵：
 * - matched / vault_empty → 放行（无活跃账号时本核对不适用，自动化另有拦截）
 * - mismatch + 自动化开启 → 弹窗且不给「仍要发起」：继续 = 删错官网账号
 * - mismatch + 自动化关闭 → 静默放行（无害：不消耗卡密、不删号）
 * - cursor_unavailable → 弹窗（会话必成僵尸）；自动化关闭时保留「仍要发起」逃生门，
 *   开启时同样保留——该状态无删错号风险，只是浪费，交用户判断
 */
export interface RuntimeLaunchGateDecision {
  action: 'proceed' | 'dialog'
  /** dialog 时是否提供「仍要发起」次按钮。 */
  allowProceed: boolean
  /** dialog 时的主行动标签；proceed 时为空。 */
  message: string
}

export function resolveRuntimeLaunchGate(input: {
  verify: CursorRuntimeAccountMatch | undefined
  automationEnabled: boolean
  /** vault 是否有活跃账号（决定弹窗能否提供「切换并重启」修复动作）。 */
  hasActiveAccount: boolean
}): RuntimeLaunchGateDecision {
  const { verify, automationEnabled, hasActiveAccount } = input
  if (!verify) return { action: 'proceed', allowProceed: false, message: '' }
  if (verify.status === 'matched' || verify.status === 'vault_empty') {
    return { action: 'proceed', allowProceed: false, message: '' }
  }
  if (verify.status === 'mismatch' && !automationEnabled) {
    // 自动化关闭：删号链不会跑，劈叉无害——不打扰用户。
    return { action: 'proceed', allowProceed: false, message: '' }
  }
  if (verify.status === 'mismatch') {
    return {
      action: 'dialog',
      allowProceed: false,
      message: `Cursor 当前登录 ${verify.cursorLabel ?? '未知'}，与拾光活跃账号 ${verify.activeLabel ?? '未知'} 不一致。继续发起会话后，账号自动化会删除错误的官网账号——请先切换并重启。`
    }
  }
  return {
    action: 'dialog',
    allowProceed: true,
    message: hasActiveAccount
      ? `Cursor 当前未登录，会话将无法工作。可切换到活跃账号（${verify.detail ? `${verify.detail}；` : ''}切换后会自动继续发起会话）。`
      : `Cursor 当前未登录且拾光暂无活跃账号，会话将无法工作。${verify.detail ?? ''}`
  }
}
