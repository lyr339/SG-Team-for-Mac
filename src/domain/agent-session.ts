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

export interface ContextUsage {
  used?: number
  limit?: number
  ratio: number
}

export interface ChangeSummary {
  additions: number
  deletions: number
  files?: number
}

export type AgentTelemetryState = 'bound' | 'unbound' | 'unavailable' | 'stale' | 'error'

export interface AgentTelemetryStatus {
  state: AgentTelemetryState
  detail: string
  source?: 'cursor-local'
  bindingMethod?: 'launch_marker' | 'channel_marker'
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
  composerTitle?: string
  generation: number
  displayName: string
  roleName: string
  roleTemplateKey?: string
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
  online: boolean
  connected: boolean
  /** 消息投递方式：queued 表示可离线入队，由 Cursor Agent 下次轮询取走。 */
  deliveryMode?: 'live' | 'queued'
  waiting: boolean
  contextUsage?: ContextUsage
  changes?: ChangeSummary
  /** Cursor 内的工作过程条目（叙述/工具调用），来自转录增量解析，会话视图回显用。 */
  workEntries?: import('./cursor-telemetry').CursorWorkEntry[]
  workingFiles: string[]
  healthEvidence: string[]
  telemetry?: AgentTelemetryStatus
}
