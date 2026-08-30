import { describe, expect, it } from 'vitest'
import { CursorAccountDeleter, parseRetryAfterSec } from '../src/infrastructure/cursor/cursor-account-deleter'

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
  /** 原始响应体（优先于 deleteBody，用于构造非 JSON 响应）。 */
  deleteRawBody?: string
  /** 删除响应的额外响应头（如 Retry-After）。 */
  deleteHeaders?: Record<string, string>
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
      const raw = options.deleteRawBody ?? JSON.stringify(options.deleteBody ?? {})
      return new Response(raw, { status, headers: { 'Content-Type': 'application/json', ...options.deleteHeaders } })
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

  it('429 + Retry-After → 标记 rateLimited，诊断含状态码/Retry-After/响应体', async () => {
    const { deleter } = createDeleter({
      csrfToken: 'c',
      deleteStatus: 429,
      deleteHeaders: { 'Retry-After': '20' },
      deleteBody: { error: { message: 'Try again later' } }
    })
    const result = await deleter.deleteAccount('token')
    expect(result.ok).toBe(false)
    expect(result.rateLimited).toBe(true)
    expect(result.status).toBe(429)
    expect(result.retryAfterSec).toBe(20)
    expect(result.authExpired).toBeUndefined()
    // 「官网删除账号失败：」前缀被 UI 依赖，必须保留
    expect(result.message.startsWith('官网删除账号失败：')).toBe(true)
    expect(result.message).toContain('HTTP 429')
    expect(result.message).toContain('Retry-After 20s')
    expect(result.message).toContain('Try again later')
  })

  it('正文含 "Try again later"（无 429/Retry-After）→ 仍识别为限流', async () => {
    const { deleter } = createDeleter({
      csrfToken: 'c',
      deleteStatus: 400,
      deleteBody: { error: { message: 'Try again later' } }
    })
    const result = await deleter.deleteAccount('token')
    expect(result.ok).toBe(false)
    expect(result.rateLimited).toBe(true)
    expect(result.status).toBe(400)
    expect(result.retryAfterSec).toBeUndefined()
  })

  it('5xx + Retry-After（HTTP-date）→ 标记 rateLimited 并解析秒数', async () => {
    const { deleter } = createDeleter({
      csrfToken: 'c',
      deleteStatus: 503,
      deleteHeaders: { 'Retry-After': new Date(Date.now() + 30_000).toUTCString() },
      deleteRawBody: 'Service Unavailable'
    })
    const result = await deleter.deleteAccount('token')
    expect(result.ok).toBe(false)
    expect(result.rateLimited).toBe(true)
    expect(result.status).toBe(503)
    expect(result.retryAfterSec).toBeGreaterThan(0)
    expect(result.retryAfterSec).toBeLessThanOrEqual(30)
    expect(result.message).toContain('Service Unavailable')
  })

  it('403 封锁（无限流信号）→ 仍判 authExpired，不误标 rateLimited', async () => {
    const { deleter } = createDeleter({ csrfToken: 'c', deleteStatus: 403, deleteBody: { error: { message: 'Forbidden' } } })
    const result = await deleter.deleteAccount('token')
    expect(result.ok).toBe(false)
    expect(result.authExpired).toBe(true)
    expect(result.rateLimited).toBeUndefined()
    expect(result.status).toBe(403)
  })

  it('响应体截断 ≤160 字符（超长 HTML 错误页）', async () => {
    const { deleter } = createDeleter({
      csrfToken: 'c',
      deleteStatus: 502,
      deleteRawBody: `<html>${'x'.repeat(400)}</html>`
    })
    const result = await deleter.deleteAccount('token')
    expect(result.ok).toBe(false)
    expect(result.rateLimited).toBeUndefined()
    expect(result.message).toContain('HTTP 502')
    const snippet = result.message.split('：').pop() ?? ''
    expect(snippet.length).toBeLessThanOrEqual(160)
    expect(snippet.startsWith('<html>')).toBe(true)
  })
})

describe('parseRetryAfterSec', () => {
  it('解析非负整数秒', () => {
    expect(parseRetryAfterSec('20', 0)).toBe(20)
    expect(parseRetryAfterSec('0', 0)).toBe(0)
    expect(parseRetryAfterSec(' 120 ', 0)).toBe(120)
  })

  it('解析 HTTP-date 并按当前时间折算', () => {
    const now = Date.parse('2026-08-27T05:00:00Z')
    expect(parseRetryAfterSec('Thu, 27 Aug 2026 05:00:45 GMT', now)).toBe(45)
    // 过去的日期钳到 0
    expect(parseRetryAfterSec('Thu, 27 Aug 2026 04:59:00 GMT', now)).toBe(0)
  })

  it('非法/缺失输入返回 undefined', () => {
    expect(parseRetryAfterSec(null, 0)).toBeUndefined()
    expect(parseRetryAfterSec(undefined, 0)).toBeUndefined()
    expect(parseRetryAfterSec('', 0)).toBeUndefined()
    expect(parseRetryAfterSec('later', 0)).toBeUndefined()
    expect(parseRetryAfterSec(';;;', 0)).toBeUndefined()
  })
})
