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
  generationId?: string
  modelId?: string
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
  /** V3 为原生 generation 数，不是工具调用数或模型请求数。 */
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
  quality?: 'exact' | 'mixed' | 'estimated' | 'legacy'
  ledger?: CursorUsageLedger
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

function price(label: string, inputPerM: number, outputPerM: number, cacheReadPerM: number, cacheWritePerM = inputPerM): ModelTokenPrice {
  return { label, inputPerM, outputPerM, cacheReadPerM, cacheWritePerM }
}

/**
 * 模型牌价表（USD / 1M tokens，牌价快照 2026-09-04；核对时以 cursor.com/docs/models-and-pricing 为准）。
 * 来源：Cursor「Models & Pricing」页（Cursor 按模型 API 价扣用量，与「等价 API 成本」口径一致）；
 * Cursor 目录外的 DeepSeek / Qwen 取官方 API 标价（DeepSeek 为非高峰价）。
 * 长上下文（>200K）加价、Fast 未列变体、区域加价不建模。
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

/** 内部账本按原生 generation 隔离；UI 字段由它投影，避免回合/会话累计混用。 */
export interface UsageTurn {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  estimatedCostUsd: number
  price: ModelTokenPrice
  exact: boolean
  lastUsed?: number
  /** 用户参考图的拆分方案；随回合保存，模型切换不追溯修改旧账。 */
  estimateProfile?: string
  stopped?: boolean
  at: number
}
export interface CursorUsageLedger {
  turns: Record<string, UsageTurn>
  frozenAt?: number
}
export interface CursorUsageSample {
  composerId: string
  generationId: string
  modelId?: string
  used: number
  occurredAt: number
  stopped?: boolean
}
export type UsageObservation =
  | { kind: 'sample'; value: CursorUsageSample }
  | { kind: 'checkpoint'; value: CursorUsageEvent & { generationId: string } }

// 用户提供的累计用量截图（2026-09-05）：仅作近似拆分的比例，不是模型牌价或实测本会话用量。
const USAGE_PROFILES = {
  // 用户 Claude Code 累计截图：四项是显示层舍入值，以四项合计归一，不用顶部精确总数反推缺口。
  claudeCode: { input: 1_343_000, output: 42_535_000, write: 345_000_000, read: 12_706_000_000 },
  // 保留旧 profile 键以读取已落盘回合；Claude 的估算在 upgradeUsageEstimate 中迁移一次。
  fable: { input: 354, output: 242_500, write: 1_630_000, read: 23_060_000 },
  opus46: { input: 87, output: 37_200, write: 459_100, read: 2_970_000 },
  opus5: { input: 18, output: 9_091, write: 50_900, read: 239_500 },
  grok: { input: 145_900, output: 7_288, write: 0, read: 322_800 },
  default: { input: 146_400, output: 296_100, write: 2_140_000, read: 26_590_000 }
} as const

function usageProfile(model: string | undefined): keyof typeof USAGE_PROFILES {
  const key = normalizeModelKey(model ?? '')
  if (/^(?:anthropic-)?(?:claude|fable|opus|sonnet|haiku)(?:-|$|\d)/.test(key)) return 'claudeCode'
  if (key.includes('grok')) return 'grok'
  return 'default'
}

/** 输入总量含缓存；按参考图拆分并推算输出，费用仍走同一套已固定的模型单价。 */
export function estimateUsageFromReference(inputTokens: number, model: string | undefined, price: ModelTokenPrice) {
  const profile = usageProfile(model)
  return referenceUsage(inputTokens, profile, price)
}

function referenceUsage(inputTokens: number, profile: keyof typeof USAGE_PROFILES, price: ModelTokenPrice) {
  const weights = USAGE_PROFILES[profile]
  const totalInput = weights.input + weights.read + weights.write
  const fresh = Math.round(inputTokens * weights.input / totalInput)
  const cacheWriteTokens = Math.round(inputTokens * weights.write / totalInput)
  const cacheReadTokens = Math.max(0, inputTokens - fresh - cacheWriteTokens)
  const outputTokens = Math.round(inputTokens * weights.output / totalInput)
  const counts = { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens }
  return { ...counts, estimateProfile: profile,
    estimatedCostUsd: estimateTurnCostUsd({ ...counts, occurredAt: 0 }, price) }
}

