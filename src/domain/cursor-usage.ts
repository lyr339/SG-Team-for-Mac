/**
 * Cursor 会话 token 用量与费用估算（逆向实证 2026-08-30，Cursor 3.6.31）。
 *
 * 数据源：bundle 补丁（scripts/patch-cursor-usage-hook.ts）在渲染进程
 * AgentResponseAdapter/CloudAgentRepository 的 turnEnded 分支注入
 * __sgTeamUsage binding 调用——每次回合结束推送该回合真实计费 token：
 * inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens。
 * （渲染进程原生只把值写入内存态 turnTokenUsage，不落盘 state.vscdb。）
 *
 * 费用估算：按公开 API 牌价（USD / 百万 token）折算，与 Cursor 实际
 * 计费口径（请求计费/混合额度）不同——是「等价 API 成本」参考值。
 */

/** 单回合 usage 事件（binding payload {c,i,o,r,w,t} 解析后的形态）。 */
export interface CursorUsageEvent {
  composerId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 事件发生时间（epoch ms，页面内 Date.now()）。 */
  occurredAt: number
}

/** 当前 TeamRun 内的会话级累积用量（按 composerId 本地持久化）。 */
export interface CursorSessionUsage {
  composerId: string
  /** 已完成的回合数。 */
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 估算等价 API 成本（USD）。 */
  estimatedCostUsd: number
  /** 估算时使用的模型（命中价格表的展示名）。 */
  pricedModel: string
  lastTurnAt: number
}

/** composerId → 累积用量。 */
export type CursorUsageSnapshot = Record<string, CursorSessionUsage>

/** 百万 token 单价（USD）。cacheWrite 缺省按 input 的 1.25 倍（Anthropic 口径）。 */
export interface ModelTokenPrice {
  label: string
  inputPerM: number
  outputPerM: number
  cacheReadPerM: number
  cacheWritePerM: number
}

/**
 * 常用模型牌价表（USD / 1M tokens，公开 API 价，2026 快照）。
 * 匹配规则：modelId 小写子串首个命中；未命中走 DEFAULT（sonnet 档）。
 */
const MODEL_PRICES: Array<{ match: string; price: ModelTokenPrice }> = [
  { match: 'opus', price: { label: 'Claude Opus', inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 } },
  { match: 'haiku', price: { label: 'Claude Haiku', inputPerM: 0.8, outputPerM: 4, cacheReadPerM: 0.08, cacheWritePerM: 1 } },
  { match: 'sonnet', price: { label: 'Claude Sonnet', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 } },
  { match: 'claude', price: { label: 'Claude', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 } },
  { match: 'gpt-5', price: { label: 'GPT-5', inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125, cacheWritePerM: 1.25 } },
  { match: 'gpt-4.1', price: { label: 'GPT-4.1', inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5, cacheWritePerM: 2 } },
  { match: 'gpt-4o-mini', price: { label: 'GPT-4o mini', inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075, cacheWritePerM: 0.15 } },
  { match: 'gpt-4o', price: { label: 'GPT-4o', inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25, cacheWritePerM: 2.5 } },
  { match: 'gpt', price: { label: 'GPT', inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125, cacheWritePerM: 1.25 } },
  { match: 'gemini-3', price: { label: 'Gemini 3', inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.5, cacheWritePerM: 2 } },
  { match: 'gemini', price: { label: 'Gemini', inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.31, cacheWritePerM: 1.25 } }
]

const DEFAULT_PRICE: ModelTokenPrice = { label: '默认（Sonnet 档）', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 }

/**
 * 按模型 id 解析单价表（子串匹配）。
 * 未命中（'auto'、新模型名、Cursor 内部代号）按 Sonnet 档估算，但标签如实
 * 显示真实模型名——用户看到的应是「哪个模型在什么口径下估算」，而不是一个
 * 凭空出现的「默认档」。标签含 'sonnet' 子串，跨回合重解析仍命中同档价格。
 */
export function priceForModel(modelId: string | undefined): ModelTokenPrice {
  const id = (modelId ?? '').toLowerCase()
  if (!id) return DEFAULT_PRICE
  const matched = MODEL_PRICES.find((entry) => id.includes(entry.match))?.price
  if (matched) return matched
  const trimmed = (modelId ?? '').trim().slice(0, 60)
  return trimmed
    ? { ...DEFAULT_PRICE, label: `${trimmed} · Sonnet 档估算` }
    : DEFAULT_PRICE
}

/** 单回合费用估算（USD）。 */
export function estimateTurnCostUsd(event: Omit<CursorUsageEvent, 'composerId'>, price: ModelTokenPrice): number {
  return (
    event.inputTokens / 1e6 * price.inputPerM
    + event.outputTokens / 1e6 * price.outputPerM
    + event.cacheReadTokens / 1e6 * price.cacheReadPerM
    + event.cacheWriteTokens / 1e6 * price.cacheWritePerM
  )
}

