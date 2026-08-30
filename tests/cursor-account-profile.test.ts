import { describe, expect, it, vi } from 'vitest'
import { CursorAccountProfileFetcher, profileLabel } from '../src/infrastructure/cursor/cursor-account-profile'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const REAL_PROFILE = {
  email: '95cf2uc2rle9@lakeground.shop',
  email_verified: true,
  name: 'Michael Garcia',
  sub: 'user_01M0T5A4ZHETNR5835M2MYBS0Z',
  created_at: '2026-08-24T15:13:06.022Z',
  updated_at: '2026-08-29T10:00:01.122Z',
  picture: '',
  id: 411693439,
  automation_client: false
}

describe('CursorAccountProfileFetcher', () => {
  it('200 → 解析 email/name/sub/createdAt（官网 /api/auth/me 实测契约）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(REAL_PROFILE))
    const fetcher = new CursorAccountProfileFetcher({ fetchImpl })
    const profile = await fetcher.fetch('user_01M0T5A4ZHETNR5835M2MYBS0Z::eyJ...')
    expect(profile).toEqual({
      email: '95cf2uc2rle9@lakeground.shop',
      name: 'Michael Garcia',
      sub: 'user_01M0T5A4ZHETNR5835M2MYBS0Z',
      createdAt: '2026-08-24T15:13:06.022Z'
    })
    // 认证形态：WST 完整值 URL 编码进 cookie（与浏览器一致）
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cursor.com/api/auth/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Cookie: `WorkosCursorSessionToken=${encodeURIComponent('user_01M0T5A4ZHETNR5835M2MYBS0Z::eyJ...')}`
        })
      })
    )
  })

  it('204（官网 signed-out 语义）→ undefined 降级', async () => {
    const fetcher = new CursorAccountProfileFetcher({ fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 204 })) })
    await expect(fetcher.fetch('user_x::jwt')).resolves.toBeUndefined()
  })

  it('404（User not found）→ undefined 降级', async () => {
    const fetcher = new CursorAccountProfileFetcher({
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ error: 'not found' }, 404))
    })
    await expect(fetcher.fetch('user_x::jwt')).resolves.toBeUndefined()
  })

  it('网络失败 / 非 JSON → undefined 降级（资料识别绝不阻塞导入）', async () => {
    const networkError = new CursorAccountProfileFetcher({
      fetchImpl: vi.fn().mockRejectedValue(new Error('fetch failed'))
    })
    await expect(networkError.fetch('user_x::jwt')).resolves.toBeUndefined()

    const badJson = new CursorAccountProfileFetcher({
      fetchImpl: vi.fn().mockResolvedValue(new Response('<html>not json</html>', { status: 200 }))
    })
    await expect(badJson.fetch('user_x::jwt')).resolves.toBeUndefined()
  })

  it('空 token → 直接 undefined（不发请求）', async () => {
    const fetchImpl = vi.fn()
    const fetcher = new CursorAccountProfileFetcher({ fetchImpl })
    await expect(fetcher.fetch('   ')).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('响应字段类型异常（email 为数字等）→ 剔除该字段而不整体失败', async () => {
    const fetcher = new CursorAccountProfileFetcher({
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ email: 123, sub: 'user_ok' }))
    })
    await expect(fetcher.fetch('user_ok::jwt')).resolves.toEqual({ sub: 'user_ok' })
  })
})

describe('profileLabel（导入 label 单一来源）', () => {
  it('有 email → email（来源后缀）', () => {
    expect(profileLabel({ email: 'a@b.com' }, 'user_x', 'Roxy指纹')).toBe('a@b.com（Roxy指纹）')
  })

  it('无 email → 回落 userId', () => {
    expect(profileLabel(undefined, 'user_x', 'Microsoft Edge')).toBe('user_x（Microsoft Edge）')
    expect(profileLabel({ name: '只有名字' }, 'user_x', 'Roxy指纹')).toBe('user_x（Roxy指纹）')
  })

  it('都缺省 → Cursor 账号', () => {
    expect(profileLabel(undefined, '', 'Roxy指纹')).toBe('Cursor 账号（Roxy指纹）')
  })

  it('超长 email → label 恒 ≤80（vault.save 硬约束），保域名加省略号', () => {
    const longEmail = `${'a'.repeat(120)}@example.com`
    for (const suffix of ['Roxy指纹', 'Microsoft Edge', '指纹浏览器']) {
      const label = profileLabel({ email: longEmail }, 'user_x', suffix)
      expect(label.length).toBeLessThanOrEqual(80)
      expect(label.endsWith(`（${suffix}）`)).toBe(true)
      // 域名保留（辨识度），主体被截断
      expect(label).toContain('@example.com')
      expect(label).toContain('…')
    }
  })

  it('超长 userId（无 email）→ 同样收敛 ≤80', () => {
    const longUserId = 'user_' + '9'.repeat(100)
    const label = profileLabel(undefined, longUserId, 'Roxy指纹')
    expect(label.length).toBeLessThanOrEqual(80)
    expect(label).toContain('…')
    expect(label.endsWith('（Roxy指纹）')).toBe(true)
  })

  it('极长后缀挤占预算 → 不抛错、base 保底可读（后缀长度属调用方契约，真实值恒 ≤8 码元）', () => {
    const label = profileLabel({ email: 'a@b.com' }, 'user_x', '很'.repeat(40))
    expect(label.length).toBeGreaterThan(0)
    expect(label.endsWith('）')).toBe(true)
  })

  it('email 与后缀合计恰好 ≤80 → 原样保留不截断', () => {
    const email = `${'b'.repeat(60)}@example.com` // 72 字符
    const label = profileLabel({ email }, 'user_x', '指纹') // 后缀 4 → 总 76
    expect(label).toBe(`${email}（指纹）`)
  })
})
