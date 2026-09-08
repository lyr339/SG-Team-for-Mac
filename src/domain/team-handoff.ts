import type { SessionHandoffResult } from './session-handoff'
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
  /**
   * 职责迁移成功后，把原席位的上下文文档（Cursor 转录 + 拾光会话记录）作为一条用户消息
   * 排进接手通道队列。上下文在迁移前解析（迁移会改写原席位绑定），投递失败不回滚迁移。
   */
  includeContext?: boolean
}

export interface ManualTeamHandoffResult {
  mode: TeamHandoffMode
  failover?: TeamFailoverRecord
  messageId: string
  vacatedSlotId?: string
  actingLeadSlotId?: string
  recoveredTaskIds?: string[]
}

/** 随职责迁移附带的上下文交接结果；只在 includeContext 时出现。 */
export type ContextHandoffOutcome =
  | { ok: true; result: SessionHandoffResult }
  | { ok: false; error: string }

export interface ManualTeamHandoffOutcome {
  handoff: ManualTeamHandoffResult
  contextHandoff?: ContextHandoffOutcome
}
