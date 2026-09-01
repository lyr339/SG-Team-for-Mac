import { describe, expect, it } from 'vitest'
import {
  accumulateUsage,
  estimateTurnCostUsd,
  formatCostUsd,
  formatTokenCount,
  priceForModel,
  type CursorUsageEvent
} from '../src/domain/cursor-usage'

function event(overrides: Partial<CursorUsageEvent> = {}): CursorUsageEvent {
  return {
    composerId: 'composer-1',
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    occurredAt: 1_000,
    ...overrides
  }
}

describe('priceForModel', () => {
  it('未命中价格表时如实显示真实模型名 + 估算档位（跨回合重解析费率一致）', () => {
    const auto = priceForModel('auto')
    expect(auto.label).toBe('auto · Sonnet 档估算')
    expect(auto.inputPerM).toBe(3)
    expect(priceForModel(auto.label).inputPerM).toBe(auto.inputPerM)
    expect(priceForModel('composer-2.5').label).toBe('composer-2.5 · Sonnet 档估算')
  })

  it('按子串匹配常用模型并落到默认档', () => {
    expect(priceForModel('claude-sonnet-4-5').label).toBe('Claude Sonnet')
    expect(priceForModel('CLAUDE-OPUS-4-1').label).toBe('Claude Opus')
    expect(priceForModel('gpt-5.1').label).toBe('GPT-5')
    expect(priceForModel('gemini-2.5-pro').label).toBe('Gemini')
    expect(priceForModel(undefined).label).toBe('默认（Sonnet 档）')
    expect(priceForModel(undefined).label).toContain('默认')
  })

  it('gpt-4o-mini 先于 gpt-4o 命中（顺序敏感）', () => {
    expect(priceForModel('gpt-4o-mini-2024').inputPerM).toBe(0.15)
    expect(priceForModel('gpt-4o-2024').inputPerM).toBe(2.5)
  })
})

describe('estimateTurnCostUsd', () => {
  it('sonnet 档：1M 输入 = $3；缓存读 1/10 价', () => {
    const price = priceForModel('claude-sonnet-4-5')
    expect(estimateTurnCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, occurredAt: 0 }, price)).toBeCloseTo(3, 6)
    expect(estimateTurnCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, occurredAt: 0 }, price)).toBeCloseTo(0.3, 6)
    expect(estimateTurnCostUsd({ inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, occurredAt: 0 }, price)).toBeCloseTo(1.5, 6)
  })
})

describe('accumulateUsage', () => {
  it('跨回合累加并在模型变化时明确标记混合计价', () => {
    let usage = accumulateUsage(undefined, event({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 }), 'claude-sonnet-4-5')
    usage = accumulateUsage(usage, event({ inputTokens: 200, outputTokens: 150, cacheWriteTokens: 5, occurredAt: 2_000 }), 'gpt-5')
    expect(usage.turns).toBe(2)
    expect(usage.inputTokens).toBe(300)
    expect(usage.outputTokens).toBe(200)
    expect(usage.cacheReadTokens).toBe(10)
    expect(usage.cacheWriteTokens).toBe(5)
    expect(usage.lastTurnAt).toBe(2_000)
    expect(usage.pricedModel).toBe('Mixed models')
    // 100 in + 50 out @ sonnet ≈ $0.00105；200 in + 150 out + 5 cw @ gpt-5 ≈ $0.00176
    expect(usage.estimatedCostUsd).toBeGreaterThan(0.0027)
    expect(usage.estimatedCostUsd).toBeLessThan(0.0029)
  })
})

describe('展示格式化', () => {
  it('token 缩写与费用缩写', () => {
    expect(formatTokenCount(950)).toBe('950')
    expect(formatTokenCount(12_168)).toBe('12.2K')
    expect(formatTokenCount(95_000)).toBe('95K')
    expect(formatTokenCount(150_000)).toBe('150K')
    expect(formatTokenCount(1_250_000)).toBe('1.3M')
    expect(formatTokenCount(12_000_000)).toBe('12M')
    expect(formatTokenCount(2_100_000_000)).toBe('2.1B')
    expect(formatCostUsd(0)).toBe('$0.00')
    expect(formatCostUsd(0.004)).toBe('$0.004')
    expect(formatCostUsd(0.0421)).toBe('$0.042')
    expect(formatCostUsd(1.5)).toBe('$1.50')
  })
})
