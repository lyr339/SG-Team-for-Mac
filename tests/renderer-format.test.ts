import { describe, expect, it } from 'vitest'
import {
  badgeTone,
  executionBadges,
  formatAgentSessionDuration,
  formatContextUsage,
  formatExecutionProfile,
  formatSessionDuration,
  formatTokenCount
} from '../src/renderer/src/format'

describe('session duration formatting', () => {
  it('keeps live sessions advancing against the supplied current time', () => {
    expect(formatAgentSessionDuration({
      startedAt: 1_000_000,
      online: true
    }, 1_000_000 + 28 * 60_000)).toBe('28 分钟')
  })

  it('freezes an offline session at its first disconnect time', () => {
    const session = {
      startedAt: 1_000_000,
      disconnectedAt: 1_000_000 + 8 * 60_000,
      online: false
    }
    expect(formatAgentSessionDuration(session, 1_000_000 + 28 * 60_000))
      .toBe('8 分钟 · 截止')
    expect(formatAgentSessionDuration(session, 1_000_000 + 88 * 60_000))
      .toBe('8 分钟 · 截止')
  })

  it('does not fabricate an elapsed duration when disconnect evidence is missing', () => {
    expect(formatAgentSessionDuration({ startedAt: 1_000_000, online: false }, 9_000_000))
      .toBe('离线')
    expect(formatSessionDuration(undefined, 9_000_000)).toBe('时长待绑定')
  })

  it('uses the persisted active duration as the concise frozen label', () => {
    expect(formatAgentSessionDuration({
      activeDurationMs: 90 * 60_000,
      online: false
    })).toBe('1 小时 30 分 · 截止')
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

describe('execution profile badges', () => {
  const profile = {
    scope: 'cursor-composer-current' as const,
    modelId: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    options: ['Fast', '1M', 'Think'],
    maxMode: true
  }

  it('omits MAX Mode from conversation badges', () => {
    expect(executionBadges(profile)).toEqual(['Think', '1M', 'Fast'])
    expect(executionBadges({ ...profile, options: ['Max', '1M', 'Think'] }))
      .toEqual(['Think', '1M', 'Max'])
  })

  it('assigns unrelated parameter families to distinct visual tones', () => {
    expect(badgeTone('Think')).toBe('think')
    expect(badgeTone('1M')).toBe('context')
    expect(badgeTone('Max')).toBe('effort')
    expect(badgeTone('Extra High')).toBe('effort')
    expect(badgeTone('Fast')).toBe('fast')
  })

  it('keeps badges visible next to a reported session model name', () => {
    expect(formatExecutionProfile(profile, 'GPT-5.6 Sol'))
      .toBe('GPT-5.6 Sol · Think · 1M · Fast')
  })

  it('falls back to the reported name when no profile is readable', () => {
    expect(executionBadges(undefined)).toEqual([])
    expect(formatExecutionProfile(undefined, 'Kimi K3')).toBe('Kimi K3')
    expect(formatExecutionProfile(undefined)).toBe('运行配置待读取')
  })
})
