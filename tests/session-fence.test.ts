import { describe, expect, it } from 'vitest'
import {
  buildSessionRetiredText,
  evaluateSessionFence,
  isValidSessionToken,
  type ChannelSessionOwnership
} from '../src/domain/session-fence'

const TOKEN = '4c71ab69-2a83-4bfe-9ebf-3d953c2d0d1d'

function ownership(overrides: Partial<ChannelSessionOwnership> = {}): ChannelSessionOwnership {
  return { runId: 'session-run:alpha:run-1', runStatus: 'running', bound: true, sessionToken: TOKEN, solo: true, ...overrides }
}

describe('session fence（会话围栏领域规则）', () => {
  it('accepts url-safe tokens between 8 and 128 chars and rejects everything else', () => {
    expect(isValidSessionToken(TOKEN)).toBe(true)
    expect(isValidSessionToken('abcd_EFG-1')).toBe(true)
    expect(isValidSessionToken('  abcdefgh  ')).toBe(true)
    expect(isValidSessionToken('short')).toBe(false)
    expect(isValidSessionToken('has space in it')).toBe(false)
    expect(isValidSessionToken('a'.repeat(129))).toBe(false)
    expect(isValidSessionToken(42)).toBe(false)
    expect(isValidSessionToken(undefined)).toBe(false)
  })

  it('treats a missing or blank token as legacy regardless of ownership (fail-open for old sessions)', () => {
    expect(evaluateSessionFence(undefined, undefined)).toEqual({ status: 'legacy' })
    expect(evaluateSessionFence(undefined, '   ')).toEqual({ status: 'legacy' })
    expect(evaluateSessionFence(ownership({ runStatus: 'completed' }), '')).toEqual({ status: 'legacy' })
  })

  it('retires a token when there is no active run at all', () => {
    expect(evaluateSessionFence(undefined, TOKEN)).toEqual({ status: 'retired', reason: 'no_run' })
  })

  it('retires every token once the run is completed, even the currently issued one', () => {
    expect(evaluateSessionFence(ownership({ runStatus: 'completed' }), TOKEN))
      .toEqual({ status: 'retired', reason: 'run_completed' })
  })

  it('retires a token for a channel that no longer belongs to the active run', () => {
    expect(evaluateSessionFence(ownership({ bound: false, sessionToken: undefined }), TOKEN))
      .toEqual({ status: 'retired', reason: 'channel_unbound' })
  })

  it('retires a presented token when the seat has no issued token or a different one', () => {
    // 席位未签发令牌却有人出示令牌：只可能是被换掉的旧会话（备用接替后令牌清空）。
    expect(evaluateSessionFence(ownership({ sessionToken: undefined }), TOKEN))
      .toEqual({ status: 'retired', reason: 'token_mismatch' })
    expect(evaluateSessionFence(ownership(), 'another-token-value'))
      .toEqual({ status: 'retired', reason: 'token_mismatch' })
  })

  it('passes the current seat token (whitespace tolerant) across run statuses that still run', () => {
    expect(evaluateSessionFence(ownership(), TOKEN)).toEqual({ status: 'ok' })
    expect(evaluateSessionFence(ownership(), `  ${TOKEN}  `)).toEqual({ status: 'ok' })
    for (const runStatus of ['launching', 'attention', 'paused', 'ready', 'draft'] as const) {
      expect(evaluateSessionFence(ownership({ runStatus }), TOKEN)).toEqual({ status: 'ok' })
    }
  })

  it('renders the retired instruction as an explicit server-side stop with the concrete cause', () => {
    const completed = buildSessionRetiredText({ channelId: '3', reason: 'run_completed' })
    expect(completed).toContain('[system] 会话围栏')
    expect(completed).toContain('本轮运行已结束')
    expect(completed).toContain('不要再调用 check_messages / record_reply')
    expect(completed).toContain('不要重试')
    expect(completed).toContain('等同于用户要求停止')

    expect(buildSessionRetiredText({ channelId: '3', reason: 'no_run' })).toContain('当前没有活动运行')
    expect(buildSessionRetiredText({ channelId: '3', reason: 'channel_unbound' })).toContain('CH-3 不再属于当前运行')
    expect(buildSessionRetiredText({ channelId: '3', reason: 'token_mismatch' })).toContain('CH-3 已由新的会话接管')
  })
})
