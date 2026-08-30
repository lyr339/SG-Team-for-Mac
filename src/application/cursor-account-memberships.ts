import type { CursorAccountMetadata } from '../domain/cursor-account'
import type { CursorMembershipStatus } from '../domain/cursor-membership'
import { cursorBareJwt } from './cursor-runtime-account-verify'

export interface CursorAccountMembershipSource {
  list(): CursorAccountMetadata[]
  credential(accountId: string): string
}

export async function fetchCursorAccountMemberships(
  source: CursorAccountMembershipSource,
  fetchMembership: (token: string) => Promise<CursorMembershipStatus>,
  accountIds?: readonly string[],
  concurrency = 3
): Promise<Record<string, CursorMembershipStatus>> {
  const selected = accountIds ? new Set(accountIds) : undefined
  const accounts = source.list().filter((account) => !selected || selected.has(account.id))
  const results: Record<string, CursorMembershipStatus> = {}
  const batchSize = Math.max(1, Math.min(8, Math.floor(concurrency)))

  for (let offset = 0; offset < accounts.length; offset += batchSize) {
    await Promise.all(accounts.slice(offset, offset + batchSize).map(async (account) => {
      try {
        // vault 既可能保存裸 JWT，也可能保存网页 Cookie 的 user_xxx::JWT 复合值；
        // full_stripe_profile 的 Bearer 只接受裸 JWT，必须与活跃账号 resolver 同一归一化规则。
        results[account.id] = await fetchMembership(cursorBareJwt(source.credential(account.id)))
      } catch (reason) {
        const detail = reason instanceof Error ? reason.message : String(reason ?? '')
        results[account.id] = {
          state: 'error',
          detail: detail.replace(/\s+/g, ' ').trim().slice(0, 120)
        }
      }
    }))
  }
  return results
}
