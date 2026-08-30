import type { CursorRuntimeAccountMatch } from '../domain/cursor-account'

export interface CursorRuntimeAccountVerifyDeps {
  /** 读 Cursor 运行时登录态（CursorTokenImporter.import 形状）；throw 视为 cursor_unavailable。 */
  readRuntime: () => { token: string; email?: string; sub?: string }
  /** 读 vault 活跃账号；无活跃账号返回 undefined（credential 解密失败由调用方语境决定）。 */
  readActiveAccount: () => { token: string; label?: string } | undefined
}

/** 账号备注常带「（网页登录）」等来源后缀；显示身份只取纯邮箱部分（与切换编排同规则）。 */
function emailFromLabel(label: string | undefined): string | undefined {
  const candidate = label?.replace(/（.*?）\s*$/, '').trim()
  return candidate && /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate : undefined
}

/**
 * 解出 JWT sub（非 throw 版）：输入可以是裸 JWT 或 WorkosCursorSessionToken
 * 复合形态（user_xxx::jwt，浏览器/网页导入链路保存的格式）。
 * 格式非法返回 undefined（调用方按「无有效身份」分支处理）。
 */
export function cursorBareJwt(token: string): string {
  return token.trim().replace(/^user_[A-Za-z0-9]+::/, '')
}

export function cursorJwtSubject(token: string): string | undefined {
  const bare = cursorBareJwt(token)
  const payload = bare.split('.')[1]
  if (!payload) return undefined
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const parsed = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as { sub?: unknown }
    return typeof parsed.sub === 'string' && parsed.sub.trim() ? parsed.sub.trim() : undefined
  } catch {
    return undefined
  }
}

function boundedDetail(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason ?? '')
  return text.replace(/\s+/g, ' ').trim().slice(0, 120)
}

/**
 * 核对 Cursor 运行时登录态与 vault 活跃账号是否为同一账号（JWT sub 比对）。
 *
 * 两侧 token 格式差异已被归一化吸收：运行态恒为裸 JWT，vault 侧可能保存
 * WorkosCursorSessionToken 复合形态——按 sub 比对天然免疫前缀差异。
 * 一侧 sub 无法解析时保守判为不可用/不一致（提示重新导入），绝不给出假绿灯。
 */
export function verifyCursorRuntimeAccountMatch(deps: CursorRuntimeAccountVerifyDeps): CursorRuntimeAccountMatch {
  let runtime: { token: string; email?: string; sub?: string }
  try {
    runtime = deps.readRuntime()
  } catch (reason) {
    return { status: 'cursor_unavailable', detail: boundedDetail(reason) }
  }
  const runtimeSub = runtime.sub?.trim() || cursorJwtSubject(runtime.token)
  if (!runtimeSub) {
    return { status: 'cursor_unavailable', detail: '运行时 access token 无法解析出账号标识' }
  }
  const cursorLabel = runtime.email?.trim() || runtimeSub

  const active = deps.readActiveAccount()
  if (!active) return { status: 'vault_empty' }
  const activeSub = cursorJwtSubject(active.token)
  if (!activeSub) {
    // 活跃 token 非 JWT（导入脏数据）：保守判不一致并提示重新导入，不给假绿灯。
    return { status: 'mismatch', cursorLabel, activeLabel: active.label?.trim() || '未知' }
  }
  const activeLabel = emailFromLabel(active.label) || activeSub

  return runtimeSub === activeSub
    ? { status: 'matched', cursorLabel, activeLabel }
    : { status: 'mismatch', cursorLabel, activeLabel }
}

/** 核对结果的人话描述（弹窗/状态行/自动化失败消息共用单一来源）。 */
export function cursorRuntimeMatchMessage(match: CursorRuntimeAccountMatch): string {
  switch (match.status) {
    case 'matched':
      return `Cursor 登录态与活跃账号一致（${match.activeLabel ?? match.cursorLabel ?? '未知'}）`
    case 'mismatch':
      return `Cursor 当前登录 ${match.cursorLabel ?? '未知'}，与拾光活跃账号 ${match.activeLabel ?? '未知'} 不一致，请先执行「切换并重启」`
    case 'cursor_unavailable':
      return `Cursor 当前未登录（${match.detail ?? '未读取到登录态'}），会话将无法工作`
    case 'vault_empty':
      return '拾光尚未选择活跃账号'
  }
}
