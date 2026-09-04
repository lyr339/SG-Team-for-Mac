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

/**
 * 百万 token 单价（USD）。
 * cacheWritePerM 是「写入缓存那部分输入的单价」：Anthropic 与 GPT-5.6 系按输入 1.25×
 * 收写入溢价；其余厂商（OpenAI 5.5 及更早 / Gemini / Grok / Composer / Kimi / GLM）
 * 不收写入费——新进上下文按普通输入价计，因此 cacheWritePerM = inputPerM，而不是 0
 * （0 会把新进 token 算成免费）。
 */
export interface ModelTokenPrice {
  label: string
  inputPerM: number
  outputPerM: number
  cacheReadPerM: number
  cacheWritePerM: number
}

/** 快照日期：牌价随时间漂移，核对时以 cursor.com/docs/models-and-pricing 为准。 */
export const MODEL_PRICES_SNAPSHOT_DATE = '2026-09-04'

function price(label: string, inputPerM: number, outputPerM: number, cacheReadPerM: number, cacheWritePerM = inputPerM): ModelTokenPrice {
  return { label, inputPerM, outputPerM, cacheReadPerM, cacheWritePerM }
}

/**
 * 模型牌价表（USD / 1M tokens）。来源：Cursor「Models & Pricing」页（Cursor 按模型
 * API 价扣用量，与「等价 API 成本」口径一致）；Cursor 目录外的 DeepSeek / Qwen 取官方
 * API 标价（DeepSeek 为非高峰价）。长上下文（>200K）加价、Fast 未列变体、区域加价不建模。
 *
 * 匹配规则：modelId 与键都归一为小写、非字母数字折成 `-`，键必须从词首（^ 或 `-` 之后）
 * 开始、到词尾（`-`、结尾或紧随的版本数字）结束——`o3` 不会命中 `gpt-5-3-codex`，
 * `qwen` 仍能命中 `qwen3-max`。表内顺序即优先级（更具体的在前）。
 */
