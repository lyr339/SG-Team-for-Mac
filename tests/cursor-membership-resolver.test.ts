import { describe, expect, it, vi } from 'vitest'
import { resolveCursorMembership } from '../src/application/cursor-membership-resolver'

function jwt(sub: string, suffix: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub, marker: suffix })).toString('base64url')
  return `${header}.${payload}.${suffix}`
}

describe('resolveCursorMembership', () => {
  it('uses the runtime credential first and returns successful profile directly', async () => {
    const fetch = vi.fn().mockResolvedValue({ state: 'ok', profile: { tier: 'pro', raw: 'pro', fetchedAt: 1 } })
    const status = await resolveCursorMembership({ runtimeToken: jwt('user-a', 'a'), activeToken: jwt('user-a', 'b'), fetch })
    expect(status.state).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to a same-sub active vault credential when the local runtime token was revoked', async () => {
    const runtime = jwt('user-a', 'old')
    const active = `user_01ABC::${jwt('user-a', 'fresh')}`
    const fetch = vi.fn()
      .mockResolvedValueOnce({ state: 'auth_expired', detail: '401' })
      .mockResolvedValueOnce({ state: 'ok', profile: { tier: 'pro_plus', raw: 'pro_plus', fetchedAt: 2 } })
    const status = await resolveCursorMembership({ runtimeToken: runtime, activeToken: active, fetch })
    expect(status).toMatchObject({ state: 'ok', profile: { tier: 'pro_plus' } })
    expect(fetch).toHaveBeenNthCalledWith(2, active.replace(/^user_[A-Za-z0-9]+::/, ''))
  })

  it('does not cross account boundaries and explains locally present but server-revoked auth', async () => {
    const fetch = vi.fn().mockResolvedValue({ state: 'auth_expired', detail: '401' })
    const status = await resolveCursorMembership({
      runtimeToken: jwt('user-a', 'old'),
      activeToken: jwt('user-b', 'fresh'),
      fetch
    })
    expect(status).toEqual({
      state: 'auth_expired',
      detail: 'Cursor 本地登录记录仍在，但服务端会话已撤销；请重新登录并执行「切换并重启」'
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
