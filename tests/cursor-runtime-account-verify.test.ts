import { describe, expect, it } from 'vitest'
import {
  cursorRuntimeMatchMessage,
  verifyCursorRuntimeAccountMatch
} from '../src/application/cursor-runtime-account-verify'

/** 构造 JWT 形状测试 token（header.payload.sig，payload 仅需含 sub）。 */
function jwtOf(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub }), 'utf8').toString('base64url')
  return `header.${payload}.signature`
}

/** WorkosCursorSessionToken 复合形态（浏览器/网页导入链路保存的格式）。 */
function wstOf(sub: string): string {
  return `user_abc123::${jwtOf(sub)}`
}

function harness(input: {
  runtime?: { token?: string; email?: string; sub?: string; error?: string }
  active?: { token: string; label?: string } | undefined
}) {
  return verifyCursorRuntimeAccountMatch({
    readRuntime: () => {
      if (input.runtime?.error) throw new Error(input.runtime.error)
      return {
        token: input.runtime?.token ?? jwtOf('auth0|user_a'),
        email: input.runtime?.email,
        sub: input.runtime?.sub
      }
    },
    readActiveAccount: () => input.active
  })
}

describe('verifyCursorRuntimeAccountMatch', () => {
  it('两侧 sub 相同 → matched（运行态裸 JWT vs vault 裸 JWT）', () => {
    const result = harness({ active: { token: jwtOf('auth0|user_a'), label: 'a@x.com（指纹浏览器）' } })
    expect(result.status).toBe('matched')
    // 运行态无 email 时 cursorLabel 回落 sub；activeLabel 从 label 剥来源后缀取邮箱
    expect(result.cursorLabel).toBe('auth0|user_a')
    expect(result.activeLabel).toBe('a@x.com')
  })

  it('vault 保存 WST 复合形态 → 剥前缀后按 sub 比对仍 matched（格式差异免疫）', () => {
    const result = harness({ active: { token: wstOf('auth0|user_a'), label: 'user_xxx（网页登录）' } })
    expect(result.status).toBe('matched')
  })

  it('sub 不同 → mismatch，两侧 label 各自可读（email 优先，回落 sub）', () => {
    const result = harness({
      runtime: { token: jwtOf('auth0|user_b'), email: 'b@x.com' },
      active: { token: jwtOf('auth0|user_a'), label: 'a@x.com（本机 Cursor）' }
    })
    expect(result.status).toBe('mismatch')
    expect(result.cursorLabel).toBe('b@x.com')
    expect(result.activeLabel).toBe('a@x.com')
  })

  it('运行态读取抛错（未登录/未安装）→ cursor_unavailable 且携带截断原因', () => {
    const result = harness({
      runtime: { error: '未在 Cursor 配置文件中找到 access token。请先在 Cursor 客户端登录一次：/path/state.vscdb' },
      active: { token: jwtOf('auth0|user_a') }
    })
    expect(result.status).toBe('cursor_unavailable')
    expect(result.detail).toContain('未在 Cursor 配置文件中找到 access token')
    expect(result.detail!.length).toBeLessThanOrEqual(120)
  })

  it('运行态 token 非 JWT → cursor_unavailable（不给假绿灯）', () => {
    const result = harness({
      runtime: { token: 'garbage-not-a-jwt' },
      active: { token: jwtOf('auth0|user_a') }
    })
    expect(result.status).toBe('cursor_unavailable')
  })

  it('vault 无活跃账号 → vault_empty（本核对不适用）', () => {
    const result = harness({ active: undefined })
    expect(result.status).toBe('vault_empty')
  })

  it('vault 活跃 token 非 JWT（导入脏数据）→ 保守 mismatch（不给假绿灯）', () => {
    const result = harness({ active: { token: 'not-a-jwt', label: '脏数据账号' } })
    expect(result.status).toBe('mismatch')
  })
})

describe('cursorRuntimeMatchMessage', () => {
  it('各状态产出可读文案（弹窗/状态行/自动化失败消息共用）', () => {
    expect(cursorRuntimeMatchMessage({ status: 'matched', cursorLabel: 'a@x.com', activeLabel: 'a@x.com' }))
      .toContain('一致')
    expect(cursorRuntimeMatchMessage({ status: 'mismatch', cursorLabel: 'b@x.com', activeLabel: 'a@x.com' }))
      .toContain('不一致')
    expect(cursorRuntimeMatchMessage({ status: 'cursor_unavailable', detail: '未登录' }))
      .toContain('未登录')
    expect(cursorRuntimeMatchMessage({ status: 'vault_empty' }))
      .toContain('尚未选择活跃账号')
  })
})