const MODEL_PRICES: Array<{ match: string; price: ModelTokenPrice }> = [
  // Anthropic（写 1.25×，读 0.1×；Fable 5.1 读 0.025×）
  { match: 'fable-5-1', price: price('Claude Fable 5.1', 10, 50, 0.25, 12.5) },
  { match: 'fable', price: price('Claude Fable 5', 10, 50, 1, 12.5) },
  { match: 'opus-4-7-fast', price: price('Claude Opus 4.7 Fast', 30, 150, 3, 37.5) },
  { match: 'opus-4-8-fast', price: price('Claude Opus 4.8 Fast', 10, 50, 1, 12.5) },
  { match: 'opus-4-1', price: price('Claude Opus 4.1', 15, 75, 1.5, 18.75) },
  { match: 'opus', price: price('Claude Opus', 5, 25, 0.5, 6.25) },
  { match: 'sonnet-5', price: price('Claude Sonnet 5', 2, 10, 0.2, 2.5) },
  { match: '4-sonnet-1m', price: price('Claude 4 Sonnet 1M', 6, 22.5, 0.6, 7.5) },
  { match: 'sonnet', price: price('Claude Sonnet', 3, 15, 0.3, 3.75) },
  { match: 'haiku-3-5', price: price('Claude Haiku 3.5', 0.8, 4, 0.08, 1) },
  { match: 'haiku', price: price('Claude Haiku', 1, 5, 0.1, 1.25) },
  { match: 'claude', price: price('Claude', 3, 15, 0.3, 3.75) },
  // OpenAI（读 0.1×；5.6 系写 1.25×，其余无写入费）
  { match: 'gpt-5-6-sol', price: price('GPT-5.6 Sol', 4, 20, 0.4, 5) },
  { match: 'gpt-5-6-terra', price: price('GPT-5.6 Terra', 2, 12, 0.2, 2.5) },
  { match: 'gpt-5-6-luna', price: price('GPT-5.6 Luna', 0.2, 1.2, 0.02, 0.25) },
  { match: 'gpt-5-5', price: price('GPT-5.5', 5, 30, 0.5) },
  { match: 'gpt-5-4-mini', price: price('GPT-5.4 Mini', 0.75, 4.5, 0.075) },
  { match: 'gpt-5-4-nano', price: price('GPT-5.4 Nano', 0.2, 1.25, 0.02) },
  { match: 'gpt-5-4', price: price('GPT-5.4', 2.5, 15, 0.25) },
  { match: 'gpt-5-3-codex', price: price('GPT-5.3 Codex', 1.75, 14, 0.175) },
  { match: 'gpt-5-2', price: price('GPT-5.2', 1.75, 14, 0.175) },
  { match: 'gpt-5-1-codex-mini', price: price('GPT-5.1 Codex Mini', 0.25, 2, 0.025) },
  { match: 'gpt-5-1', price: price('GPT-5.1', 1.25, 10, 0.125) },
  { match: 'gpt-5-mini', price: price('GPT-5 Mini', 0.25, 2, 0.025) },
  { match: 'gpt-5-fast', price: price('GPT-5 Fast', 2.5, 20, 0.25) },
  { match: 'gpt-5', price: price('GPT-5', 1.25, 10, 0.125) },
  { match: 'gpt-4-1', price: price('GPT-4.1', 2, 8, 0.5) },
  { match: 'gpt-4o-mini', price: price('GPT-4o mini', 0.15, 0.6, 0.075) },
  { match: 'gpt-4o', price: price('GPT-4o', 2.5, 10, 1.25) },
  { match: 'o4-mini', price: price('OpenAI o4-mini', 1.1, 4.4, 0.275) },
  { match: 'o3-mini', price: price('OpenAI o3-mini', 1.1, 4.4, 0.275) },
  { match: 'o3-pro', price: price('OpenAI o3-pro', 20, 80, 2) },
  { match: 'o3', price: price('OpenAI o3', 2, 8, 0.5) },
  { match: 'gpt', price: price('GPT', 1.25, 10, 0.125) },
  // Google（读 0.1×，无写入费；显式缓存的存储费不建模）
  { match: 'gemini-3-8-flash', price: price('Gemini 3.8 Flash', 0.75, 3.5, 0.075) },
  { match: 'gemini-3-7-flash', price: price('Gemini 3.7 Flash', 0.75, 3.5, 0.075) },
  { match: 'gemini-3-6-flash', price: price('Gemini 3.6 Flash', 1.5, 7.5, 0.15) },
  { match: 'gemini-3-5-flash', price: price('Gemini 3.5 Flash', 1.5, 9, 0.15) },
  { match: 'gemini-3-flash', price: price('Gemini 3 Flash', 0.5, 3, 0.05) },
  { match: 'gemini-2-5-flash', price: price('Gemini 2.5 Flash', 0.3, 2.5, 0.03) },
  { match: 'gemini-2-5-pro', price: price('Gemini 2.5 Pro', 1.25, 10, 0.31) },
  { match: 'gemini', price: price('Gemini 3 Pro', 2, 12, 0.2) },
  // Cursor 自家 / 联合训练模型（读 0.25×，无写入费）
  { match: 'grok-4-6-fast', price: price('Grok 4.6 Fast', 4, 12, 1) },
  { match: 'grok-4-5-fast', price: price('Grok 4.5 Fast', 4, 18, 1) },
  { match: 'grok', price: price('Grok', 2, 6, 0.5) },
  { match: 'composer-2-5-fast', price: price('Composer 2.5 Fast', 3, 15, 0.5) },
  { match: 'composer', price: price('Composer', 0.5, 2.5, 0.2) },
  // Moonshot / Z.ai（读 0.1× / 0.19×，无写入费）
  { match: 'kimi-k2-7', price: price('Kimi K2.7 Code', 0.95, 4, 0.19) },
  { match: 'kimi', price: price('Kimi K3', 3, 15, 0.3) },
  { match: 'glm', price: price('GLM 5.2', 1.4, 4.4, 0.26) },
  // Cursor 目录外（官方 API 价）：DeepSeek 非高峰价、缓存命中 ≈ 0.033×；Qwen3-Max 基础档隐式缓存 0.2×
  { match: 'deepseek-v4-flash', price: price('DeepSeek V4 Flash', 0.22, 0.66, 0.007) },
  { match: 'deepseek', price: price('DeepSeek V4 Pro', 0.66, 1.98, 0.022) },
  { match: 'qwen', price: price('Qwen3 Max', 0.359, 1.434, 0.072) }
]

