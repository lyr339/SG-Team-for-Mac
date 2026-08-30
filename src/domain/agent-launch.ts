import type { CursorModelSelection } from './cursor-model'

export type AgentLaunchStage = 'trigger' | 'composer' | 'waiting' | 'done' | 'failed'

export type AgentLaunchFailureCode = 'cdp_unavailable' | 'runtime_account_mismatch' | 'membership_blocked'

export interface AgentLaunchItem {
  channelId: string
  modelSelection?: CursorModelSelection
  stage: AgentLaunchStage
  message: string
  composerId?: string
  /** 结构性失败原因；存在时 UI 可给出针对性引导（如一键重启 Cursor 启用调试端口）。 */
  code?: AgentLaunchFailureCode
}

export interface AgentLaunchRequest {
  channelId: string
  modelSelection?: CursorModelSelection
}

export type AgentLaunchState = 'running' | 'done' | 'failed'

export interface AgentLaunchPlan {
  id: string
  state: AgentLaunchState
  items: AgentLaunchItem[]
  startedAt: number
  finishedAt?: number
}
