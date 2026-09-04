export type AgentSessionStatus =
  | 'starting'
  | 'idle'
  | 'running'
  | 'waiting'
  | 'review'
  | 'blocked'
  | 'reviving'
  | 'offline'
  | 'stopped'

export interface ContextUsageCategory {
  /** Cursor 原生 promptTokenBreakdown 分类 id。 */
  id: string
  /** Cursor 原生英文分类名。 */
  label: string
  estimatedTokens: number
}

export interface ContextUsageBreakdown {
  totalUsedTokens: number
  maxTokens: number
  categories: ContextUsageCategory[]
}

export interface ContextUsage {
  used?: number
  limit?: number
  ratio: number
  /** Cursor `composerData.promptTokenBreakdown` 原生统计，不由拾光估算。 */
  breakdown?: ContextUsageBreakdown
}

export interface ChangeSummary {
  additions: number
  deletions: number
  files?: number
}

export type AgentTelemetryState = 'bound' | 'unbound' | 'unavailable' | 'stale' | 'error'
export type AgentRuntimeEvidence = 'active' | 'suspected' | 'stopped'

export interface AgentTelemetryStatus {
  state: AgentTelemetryState
  detail: string
  source?: 'cursor-local'
  bindingMethod?: import('./cursor-telemetry').ComposerBindingMethod
  updatedAt?: number
}

/**
 * Cursor's currently selected Composer runtime configuration. This is kept
 * separate from modelName because it is a global/current setting, not proof of
 * the model that produced a historical session response.
 */
export interface AgentExecutionProfile {
  scope: 'cursor-composer-current'
  modelId: string
  displayName: string
  options: string[]
  maxMode: boolean
  contextTokenLimit?: number
}

export interface AgentSession {
  id: string
  channelId: string
  composerId?: string
  /** 通道最新转录定位的 composer（binding.composerId 缺失时的用量/上下文关联回退）。 */
  telemetryChannelComposerId?: string
  composerTitle?: string
  generation: number
  displayName: string
  roleName: string
  roleTemplateKey?: string
  /** 当前 TeamRun 唯一有效主控（含临时主控）。 */
  isEffectiveLead?: boolean
  avatarId?: string
  modelName?: string
  executionProfile?: AgentExecutionProfile
  status: AgentSessionStatus
  currentTask: string
  startedAt?: number
  disconnectedAt?: number
  activeDurationMs?: number
  lastAgentActivityAt?: number
  lastSeenAt?: number
  queueDepth: number
  connectionPhase: string
  /** 已投递待回复的出站消息身份（回复同步守门）；Agent record_reply 后清除。 */
  pendingOutboundId?: string
  /** 回复同步守门开启时间（与 pendingOutboundId 同写同清）。 */
  pendingReplySyncSince?: number
  online: boolean
  connected: boolean
  /** active=正面存活；suspected=仅租约陈旧；stopped=Cursor/运行时正面终止证据。 */
  runtimeEvidence?: AgentRuntimeEvidence
  /** 消息投递方式：queued 表示可离线入队，由 Cursor Agent 下次轮询取走。 */
  deliveryMode?: 'live' | 'queued'
  waiting: boolean
  contextUsage?: ContextUsage
  changes?: ChangeSummary
  /** 该 Composer 的持久化累积 token 用量与费用估算。 */
  usage?: import('./cursor-usage').CursorSessionUsage
  workingFiles: string[]
  healthEvidence: string[]
  telemetry?: AgentTelemetryStatus
}
