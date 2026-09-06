import type { AgentExecutionProfile, ChangeSummary, ContextUsage } from './agent-session'
import type { ProcessBlock } from './conversation-entry'
import type { CursorModelOption } from './cursor-model'

export type CursorTelemetryAvailability = 'available' | 'unavailable' | 'error'

export type ComposerBindingMethod = 'launch_marker' | 'channel_marker'

export type CursorComposerActivityState = 'active' | 'waiting' | 'stopped' | 'unknown'

export interface CursorComposerActivity {
  state: CursorComposerActivityState
  detail: string
  observedAt?: number
  channelId?: string
  /**
   * 最后的 Agent 活动是干活特征（tool/assistant）且仍在长任务宽限期内：
   * 转录暂停增长属正常（如执行长命令），不构成死亡证据，调用方不应据此判离线。
   */
  workInProgress?: boolean
}

export interface CursorComposerTelemetry {
  composerId: string
  title: string
  createdAt?: number
  lastUpdatedAt?: number
  modelName?: string
  /** 该 Composer 的独立模型配置（逐会话）；缺失时消费方回退全局当前配置。 */
  modelProfile?: AgentExecutionProfile
  activity?: CursorComposerActivity
  contextUsage?: ContextUsage
  changes?: ChangeSummary
  /** Cursor 转录中最后一条完整 Assistant 文本；record_reply 失败时作为耐久展示来源。 */
  lastAssistantResponse?: { id: string; text: string; observedAt: number }
  /** 同一最终回复之前的 Cursor 原生思考/工具序列；应用重启后恢复过程卡。 */
  lastAssistantProcess?: { blocks: ProcessBlock[]; observedAt: number }
}

export interface ComposerBindingCandidate {
  channelId: string
  composerId: string
  generation: string
  bindingKey: string
  method: ComposerBindingMethod
}

export type CursorChannelActivityState = 'active' | 'stopped' | 'unknown'

/**
 * 通道级产出活性证据：跨全部项目目录定位「提到该通道的最新转录」得出，
 * 不依赖 composer 绑定。用于交叉验证传输层（插件 WS 自报）的在线/待命声称——
 * 认证失效的 composer 可能空转轮询 check_messages 维持保活，但转录不再产出。
 */
export interface CursorChannelActivity {
  channelId: string
  state: CursorChannelActivityState
  detail: string
  observedAt?: number
  /** 通道最新转录所属的 composerId（转录目录名），用于跨工作区水合上下文。 */
  composerId?: string
}

export interface CursorTelemetrySnapshot {
  availability: CursorTelemetryAvailability
  workspacePath?: string
  composerProfile?: AgentExecutionProfile
  cursorModels?: CursorModelOption[]
  composers: CursorComposerTelemetry[]
  bindingCandidates: ComposerBindingCandidate[]
  /** 按通道号的产出活性证据（全局转录扫描），与 composer 绑定解耦。 */
  channelActivities?: Record<string, CursorChannelActivity>
  updatedAt: number
  issue?: string
}

const SAFE_GENERATION = /^[a-zA-Z0-9_-]{1,128}$/
const SAFE_CHANNEL_ID = /^\d{1,12}$/
const BINDING_MARKER_TAG = 'SG_TEAM_BIND'
/** 从 Composer 转录提取绑定标记。 */
export const BINDING_MARKER_PATTERN = new RegExp(
  `\\[\\[${BINDING_MARKER_TAG}:[a-zA-Z0-9_-]{1,128}:CH-\\d{1,12}\\]\\]`,
  'g'
)

/**
 * This marker is deliberately deterministic and contains no user content. It is
 * added to the launch prompt so the external control plane can bind an SG Team
 * channel to the exact Cursor Composer transcript without relying on timing.
 */
export function cursorComposerBindingMarker(input: {
  bindingKey: string
  channelId: string
}): string {
  const bindingKey = input.bindingKey.trim()
  const channelId = input.channelId.trim()
  if (!SAFE_GENERATION.test(bindingKey)) throw new Error('Cursor 会话绑定键无效')
  if (!SAFE_CHANNEL_ID.test(channelId)) throw new Error('通道号无法用于 Cursor 会话绑定')
  return `[[${BINDING_MARKER_TAG}:${bindingKey}:CH-${channelId}]]`
}

export function emptyCursorTelemetrySnapshot(
  availability: CursorTelemetryAvailability = 'unavailable',
  issue?: string
): CursorTelemetrySnapshot {
  return {
    availability,
    composers: [],
    bindingCandidates: [],
    updatedAt: Date.now(),
    issue
  }
}
