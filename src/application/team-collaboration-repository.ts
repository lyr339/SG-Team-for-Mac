import type {
  AuthorizedTeamAgent,
  CreateTeamMessageInput,
  TeamAgentRuntimeIdentity,
  TeamCollaborationSnapshot,
  TeamMessage,
  TeamMemberDirectoryEntry
} from '../domain/team-collaboration'

import type { ChannelLivenessRecord } from '../domain/team-collaboration'

export interface TeamCollaborationRepository {
  loadRun(runId: string): TeamCollaborationSnapshot
  revision(): number
  resolveAuthorizedAgent(identity: TeamAgentRuntimeIdentity): AuthorizedTeamAgent
  listRunMembers(runId: string): TeamMemberDirectoryEntry[]
  clearRun(runId: string, at?: number): boolean
  createMessage(input: CreateTeamMessageInput): TeamMessage
  markNotificationSending(messageId: string, commandId: string, detail?: string, at?: number): TeamMessage
  markNotificationResult(
    messageId: string,
    result: 'notified' | 'uncertain' | 'failed',
    detail: string,
    at?: number
  ): TeamMessage
  markRead(messageId: string, recipient: TeamMessage['recipient'], at?: number): TeamMessage
  acknowledge(messageId: string, recipient: TeamMessage['recipient'], at?: number): TeamMessage
  listPendingNotifications(runId?: string, limit?: number): TeamMessage[]
  recoverStaleSending(beforeAt: number): number
  /** 记录通道活性验证结果。 */
  recordLiveness(input: { channelId: string; runId: string; verified: boolean; at: number }): void
  /** 获取通道活性记录。 */
  getLiveness(channelId: string, runId: string): ChannelLivenessRecord | undefined
  /** 列出当前 run 的所有活性记录。 */
  listLiveness(runId: string): ChannelLivenessRecord[]
  close(): void
}
