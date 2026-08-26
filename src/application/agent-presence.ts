import type { AgentAuthorizationIdentity } from './agent-authorization'

export interface AgentCheckInReceipt {
  workspaceId: string
  runId: string
  slotId: string
  roleName: string
  acknowledgedAt: number
}

export interface AgentPresenceStore {
  recordAgentCheckIn(identity: AgentAuthorizationIdentity, note: string): AgentCheckInReceipt
}
