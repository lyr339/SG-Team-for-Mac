import { describe, expect, it } from 'vitest'
import { CursorMembershipFetcher } from '../src/infrastructure/cursor/cursor-membership-profile'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function fetcherWith(respond: (url: string, init?: RequestInit) => Promise<Response>): CursorMembershipFetcher {
  return new CursorMembershipFetcher({ fetchImpl: respond as unknown as typeof fetch, now: () => 1_000 })
}

const PROFILE = {
  membershipType: 'free',
  paymentId: 'cus_test',
  isTeamMember: false,
  lastPaymentFailed: false
}

describe('CursorMembershipFetcher', () => {
  it('200 + free 档位 → ok/free（无试用字段语义，free 即 free）', async () => {
    const fetcher = fetcherWith(async () => jsonResponse(PROFILE))
    const status = await fetcher.fetch('jwt-token')
    expect(status.state).toBe('ok')
    expect(status.profile?.tier).toBe('free')
    expect(status.profile?.isTeamMember).toBe(false)
    expect(status.profile?.fetchedAt).toBe(1_000)
  })

  it('200 + pro 档位 → ok/pro（Bearer 头携带运行时 token）', async () => {
    let authHeader = ''
    const fetcher = fetcherWith(async (_url, init) => {
      authHeader = String((init?.headers as Record<string, string>).Authorization)
      return jsonResponse({ ...PROFILE, membershipType: 'pro' })
    })
    const status = await fetcher.fetch('jwt-token')
    expect(authHeader).toBe('Bearer jwt-token')
    expect(status.profile?.tier).toBe('pro')
  })

  it('membershipType 缺失 → free（镜像 Cursor 客户端 i = i ?? FREE 语义）', async () => {
    const fetcher = fetcherWith(async () => jsonResponse({ paymentId: 'cus_x' }))
    const status = await fetcher.fetch('t')
    expect(status.state).toBe('ok')
    expect(status.profile?.tier).toBe('free')
  })

  it('枚举外新值 → unknown 且保留 raw（前向兼容，不误判 free）', async () => {
    const fetcher = fetcherWith(async () => jsonResponse({ membershipType: 'ultra_max_new' }))
    const status = await fetcher.fetch('t')
    expect(status.profile?.tier).toBe('unknown')
    expect(status.profile?.raw).toBe('ultra_max_new')
  })

  it('401 → auth_expired；其他非 2xx → error 带状态码', async () => {
    expect((await fetcherWith(async () => jsonResponse({}, 401)).fetch('t')).state).toBe('auth_expired')
    const errored = await fetcherWith(async () => jsonResponse({}, 503)).fetch('t')
    expect(errored.state).toBe('error')
    expect(errored.detail).toContain('503')
  })

  it('响应非 JSON 对象（如旧端点的 "false" 字符串）→ error 响应格式异常', async () => {
    const fetcher = fetcherWith(async () => jsonResponse('false'))
    const status = await fetcher.fetch('t')
    expect(status.state).toBe('error')
    expect(status.detail).toContain('格式异常')
  })

  it('网络抛错/超时 → error；空 token → not_logged_in', async () => {
    const failed = await fetcherWith(async () => { throw new Error('fetch failed') }).fetch('t')
    expect(failed.state).toBe('error')
    expect(failed.detail).toContain('fetch failed')
    const empty = await fetcherWith(async () => jsonResponse(PROFILE)).fetch('   ')
    expect(empty.state).toBe('not_logged_in')
  })

  it('请求打到注入的 baseUrl（生产默认 api2.cursor.sh 的 /auth/full_stripe_profile）', async () => {
    let called = ''
    const fetcher = new CursorMembershipFetcher({ baseUrl: 'https://example.test/', fetchImpl: (async (url: string) => {
      called = url
      return jsonResponse(PROFILE)
    }) as unknown as typeof fetch })
    await fetcher.fetch('t')
    expect(called).toBe('https://example.test/auth/full_stripe_profile')
  })
})
