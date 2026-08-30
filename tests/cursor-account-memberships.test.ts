import { describe, expect, it } from 'vitest'
import { fetchCursorAccountMemberships } from '../src/application/cursor-account-memberships'

const accounts = [
  { id: 'a', label: 'A', maskedToken: '••••a', active: true, createdAt: 1, updatedAt: 1 },
  { id: 'b', label: 'B', maskedToken: '••••b', active: false, createdAt: 1, updatedAt: 1 },
  { id: 'c', label: 'C', maskedToken: '••••c', active: false, createdAt: 1, updatedAt: 1 }
]

describe('fetchCursorAccountMemberships', () => {
  it('不依赖活跃账号，为库存中每个账号独立查询档位', async () => {
    const seen: string[] = []
    const result = await fetchCursorAccountMemberships({
      list: () => accounts,
      credential: (id) => `token-${id}`
    }, async (token) => {
      seen.push(token)
      return { state: 'ok', profile: { tier: token === 'token-a' ? 'free' : 'pro', raw: '', fetchedAt: 1 } }
    })
    expect(seen.sort()).toEqual(['token-a', 'token-b', 'token-c'])
    expect(result.a?.profile?.tier).toBe('free')
    expect(result.b?.profile?.tier).toBe('pro')
    expect(result.c?.profile?.tier).toBe('pro')
  })

  it('网页导入的复合 Session Token 会剥离 user 前缀后再作为 Bearer 查询', async () => {
    const seen: string[] = []
    await fetchCursorAccountMemberships({
      list: () => [accounts[0]!],
      credential: () => 'user_abc::header.payload.signature'
    }, async (token) => {
      seen.push(token)
      return { state: 'ok', profile: { tier: 'free', raw: 'free', fetchedAt: 1 } }
    })
    expect(seen).toEqual(['header.payload.signature'])
  })

  it('指定刷新单个账号时不读取其他凭据；单账号失败不影响其余结果', async () => {
    const credentials: string[] = []
    const source = {
      list: () => accounts,
      credential: (id: string) => { credentials.push(id); return `token-${id}` }
    }
    const one = await fetchCursorAccountMemberships(source, async () => ({
      state: 'ok', profile: { tier: 'ultra', raw: 'ultra', fetchedAt: 1 }
    }), ['b'])
    expect(credentials).toEqual(['b'])
    expect(Object.keys(one)).toEqual(['b'])

    const all = await fetchCursorAccountMemberships(source, async (token) => {
      if (token === 'token-b') throw new Error('vault broken')
      return { state: 'ok', profile: { tier: 'free', raw: 'free', fetchedAt: 1 } }
    })
    expect(all.a?.state).toBe('ok')
    expect(all.b).toEqual({ state: 'error', detail: 'vault broken' })
    expect(all.c?.state).toBe('ok')
  })
})
