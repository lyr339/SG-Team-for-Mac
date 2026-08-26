export type TeamFailoverStatus =
  | 'waiting_for_agent'
  | 'completed'
  | 'failed'

export interface TeamFailoverRecord {
  id: string
  workspaceId: string
  runId: string
  slotId: string
  roleName: string
  fromChannelId: string
  fromAgentSessionId: string
  toChannelId?: string
  toAgentSessionId?: string
  status: TeamFailoverStatus
  reason: string
  checkpointId?: string
  messageId?: string
  taskIds: string[]
  detectedAt: number
  updatedAt: number
  completedAt?: number
}

export interface TeamFailoverRebindResult {
  record: TeamFailoverRecord
  bindingKey: string
}
