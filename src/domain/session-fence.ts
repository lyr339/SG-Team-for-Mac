import type { TeamRunStatus } from './team-control'

/**
 * 会话围栏（session fence）。
 *
 * 通道号是全局单例：同一个 CH-N 上可能先后存在独立批次的旧 Cursor 会话与新团队
 * 的新会话；MCP 进程又是整个 Cursor 共享一个，服务端仅凭 channel_id 分不清调用者。
 * 此前只能靠「等旧会话全部离线」（120s 心跳窗 / processing 5 分钟宽限）来仲裁模式
 * 切换。围栏把仲裁改成显式：每个 (run, slot) 绑定签发一个 session 令牌随开场提示
 * 交给该会话；通信工具携带令牌时，服务端按当前 run 的归属校验——不匹配即返回终态
 * `retired`，旧会话在下一次轮询就自行退出，且不刷新新席位的 presence。
 *
 * 不携带令牌的调用（升级前创建的会话、手动发起的会话、备用接替）保持原有行为。
 */
export interface ChannelSessionOwnership {
  runId: string
  runStatus: TeamRunStatus
  /** 该通道是否绑定在当前 run 的某个席位上。 */
  bound: boolean
  /** 当前席位签发的令牌；缺失 = 未签发（旧会话 / 备用接替）。 */
  sessionToken?: string
  solo: boolean
}

export type SessionFenceRetiredReason = 'no_run' | 'run_completed' | 'channel_unbound' | 'token_mismatch'

export type SessionFenceVerdict =
  | { status: 'ok' }
  /** 调用未携带令牌：无法分辨新旧，按既有语义放行。 */
  | { status: 'legacy' }
  | { status: 'retired'; reason: SessionFenceRetiredReason }

const SESSION_TOKEN_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/

export function isValidSessionToken(value: unknown): value is string {
  return typeof value === 'string' && SESSION_TOKEN_PATTERN.test(value.trim())
}

export function evaluateSessionFence(
  ownership: ChannelSessionOwnership | undefined,
  presented: string | undefined
): SessionFenceVerdict {
  const token = typeof presented === 'string' ? presented.trim() : ''
  if (!token) return { status: 'legacy' }
  if (!ownership) return { status: 'retired', reason: 'no_run' }
  if (ownership.runStatus === 'completed') return { status: 'retired', reason: 'run_completed' }
  if (!ownership.bound) return { status: 'retired', reason: 'channel_unbound' }
  // 席位未签发令牌却有人出示令牌：只可能是被换掉的旧会话。
  if (!ownership.sessionToken || ownership.sessionToken !== token) {
    return { status: 'retired', reason: 'token_mismatch' }
  }
  return { status: 'ok' }
}

/** 围栏拒绝文案：明确这是服务端终止指令，等同用户要求停止，防止模型把它当成可重试错误。 */
export function buildSessionRetiredText(input: { channelId: string; reason: SessionFenceRetiredReason }): string {
  const cause = input.reason === 'run_completed'
    ? '本轮运行已结束'
    : input.reason === 'no_run'
      ? '当前没有活动运行'
      : input.reason === 'channel_unbound'
        ? `CH-${input.channelId} 不再属于当前运行`
        : `CH-${input.channelId} 已由新的会话接管`
  return [
    `[system] 会话围栏：${cause}，本会话持有的 session 令牌已失效。`,
    '这是服务端的终止指令，等同于用户要求停止：不要再调用 check_messages / record_reply，',
    '不要输出可见回复，不要重试；直接结束本回合。如需继续使用拾光，请在拾光中重新创建会话。'
  ].join('')
}
