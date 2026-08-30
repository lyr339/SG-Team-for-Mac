import type { TeamFailoverRecord } from './team-failover'

export type TeamHandoffCandidateKind = 'standby' | 'member'
export type TeamHandoffMode = 'role_rebind' | 'lead_authority'

export interface TeamHandoffCandidate {
  agentSessionId: string
  kind: TeamHandoffCandidateKind
  mode: TeamHandoffMode
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
  mode: TeamHandoffMode
  failover?: TeamFailoverRecord
  messageId: string
  vacatedSlotId?: string
  actingLeadSlotId?: string
  recoveredTaskIds?: string[]
}
