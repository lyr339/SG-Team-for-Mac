import { describe, expect, it } from 'vitest'
import { CursorAccountDeleter } from '../src/infrastructure/cursor/cursor-account-deleter'

interface FakeCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  redirect?: string
}

function createDeleter(options: {
  csrfToken?: string
  deleteStatus?: number
  deleteBody?: unknown
}) {
  const calls: FakeCall[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: target, method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : undefined, redirect: init?.redirect })
    if (target.endsWith('/api/csrf-token')) {
      const headerList = new Headers()
      if (options.csrfToken) headerList.append('set-cookie', `csrf-token=${options.csrfToken}; Path=/; SameSite=Lax`)
      return new Response('{}', { status: 200, headers: headerList })
    }
    if (target.endsWith('/api/dashboard/delete-account')) {
      const status = options.deleteStatus ?? 200
      const body = options.deleteBody ?? {}
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { deleter: new CursorAccountDeleter({ fetchImpl }), calls }
}

describe('CursorAccountDeleter', () => {
  it('先铸造 CSRF 再 POST 删除端点（空 JSON body + 完整凭证头）', async () => {
    const { deleter, calls } = createDeleter({ csrfToken: 'csrf-abc' })
    const result = await deleter.deleteAccount('user_x::token-value')
    expect(result.ok).toBe(true)

    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.url).toBe('https://cursor.com/api/csrf-token')
    expect(calls[0]?.headers.Cookie).toContain('WorkosCursorSessionToken=')

    const deleteCall = calls[1]
    expect(deleteCall?.method).toBe('POST')
    expect(deleteCall?.url).toBe('https://cursor.com/api/dashboard/delete-account')
    expect(deleteCall?.body).toBe('{}')
    expect(deleteCall?.headers['Content-Type']).toBe('application/json')
    expect(deleteCall?.headers['x-csrf-token']).toBe('csrf-abc')
    expect(deleteCall?.headers.Cookie).toContain('csrf-token=csrf-abc')
    expect(deleteCall?.headers.Origin).toBe('https://cursor.com')
    // token 需经 URL 编码（:: → %3A%3A，与浏览器存储形态一致）
    expect(deleteCall?.headers.Cookie).toContain(encodeURIComponent('user_x::token-value'))
  })

  it('CSRF 铸造失败时仍然尝试删除（不带 csrf 头）', async () => {
    const { deleter, calls } = createDeleter({ csrfToken: undefined })
    const result = await deleter.deleteAccount('token')
    expect(result.ok).toBe(true)
    expect(calls[1]?.headers['x-csrf-token']).toBeUndefined()
  })

  it('服务端业务错误透出 error.message', async () => {
    const { deleter } = createDeleter({
      csrfToken: 'c',
      deleteStatus: 400,
      deleteBody: { error: { message: 'workspace has active subscription' } }
    })
    const result = await deleter.deleteAccount('token')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('active subscription')
  })

  it('401/403 → 提示会话失效并标记 authExpired', async () => {
    const { deleter } = createDeleter({ csrfToken: 'c', deleteStatus: 401, deleteBody: {} })
    const result = await deleter.deleteAccount('token')
    expect(result.ok).toBe(false)
    expect(result.authExpired).toBe(true)
    expect(result.message).toContain('会话可能已失效')
  })

  it('307 重定向不跟随（redirect: manual），直接标记 authExpired', async () => {
    const { deleter, calls } = createDeleter({ csrfToken: 'c', deleteStatus: 307, deleteBody: '' })
    const result = await deleter.deleteAccount('token')
    expect(result.ok).toBe(false)
    expect(result.authExpired).toBe(true)
    expect(result.message).toContain('会话已失效')
    expect(calls.every((call) => call.redirect === 'manual')).toBe(true)
  })

  it('官网要求先退出团队 → 标记 needLeaveTeam（供链路等待重试，不识败）', async () => {
    const { deleter } = createDeleter({
      csrfToken: 'c',
      deleteStatus: 400,
      deleteBody: { error: { message: 'Please leave the team before deleting your account.' } }
    })
    const result = await deleter.deleteAccount('token')
    expect(result.ok).toBe(false)
    expect(result.needLeaveTeam).toBe(true)
    expect(result.authExpired).toBeUndefined()
    expect(result.message).toContain('leave the team')
  })

  it('空 token 直接拒绝', async () => {
    const { deleter, calls } = createDeleter({})
    const result = await deleter.deleteAccount('  ')
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
