import type { AgentExecutionProfile, ChangeSummary, ContextUsage } from './agent-session'
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

/** 工具动作分组：驱动会话视图过程条目的图标与中文动作名。 */
export type CursorWorkToolKind = 'command' | 'read' | 'search' | 'edit' | 'write' | 'mcp' | 'todo' | 'other'

/** 过程条目中的任务清单项（来自 TodoWrite 工具调用的结构化快照）。 */
export interface CursorWorkTodo {
  content: string
  /** 原样透传：pending / in_progress / completed / cancelled。 */
  status: string
}

/** Cursor 工具调用的可展开明细。来源是 transcript 持久化的 tool input。 */
export interface CursorWorkDetail {
  label: string
  value: string
  kind?: 'text' | 'code' | 'path'
}

/**
 * Cursor 工作过程条目：从 agent-transcripts 增量解析出的助手侧动作
 *（可见叙述 / 工具调用），用于群枢会话视图回显 Cursor 内的工作过程。
 * qtwx-mcp 通道自身的保活轮询噪音已在解析侧过滤。
 */
export interface CursorWorkEntry {
  kind: 'text' | 'tool'
  /** text：助手可见叙述；tool：工具调用的简短摘要（如 ReadFile src/a.ts）。 */
  text: string
  toolName?: string
  /** kind=tool 时的动作分组（图标/动作名）。 */
  toolKind?: CursorWorkToolKind
  /** toolKind=todo 时的任务清单快照（来自 TodoWrite 的结构化 input）。 */
  todos?: CursorWorkTodo[]
  /** 工具调用输入明细。Cursor transcript 不包含 tool result，因此这里不是执行输出。 */
  details?: CursorWorkDetail[]
  /**
   * kind=tool 时的执行状态。转录不含工具结果块，解析侧以「后续新行出现」
   * 推断完成（Cursor 顺序执行：结果返回后助手才会续写），转录尾部
   * 最后一个工具保持 running。
   */
  status?: 'running' | 'done'
  /** 转录行号——跨轮询稳定，用作时间线条目 id 的一部分。 */
  line: number
  /** 首次被观测到的本地时间（转录条目本身不带时间戳）。 */
  at: number
  /**
   * 所属 Cursor/群枢回合。优先来自 record_process / record_reply 的 turn；
   * 没有显式 turn 时由解析层按协议边界生成隐式 turn，避免多轮过程串成一条长链。
   */
  turn?: string
}

export interface CursorComposerTelemetry {
  composerId: string
  title: string
  createdAt?: number
  lastUpdatedAt?: number
  modelName?: string
  activity?: CursorComposerActivity
  contextUsage?: ContextUsage
  changes?: ChangeSummary
  /** 最近的工作过程条目（尾部限界，按转录顺序）。 */
  workEntries?: CursorWorkEntry[]
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

/**
 * This marker is deliberately deterministic and contains no user content. It is
 * added to the launch prompt so the external control plane can bind a QingTian
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
  return `[[QINGTIAN_TEAM_BIND:${bindingKey}:CH-${channelId}]]`
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
