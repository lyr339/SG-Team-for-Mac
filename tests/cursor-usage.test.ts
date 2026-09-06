import { describe, expect, it } from 'vitest'
import {
  reduceUsage,
  estimateTurnCostUsd,
  formatCostUsd,
  formatTokenCount,
  priceForModel,
  totalUsageTokens,
  type CursorSessionUsage,
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
    expect(priceForModel('starlight-9').label).toBe('starlight-9 · Sonnet 档估算')
  })

  it('归一化后按词边界匹配并区分版本（表内顺序即优先级，更具体的在前）', () => {
    expect(priceForModel('claude-sonnet-4-5').label).toBe('Claude Sonnet')
    expect(priceForModel('CLAUDE-OPUS-4-1').label).toBe('Claude Opus 4.1')
    expect(priceForModel('gpt-5.1').label).toBe('GPT-5.1')
    expect(priceForModel('gpt-5.1-codex-mini').label).toBe('GPT-5.1 Codex Mini')
    expect(priceForModel('gemini-2.5-pro').label).toBe('Gemini 2.5 Pro')
    expect(priceForModel('composer-2.5').label).toBe('Composer')
    expect(priceForModel(undefined).label).toBe('默认（Sonnet 档）')
  })

  it('gpt-4o-mini 先于 gpt-4o 命中（顺序敏感）', () => {
    expect(priceForModel('gpt-4o-mini-2024').inputPerM).toBe(0.15)
    expect(priceForModel('gpt-4o-2024').inputPerM).toBe(2.5)
  })

  it('键与版本数字紧邻仍从词首命中（qwen3-max），跨系列不误伤（o3 ≠ gpt-5.3-codex）', () => {
    expect(priceForModel('qwen3-max').label).toBe('Qwen3 Max')
    expect(priceForModel('Qwen3 Max').label).toBe('Qwen3 Max')
    expect(priceForModel('gpt-5.3-codex').label).toBe('GPT-5.3 Codex')
    expect(priceForModel('o3-2025-04-16').label).toBe('OpenAI o3')
    expect(priceForModel('claude-fable-5-1-20260815').label).toBe('Claude Fable 5.1')
    expect(priceForModel('fable-5').label).toBe('Claude Fable 5')
    expect(priceForModel('grok-4.6-fast').label).toBe('Grok 4.6 Fast')
    // 无 fast 后缀的 grok 落泛化条目，而不是错拼进带版本的 fast 变体
    expect(priceForModel('grok-4.6').label).toBe('Grok')
    expect(priceForModel('kimi-k3').label).toBe('Kimi K3')
    expect(priceForModel('deepseek-v4-flash').label).toBe('DeepSeek V4 Flash')
  })

  it('缓存写价按 provider 口径：Anthropic 与 GPT-5.6 系写 1.25×，其余写价 = 输入价（非 0）', () => {
    const opus = priceForModel('claude-opus-4-1')
    expect(opus.cacheWritePerM).toBeCloseTo(opus.inputPerM * 1.25, 6)
    const sol = priceForModel('gpt-5.6-sol')
    expect(sol.cacheWritePerM).toBeCloseTo(sol.inputPerM * 1.25, 6)
    // OpenAI 5.5 及更早不收写入溢价：新进上下文按普通输入价计，写价为 0 会把新进 token 算成免费
    const legacy = priceForModel('gpt-5.5')
    expect(legacy.cacheWritePerM).toBe(legacy.inputPerM)
    expect(legacy.cacheWritePerM).toBeGreaterThan(0)
    const gemini = priceForModel('gemini-3-pro')
    expect(gemini.cacheWritePerM).toBe(gemini.inputPerM)
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

describe('token 口径（缓存读/写 ⊂ 输入，2026-09-01 实证定稿）', () => {
  it('总 token = 输入 + 输出，缓存子集不重复计入', () => {
    // 事故会话形态：input 6.2M 中 5.82M 命中缓存读——旧口径曾报 12.06M（虚高一倍）。
    expect(totalUsageTokens({ inputTokens: 6_199_999, outputTokens: 44_859, cacheReadTokens: 5_819_074, cacheWriteTokens: 0 }))
      .toBe(6_244_858)
    expect(totalUsageTokens({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 5 })).toBe(110)
  })

  it('费用只对未缓存输入收全价：缓存读 1/10、缓存写 1.25×（旧口径虚报 6 倍）', () => {
    const price = priceForModel('claude-sonnet-4-5')
    // 1M 输入中 900K 命中缓存读：100K×$3 + 900K×$0.3 = $0.57（旧并列口径错算 $3.27）。
    expect(estimateTurnCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 900_000, cacheWriteTokens: 0, occurredAt: 0 }, price))
      .toBeCloseTo(0.57, 6)
    // 事故会话整笔复核：$3.56 而非 $21.02。
    expect(estimateTurnCostUsd({ inputTokens: 6_199_999, outputTokens: 44_859, cacheReadTokens: 5_819_074, cacheWriteTokens: 0, occurredAt: 0 }, price))
      .toBeCloseTo(3.56, 2)
    // 上游口径异常（缓存 > 输入）时 clamp 到 0，不产生负费。
    expect(estimateTurnCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, occurredAt: 0 }, price))
      .toBeCloseTo(0.3, 6)
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