/** 累加一回合到会话用量（纯函数，返回新对象）。 */
export function accumulateUsage(
  current: CursorSessionUsage | undefined,
  event: CursorUsageEvent,
  pricedModel: string
): CursorSessionUsage {
  const base = current ?? {
    composerId: event.composerId,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
    pricedModel,
    lastTurnAt: 0
  }
  const price = priceForModel(pricedModel)
  const accumulatedModel = base.turns > 0 && base.pricedModel !== price.label
    ? 'Mixed models'
    : price.label
  return {
    composerId: event.composerId,
    turns: base.turns + 1,
    inputTokens: base.inputTokens + event.inputTokens,
    outputTokens: base.outputTokens + event.outputTokens,
    cacheReadTokens: base.cacheReadTokens + event.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + event.cacheWriteTokens,
    estimatedCostUsd: base.estimatedCostUsd + estimateTurnCostUsd(event, price),
    pricedModel: accumulatedModel,
    lastTurnAt: Math.max(base.lastTurnAt, event.occurredAt)
  }
}

/** 总计费 token：输入 + 输出 + 缓存读 + 缓存写。 */
export function totalUsageTokens(usage: Pick<CursorSessionUsage,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/**
 * CDP 轮询快照（turnTokenUsage）的回合覆盖合并：同源值的「当前回合累计」
 * 语义——快照值 ≥ 已记值时覆盖当前回合（生成中单调增长，回合结束定格）；
 * 快照回落到更小值 = 新回合开始，前回合封存、新回合从快照值起算。
 * 与事件通道（turnEnded 累加）互补：轮询提供实时性，事件提供权威封存。
 */
export function applyTurnUsage(
  current: CursorSessionUsage | undefined,
  snapshot: CursorUsageEvent,
  pricedModel: string
): CursorSessionUsage {
  const base = current ?? {
    composerId: snapshot.composerId,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
    pricedModel,
    lastTurnAt: 0
  }
  const price = priceForModel(pricedModel)
  const snapshotCost = estimateTurnCostUsd(snapshot, price)
  const snapshotTokens = snapshot.inputTokens + snapshot.outputTokens
    + snapshot.cacheReadTokens + snapshot.cacheWriteTokens
  const currentTurnTokens = base.inputTokens + base.outputTokens
    + base.cacheReadTokens + base.cacheWriteTokens
  // 回合内单调覆盖：不增回合数，直接以快照为准（费用按快照重估，口径一致）。
  if (snapshotTokens >= currentTurnTokens) {
    return {
      composerId: base.composerId,
      turns: Math.max(base.turns, 1),
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      cacheReadTokens: snapshot.cacheReadTokens,
      cacheWriteTokens: snapshot.cacheWriteTokens,
      estimatedCostUsd: snapshotCost,
      pricedModel: base.turns > 0 && base.pricedModel !== price.label ? 'Mixed models' : price.label,
      lastTurnAt: Math.max(base.lastTurnAt, snapshot.occurredAt)
    }
  }
  // 快照回落（新回合尚小）：封存旧回合、以快照起算新回合。
  return {
    composerId: base.composerId,
    turns: base.turns + 1,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    cacheReadTokens: snapshot.cacheReadTokens,
    cacheWriteTokens: snapshot.cacheWriteTokens,
    estimatedCostUsd: base.estimatedCostUsd + snapshotCost,
    pricedModel: 'Mixed models',
    lastTurnAt: Math.max(base.lastTurnAt, snapshot.occurredAt)
  }
}

/** 展示用：token 数缩写（12.2K / 1.3M / 2.1B）。 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1e9) {
    const b = tokens / 1e9
    return `${b >= 10 ? Math.round(b) : Number(b.toFixed(1))}B`
  }
  if (tokens >= 1e6) {
    const m = tokens / 1e6
    return `${m >= 10 ? Math.round(m) : Number(m.toFixed(1))}M`
  }
  if (tokens >= 1e3) {
    const k = tokens / 1e3
    return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}K`
  }
  return String(tokens)
}

/** 展示用：小额不吞精度，正常金额保持易读。 */
export function formatCostUsd(costUsd: number): string {
  if (costUsd <= 0) return '$0.00'
  if (costUsd < 0.01) return `$${costUsd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  if (costUsd < 1) return `$${costUsd.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`
  return `$${costUsd.toFixed(2)}`
}

export function cursorUsageDetail(usage: CursorSessionUsage): string {
  return `本轮 TeamRun 的 Cursor 会话真实计费 token（${usage.pricedModel}，${usage.turns} 回合）：输入 ${usage.inputTokens.toLocaleString()} · 输出 ${usage.outputTokens.toLocaleString()} · 缓存读 ${usage.cacheReadTokens.toLocaleString()} · 缓存写 ${usage.cacheWriteTokens.toLocaleString()}；等价 API 成本估算 ${formatCostUsd(usage.estimatedCostUsd)}；团队结束后冻结，下轮启动时清零`
}
