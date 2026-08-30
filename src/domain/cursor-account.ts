export interface CursorAccountMetadata {
  id: string
  label: string
  maskedToken: string
  active: boolean
  createdAt: number
  updatedAt: number
}

/**
 * Cursor 运行时登录态与拾光活跃账号的一致性核对结果。
 *
 * 背景：会话创建消耗的是 Cursor 编辑器运行态（state.vscdb cursorAuth/*），
 * 账号自动化锚定的是 vault 活跃账号 + 浏览器宿主——两轨各自正常时互不校验，
 * 用户绕过拾光手动登录/换号会造成劈叉（删错官网账号 / 会话僵尸）。
 * 一致性锚点 = 两侧 JWT sub（用户唯一标识）。
 */
export type CursorRuntimeAccountMatchStatus =
  | 'matched'
  | 'mismatch'
  /** Cursor 无可用登录态（未登录 / 未安装 / token 损坏）。 */
  | 'cursor_unavailable'
  /** vault 无活跃账号（本核对不适用；自动化 preflight 另有拦截）。 */
  | 'vault_empty'

export interface CursorRuntimeAccountMatch {
  status: CursorRuntimeAccountMatchStatus
  /** Cursor 运行态身份显示（cachedEmail 优先，回落 JWT sub）。 */
  cursorLabel?: string
  /** vault 活跃账号身份显示（label 内邮箱优先，回落 JWT sub）。 */
  activeLabel?: string
  /** cursor_unavailable 时的底层原因（截断后的错误消息）。 */
  detail?: string
}