/** 给此前缺少输出的估算补上参考拆分；精确回合和已使用该方案的回合保持原值。 */
export function upgradeUsageEstimate(usage: CursorSessionUsage): CursorSessionUsage {
  if (!usage.ledger) return usage
  let changed = false
  const turns = Object.fromEntries(Object.entries(usage.ledger.turns).map(([id, turn]) => {
    const claudeUpgrade = turn.estimateProfile !== 'claudeCode'
      && (['fable', 'opus46', 'opus5'].includes(turn.estimateProfile ?? '') || usageProfile(turn.price.label) === 'claudeCode')
    if (turn.exact || (turn.estimateProfile && !claudeUpgrade)) return [id, turn]
    changed = true
    return [id, { ...turn, ...referenceUsage(turn.inputTokens, claudeUpgrade ? 'claudeCode' : usageProfile(turn.price.label), turn.price) }]
  }))
  return changed ? projectUsage(usage.composerId, { ...usage.ledger, turns }) : usage
}

export function projectUsage(composerId: string, ledger: CursorUsageLedger): CursorSessionUsage {
  const turns = Object.values(ledger.turns)
  const exact = turns.filter((turn) => turn.exact).length
  const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'estimatedCostUsd'): number =>
    turns.reduce((total, turn) => total + turn[key], 0)
  const models = [...new Set(turns.map((turn) => turn.price.label))]
  return {
    composerId, turns: turns.length,
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens'),
    estimatedCostUsd: sum('estimatedCostUsd'), pricedModel: models.length === 1 ? models[0]! : 'Mixed models',
    lastTurnAt: Math.max(0, ...turns.map((turn) => turn.at)),
    quality: exact === turns.length && turns.length > 0 ? 'exact' : exact ? 'mixed' : 'estimated', ledger
  }
}

/** 快照与 binding 都是同一 generation 的校准，不是两笔消费。 */
export function reduceUsage(current: CursorSessionUsage | undefined, observation: UsageObservation): CursorSessionUsage | undefined {
  const event = observation.value
  if (!event.generationId || !Number.isFinite(event.occurredAt) || event.occurredAt < 0) return current
  // V2 无 generation 身份，保留展示至下一 run，不与 V3 精确账混加。
  if (current && !current.ledger) return current
  const ledger = current?.ledger ?? { turns: {} }
  const previous = Object.hasOwn(ledger.turns, event.generationId) ? ledger.turns[event.generationId] : undefined
  // 结束即冻结，含迟到结算；用户明确要求结束后显示值固定。
  if (ledger.frozenAt !== undefined) return current
  const price = previous?.price ?? priceForModel(event.modelId)
  let next: UsageTurn
  if (observation.kind === 'checkpoint') {
    const exact = observation.value
    const values = [exact.inputTokens, exact.outputTokens, exact.cacheReadTokens, exact.cacheWriteTokens]
    if (values.some((n) => !Number.isSafeInteger(n) || n < 0)
      || exact.cacheReadTokens + exact.cacheWriteTokens > exact.inputTokens) return current
    // 中断路径可能只携带默认零值，并非一次完整的计费结算；保留已有近似数值。
    if (exact.inputTokens + exact.outputTokens === 0) return current
    if (previous?.exact) return current // 首个权威结算封口，同源轮询重放不刷新时间/重算价格。
    next = { inputTokens: exact.inputTokens, outputTokens: exact.outputTokens,
      cacheReadTokens: exact.cacheReadTokens, cacheWriteTokens: exact.cacheWriteTokens,
      estimatedCostUsd: estimateTurnCostUsd(exact, price), price, exact: true, at: exact.occurredAt }
  } else {
    const sample = observation.value
    if (!Number.isSafeInteger(sample.used) || sample.used <= 0 || previous?.exact || previous?.stopped
      || (previous && sample.occurredAt < previous.at)) return current
    const base = previous ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, price, exact: false, at: 0 }
    const changed = sample.used !== base.lastUsed
    if (!changed && !sample.stopped) return current
    const profile = base.estimateProfile && Object.hasOwn(USAGE_PROFILES, base.estimateProfile)
      ? base.estimateProfile as keyof typeof USAGE_PROFILES : usageProfile(event.modelId ?? price.label)
    next = { ...base, ...referenceUsage(base.inputTokens + (changed ? sample.used : 0), profile, price),
      lastUsed: sample.used, at: sample.occurredAt, ...(sample.stopped ? { stopped: true } : {}) }
  }
  return projectUsage(event.composerId, { ...ledger, turns: { ...ledger.turns, [event.generationId]: next } })
}

/** 输入已包含缓存读写，总量不重复加缓存。 */
export function totalUsageTokens(usage: Pick<CursorSessionUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return usage.inputTokens + usage.outputTokens
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
  const fresh = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens)
  return `Tokens ${formatTokenCount(totalUsageTokens(usage))} · Cost ${formatCostUsd(usage.estimatedCostUsd)} · Input ${formatTokenCount(fresh)} · Output ${formatTokenCount(usage.outputTokens)} · Cache Write ${formatTokenCount(usage.cacheWriteTokens)} · Cache Read ${formatTokenCount(usage.cacheReadTokens)}`
}
