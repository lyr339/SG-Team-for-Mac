import type { CursorMembershipStatus } from '../domain/cursor-membership'
import { cursorBareJwt, cursorJwtSubject } from './cursor-runtime-account-verify'

export interface CursorMembershipResolverInput {
  runtimeToken: string
  activeToken?: string
  fetch: (token: string) => Promise<CursorMembershipStatus>
}

/**
 * 会员档位的双凭据解析：优先 Cursor 运行态；运行态被服务端撤销时，仅在 vault
 * 活跃账号与运行态 JWT sub 一致时尝试活跃凭据，避免跨账号读取档位。
 */
export async function resolveCursorMembership(input: CursorMembershipResolverInput): Promise<CursorMembershipStatus> {
  const runtimeToken = cursorBareJwt(input.runtimeToken)
  const primary = await input.fetch(runtimeToken)
  if (primary.state !== 'auth_expired') return primary

  const activeToken = input.activeToken ? cursorBareJwt(input.activeToken) : ''
  const runtimeSubject = cursorJwtSubject(runtimeToken)
  const activeSubject = cursorJwtSubject(activeToken)
  if (!activeToken || !runtimeSubject || runtimeSubject !== activeSubject || activeToken === runtimeToken) {
    return {
      state: 'auth_expired',
      detail: 'Cursor 本地登录记录仍在，但服务端会话已撤销；请重新登录并执行「切换并重启」'
    }
  }

  const fallback = await input.fetch(activeToken)
  if (fallback.state === 'ok') return fallback
  if (fallback.state === 'error') return fallback
  return {
    state: 'auth_expired',
    detail: 'Cursor 与拾光保存的同账号会话均已被服务端撤销；请重新登录后重新导入 Token'
  }
}
