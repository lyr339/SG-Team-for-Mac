export type AgentLaunchStage = 'trigger' | 'composer' | 'waiting' | 'done' | 'failed'

export type AgentLaunchFailureCode = 'cdp_unavailable'

export interface AgentLaunchItem {
  channelId: string
  stage: AgentLaunchStage
  message: string
  composerId?: string
  /** 结构性失败原因；存在时 UI 可给出针对性引导（如一键重启 Cursor 启用调试端口）。 */
  code?: AgentLaunchFailureCode
}

export type AgentLaunchState = 'running' | 'done' | 'failed'

export interface AgentLaunchPlan {
  id: string
  state: AgentLaunchState
  items: AgentLaunchItem[]
  startedAt: number
  finishedAt?: number
}
