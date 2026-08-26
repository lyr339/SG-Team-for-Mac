import { describe, expect, it } from 'vitest'
import { formatAgentSessionDuration, formatContextUsage, formatSessionDuration, formatTokenCount } from '../src/renderer/src/format'

describe('session duration formatting', () => {
  it('keeps live sessions advancing against the supplied current time', () => {
    expect(formatAgentSessionDuration({
      startedAt: 1_000_000,
      online: true
    }, 1_000_000 + 28 * 60_000)).toBe('运行 28 分钟')
  })

  it('freezes an offline session at its first disconnect time', () => {
    const session = {
      startedAt: 1_000_000,
      disconnectedAt: 1_000_000 + 8 * 60_000,
      online: false
    }
    expect(formatAgentSessionDuration(session, 1_000_000 + 28 * 60_000))
      .toBe('运行 8 分钟 · 已截止')
    expect(formatAgentSessionDuration(session, 1_000_000 + 88 * 60_000))
      .toBe('运行 8 分钟 · 已截止')
  })

  it('does not fabricate an elapsed duration when disconnect evidence is missing', () => {
    expect(formatAgentSessionDuration({ startedAt: 1_000_000, online: false }, 9_000_000))
      .toBe('已离线')
    expect(formatSessionDuration(undefined, 9_000_000)).toBe('时长待绑定')
  })

  it('formats compact count totals', () => {
    expect(formatTokenCount(135_200)).toBe('135K')
    expect(formatTokenCount(2_148)).toBe('2.15K')
    expect(formatTokenCount(2_400_000)).toBe('2.4M')
  })

  it('formats context usage with compact K/M/B units instead of 万', () => {
    expect(formatContextUsage({ used: 125_000, limit: 1_000_000, ratio: 0.125 })).toBe('125K / 1M · 12.5%')
    expect(formatContextUsage({ used: 9_800, limit: 200_000, ratio: 0.049 })).toBe('9.8K / 200K · 4.9%')
  })
})
