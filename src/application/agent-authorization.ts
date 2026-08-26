export interface AgentAuthorizationIdentity {
  agentSessionId: string
  runId: string
  slotId?: string
  capabilities: string[]
}

export interface AgentRegistration {
  agentSessionId: string
  runtimeId?: string
  workspaceId: string
  channelId: string
  generation: string
  runId: string
  capabilities: string[]
}

export interface AgentRegistrationBatch {
  workspaceId: string
  generation: string
  runId: string
  agents: AgentRegistration[]
}

export interface AgentAuthorizer {
  assertAgentAuthorized(identity: AgentAuthorizationIdentity): void
}

export interface AgentRegistrationStore extends AgentAuthorizer {
  replaceWorkspaceAgentRegistrations(batch: AgentRegistrationBatch): void
}
