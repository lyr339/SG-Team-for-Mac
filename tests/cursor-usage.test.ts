import { describe, expect, it } from 'vitest'
import {
  accumulateUsage,
  applyRequestSample,
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

describe('applyRequestSample（请求级采样，织梦算法）', () => {
  const sample = (used: number, occurredAt = 1_000) => ({ composerId: 'comp-1', used, occurredAt })

  it('首样本只建立基线：零累计（监控前的存量上下文不计入本 run）', () => {
    const usage = applyRequestSample(undefined, sample(25_750), 'kimi-k3')
    expect(usage.turns).toBe(0)
    expect(usage.inputTokens).toBe(0)
    expect(usage.estimatedCostUsd).toBe(0)
    expect(usage.contextLastUsed).toBe(25_750)
  })

  it('同值样本零累计（同一请求内的重复采样去重），时间戳仍推进', () => {
    let usage = applyRequestSample(undefined, sample(25_750, 1_000), 'kimi-k3')
    usage = applyRequestSample(usage, sample(25_750, 2_000), 'kimi-k3')
    expect(usage.turns).toBe(0)
    expect(usage.inputTokens).toBe(0)
    expect(usage.lastTurnAt).toBe(2_000)
  })

  it('used 增长 = 新请求：token 按当时完整上下文累计（25.75K → 30K 记 30K，非增量 4.25K）', () => {
    let usage = applyRequestSample(undefined, sample(25_750), 'kimi-k3')
    usage = applyRequestSample(usage, sample(30_000, 2_000), 'kimi-k3')
    expect(usage.turns).toBe(1)
    expect(usage.inputTokens).toBe(30_000)
    expect(usage.contextLastUsed).toBe(30_000)
    // 成本缓存拆分（Kimi K3：读 $0.3/M、写 = 输入价 $3/M）：存量前缀 25 750 按读价
    // + 新增 4 250 按写价 = $0.0077 + $0.0128 ≈ $0.0205（旧全价口径为 30K×$3/M = $0.09）
    expect(usage.cacheReadTokens).toBe(25_750)
    expect(usage.cacheWriteTokens).toBe(4_250)
    expect(usage.estimatedCostUsd).toBeCloseTo(0.020475, 6)
  })

  it('缓存拆分口径：1M 基线 + 50K 增量 = 1M×缓存读价 + 50K×缓存写价（97% 命中率下旧全价口径高估 6 倍）', () => {
    let usage = applyRequestSample(undefined, sample(1_000_000), 'claude-sonnet-4-5')
    usage = applyRequestSample(usage, sample(1_050_000, 2_000), 'claude-sonnet-4-5')
    // Sonnet：1M×$0.3/M + 50K×$3.75/M = $0.3 + $0.1875（旧口径 1.05M×$3/M = $3.15）
    expect(usage.estimatedCostUsd).toBeCloseTo(0.4875, 6)
    expect(usage.inputTokens).toBe(1_050_000)
    expect(usage.cacheReadTokens).toBe(1_000_000)
    expect(usage.cacheWriteTokens).toBe(50_000)
  })

  it('回落（上下文压缩）同样是新请求：压缩后全量按缓存写价重建前缀，基线重建', () => {
    let usage = applyRequestSample(undefined, sample(30_000), 'kimi-k3')
    usage = applyRequestSample(usage, sample(30_000, 2_000), 'kimi-k3')
    usage = applyRequestSample(usage, sample(18_000, 3_000), 'kimi-k3')
    usage = applyRequestSample(usage, sample(21_000, 4_000), 'kimi-k3')
    expect(usage.turns).toBe(2)
    expect(usage.inputTokens).toBe(18_000 + 21_000)
    // 回落帧 18K 全量按写价重建；随后 21K = 存量 18K 读 + 增量 3K 写。
    // 缓存两桶增量之和始终等于该次 used——桶仍是输入的子集，UI 分段条不越界。
    expect(usage.cacheWriteTokens).toBe(18_000 + 3_000)
    expect(usage.cacheReadTokens).toBe(18_000)
    expect(usage.cacheReadTokens + usage.cacheWriteTokens).toBe(usage.inputTokens)
    expect(usage.contextLastUsed).toBe(21_000)
  })

  it('连续请求累计 + 模型变化标记混合计价', () => {
    let usage = applyRequestSample(undefined, sample(25_000), 'claude-sonnet-4-5')
    usage = applyRequestSample(usage, sample(30_000, 2_000), 'claude-sonnet-4-5')
    usage = applyRequestSample(usage, sample(35_000, 3_000), 'gpt-5')
    expect(usage.turns).toBe(2)
    expect(usage.inputTokens).toBe(65_000)
    expect(usage.pricedModel).toBe('Mixed models')
  })

  it('非法样本（负值/NaN）原样返回不记账', () => {
    let usage = applyRequestSample(undefined, sample(25_000), 'kimi-k3')
    usage = applyRequestSample(usage, sample(-1, 2_000), 'kimi-k3')
    usage = applyRequestSample(usage, sample(Number.NaN, 3_000), 'kimi-k3')
    expect(usage.turns).toBe(0)
    expect(usage.inputTokens).toBe(0)
    expect(usage.contextLastUsed).toBe(25_000)
  })

  it('跨重启基线延续：恢复的 contextLastUsed 使首样本不重复记账', () => {
    // run 中途进程重启，快照恢复（contextLastUsed=30K 已持久化）；重启后首样本
    // 与基线同值 → 零累计；后续增长正常记账
    const restored: CursorSessionUsage = {
      composerId: 'comp-1', turns: 1, inputTokens: 30_000, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.09,
      pricedModel: 'Claude Sonnet', lastTurnAt: 1_000, contextLastUsed: 30_000
    }
    let usage = applyRequestSample(restored, sample(30_000, 5_000), 'claude-sonnet-4-5')
    expect(usage.inputTokens).toBe(30_000)
    usage = applyRequestSample(usage, sample(36_000, 6_000), 'claude-sonnet-4-5')
    expect(usage.turns).toBe(2)
    expect(usage.inputTokens).toBe(66_000)
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
