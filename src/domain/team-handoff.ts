import type { TeamFailoverRecord } from './team-failover'

export type TeamHandoffCandidateKind = 'standby' | 'member'

export interface TeamHandoffCandidate {
  agentSessionId: string
  kind: TeamHandoffCandidateKind
  channelId: string
  slotId?: string
  roleName: string
  avatarId?: string
  eligible: boolean
  blocker?: string
  impact: string
}

export interface TeamHandoffOptions {
  runId: string
  sourceSlotId: string
  sourceRoleName: string
  sourceChannelId: string
  candidates: TeamHandoffCandidate[]
}

export interface ManualTeamHandoffInput {
  sourceSlotId: string
  replacementAgentSessionId: string
}

export interface ManualTeamHandoffResult {
  failover: TeamFailoverRecord
  messageId: string
  vacatedSlotId?: string
}
