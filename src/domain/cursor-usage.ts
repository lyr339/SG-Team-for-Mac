/**
 * Cursor 会话 token 用量与费用估算（逆向实证 2026-08-30，Cursor 3.6.31）。
 *
 * 数据源：bundle 补丁（scripts/patch-cursor-usage-hook.ts）在渲染进程
 * AgentResponseAdapter/CloudAgentRepository 的 turnEnded 分支注入
 * __sgTeamUsage binding 调用——每次回合结束推送该回合真实计费 token：
 * inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens。
 * （渲染进程原生只把值写入内存态 turnTokenUsage，不落盘 state.vscdb。）
 *
 * 口径（2026-09-01 三重证据定稿）：cacheReadTokens / cacheWriteTokens 是
 * inputTokens 的【子集】，不是并列桶——
 * ① Cursor 遥测 gen_ai.usage.total_tokens = inputTokens + outputTokens，不含缓存字段；
 * ② 事故会话实测（input 6.2M / cacheRead 5.82M）：子集解读缓存命中率 93.9%
 *   （agentic 长会话典型曲线）；并列解读 48.4%，与对话每 2~3 秒仅增长数百
 *   token、缓存 TTL 5 分钟的物理规律矛盾；
 * ③ OpenAI 归一口径（cached_tokens ⊂ prompt_tokens）正是 Cursor 的统一形态。
 * 因此：总 token = 输入 + 输出；费用 = 未缓存输入全价 + 缓存读 1/10 价
 * + 缓存写 1.25× 价 + 输出价。
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
  /** 已完成的计费请求次数（请求级采样按请求计数；事件通道按回合计数——单通道独占，不混计）。 */
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
  /**
   * 请求级采样基线：上次观测到的 contextTokensUsed。持久化于快照——跨进程重启
   * 基线延续，重启后首样本不会把存量上下文误记一次。undefined = 尚未建立基线。
   */
  contextLastUsed?: number
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

/**
 * 单回合费用估算（USD）。缓存读/写是输入的子集：只有未命中缓存的部分按
 * 输入全价，缓存读/写按各自折扣价——把四桶直接相加会重复计费（旧口径曾把
 * 事故会话成本虚报 6 倍）。clamp 防御上游口径异常（缓存 > 输入）。
 */
export function estimateTurnCostUsd(event: Omit<CursorUsageEvent, 'composerId'>, price: ModelTokenPrice): number {
  const uncachedInput = Math.max(0, event.inputTokens - event.cacheReadTokens - event.cacheWriteTokens)
  return (
    uncachedInput / 1e6 * price.inputPerM
    + event.cacheReadTokens / 1e6 * price.cacheReadPerM
    + event.cacheWriteTokens / 1e6 * price.cacheWritePerM
    + event.outputTokens / 1e6 * price.outputPerM
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

/** 总计费 token：输入 + 输出（缓存读/写是输入的子集，不重复计入）。 */
export function totalUsageTokens(usage: Pick<CursorSessionUsage,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return usage.inputTokens + usage.outputTokens
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
  // 回合边界判定同样用「输入+输出」口径（缓存是子集，不参与单调性比较的语义）。
  const snapshotTokens = snapshot.inputTokens + snapshot.outputTokens
  const currentTurnTokens = base.inputTokens + base.outputTokens
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

/**
 * 请求级上下文采样（长会话实时通道，算法经织梦 Cursor 生产验证）。
 *
 * 背景：持续对话模式下回合永不结束（agent 循环 check_messages），turnEnded 及其
 * turnTokenUsage 永不产生——事件/快照两条通道在长会话里恒为零。而 composerData.
 * contextTokensUsed 随每次模型请求实时刷新，是唯一可用的请求级活水源。
 *
 * 计账语义（Cursor 按请求对完整上下文计费）：
 * - 首样本：只建立基线，零累计（监控开始前的存量上下文不属于本 run 的账）；
 * - used 不变：同一请求内的重复采样，零累计；
 * - used 变化（无论方向，含上下文压缩回落）：新请求发生，按当时完整上下文
 *   全额累计 input 与成本（无 cache 拆分，全价是上界估算——如实呈现）。
 * 口径与事件通道一致：turnEnded 的 inputTokens 本就是回合内全部请求的累计
 * （2026-09-01 事故实测：单回合 input 6.2M，远超 1M 上下文上限，实证口径）。
 */
export function applyRequestSample(
  current: CursorSessionUsage | undefined,
  sample: { composerId: string; used: number; occurredAt: number },
  pricedModel: string
): CursorSessionUsage {
  const base = current ?? {
    composerId: sample.composerId,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
    pricedModel,
    lastTurnAt: 0
  }
  if (!Number.isFinite(sample.used) || sample.used < 0) return base
  const touched = {
    ...base,
    contextLastUsed: sample.used,
    lastTurnAt: Math.max(base.lastTurnAt, sample.occurredAt)
  }
  // 首样本建基线 / 同值去重：零累计
  if (base.contextLastUsed === undefined || sample.used === base.contextLastUsed) return touched
  const price = priceForModel(pricedModel)
  return {
    ...touched,
    turns: base.turns + 1,
    inputTokens: base.inputTokens + sample.used,
    estimatedCostUsd: base.estimatedCostUsd + sample.used / 1e6 * price.inputPerM,
    pricedModel: base.turns > 0 && base.pricedModel !== price.label ? 'Mixed models' : price.label
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
  const sampleBased = usage.contextLastUsed !== undefined
  const breakdown = sampleBased
    ? `输入 ${usage.inputTokens.toLocaleString()}（按请求全额累计）`
    : `输入 ${usage.inputTokens.toLocaleString()}（含缓存读 ${usage.cacheReadTokens.toLocaleString()}、缓存写 ${usage.cacheWriteTokens.toLocaleString()}）· 输出 ${usage.outputTokens.toLocaleString()}`
  return `本轮 TeamRun 计费 token（${usage.pricedModel}，${usage.turns} 次请求）：${breakdown}；总计 ${totalUsageTokens(usage).toLocaleString()}；等价 API 成本估算 ${formatCostUsd(usage.estimatedCostUsd)}（基于当前 API 定价实时估算）；团队结束后冻结，下轮启动时清零`
}