const DEFAULT_PRICE: ModelTokenPrice = price('默认（Sonnet 档）', 3, 15, 0.3, 3.75)

function normalizeModelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

const MODEL_PRICE_MATCHERS = MODEL_PRICES.map((entry) => ({
  price: entry.price,
  pattern: new RegExp(`(^|-)${entry.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=-|$|\\d)`)
}))

/**
 * 按模型 id 解析单价表（归一化后按词边界匹配，表内顺序即优先级）。
 * 未命中（'auto'、新模型名、Cursor 内部代号）按 Sonnet 档估算，但标签如实
 * 显示真实模型名——用户看到的应是「哪个模型在什么口径下估算」，而不是一个
 * 凭空出现的「默认档」。标签含 'sonnet' 词，跨回合重解析仍命中同档价格。
 */
export function priceForModel(modelId: string | undefined): ModelTokenPrice {
  const key = normalizeModelKey(modelId ?? '')
  if (!key) return DEFAULT_PRICE
  const matched = MODEL_PRICE_MATCHERS.find((entry) => entry.pattern.test(key))?.price
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
 * - used 变化（无论方向，含上下文压缩回落）：新请求发生，token 按当时完整
 *   上下文累计（`inputTokens += used`，与事件通道口径一致——turnEnded 的
 *   inputTokens 本就是回合内全部请求的累计；2026-09-01 事故实测：单回合
 *   input 6.2M，远超 1M 上下文上限，实证口径）。
 *
 * 成本按缓存拆分近似（agentic 请求物理形态 = 前缀缓存命中 + 增量写入；
 * 实测 97% 缓存命中率下旧的全价口径高估 6~9 倍）：
 * - used 增长：存量前缀 contextLastUsed 按缓存读价、新增 delta 按缓存写价；
 * - used 回落（上下文压缩）：压缩后全量视为新前缀写入，按缓存写价（保守），
 *   基线重建；
 * - 输出 token：上下文读数拿不到，不计（轻微低估）——口径在 cursorUsageDetail
 *   如实标注。
 * cacheRead/cacheWrite 桶同步累计同一拆分（缓存是输入的子集，桶增量之和恰为
 * 本次 used），UI 分段条在采样模式下也有构成展示。
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
  const grown = sample.used > base.contextLastUsed
  const cacheReadTokens = grown ? base.contextLastUsed : 0
  const cacheWriteTokens = grown ? sample.used - base.contextLastUsed : sample.used
  // uncachedInput = used - read - write = 0：成本全部落在缓存读/写两桶上，
  // 复用 estimateTurnCostUsd 保证与事件通道同一套拆分公式。
  const requestCost = estimateTurnCostUsd({
    inputTokens: sample.used,
    outputTokens: 0,
    cacheReadTokens,
    cacheWriteTokens,
    occurredAt: sample.occurredAt
  }, price)
  return {
    ...touched,
    turns: base.turns + 1,
    inputTokens: base.inputTokens + sample.used,
    cacheReadTokens: base.cacheReadTokens + cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + cacheWriteTokens,
    estimatedCostUsd: base.estimatedCostUsd + requestCost,
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
    ? `输入 ${usage.inputTokens.toLocaleString()}（按请求上下文累计；缓存读 ${usage.cacheReadTokens.toLocaleString()}、缓存写 ${usage.cacheWriteTokens.toLocaleString()} 为近似拆分，输出未计入）`
    : `输入 ${usage.inputTokens.toLocaleString()}（含缓存读 ${usage.cacheReadTokens.toLocaleString()}、缓存写 ${usage.cacheWriteTokens.toLocaleString()}）· 输出 ${usage.outputTokens.toLocaleString()}`
  return `本轮 TeamRun 计费 token（${usage.pricedModel}，${usage.turns} 次请求）：${breakdown}；总计 ${totalUsageTokens(usage).toLocaleString()}；等价 API 成本估算 ${formatCostUsd(usage.estimatedCostUsd)}（基于当前 API 定价实时估算）；团队结束后冻结，下轮启动时清零`
}
