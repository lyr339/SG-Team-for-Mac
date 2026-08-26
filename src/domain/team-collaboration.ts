import type { AssignedAgentSkill } from './agent-skill'

export type TeamMessageKind = 'directive' | 'question' | 'response' | 'status' | 'notice'

export type TeamMessageNotificationState =
  | 'queued'
  | 'sending'
  | 'notified'
  | 'uncertain'
  | 'failed'
  | 'not_required'

export type TeamMessageReceiptStage =
  | 'queued'
  | 'notified'
  | 'read'
  | 'acknowledged'
  | 'responded'
  | 'uncertain'
  | 'failed'

export type TeamMessageActor =
  | { type: 'agent'; slotId: string }
  | { type: 'operator' }

export interface TeamMessageReceipt {
  notificationState: TeamMessageNotificationState
  notificationCommandId?: string
  notificationDetail: string
  notifiedAt?: number
  readAt?: number
  acknowledgedAt?: number
  respondedAt?: number
  responseMessageId?: string
  updatedAt: number
}

export interface TeamMessage {
  id: string
  runId: string
  threadId: string
  sender: TeamMessageActor
  recipient: TeamMessageActor
  kind: TeamMessageKind
  content: string
  replyToMessageId?: string
  clientMessageId: string
  createdAt: number
  receipt: TeamMessageReceipt
}

export interface TeamMessageThread {
  id: string
  runId: string
  subject: string
  createdAt: number
  updatedAt: number
}

export interface TeamCollaborationEvent {
  seq: number
  type: string
  runId: string
  threadId?: string
  messageId?: string
  actor: TeamMessageActor
  detail?: string
  at: number
}

export interface TeamCollaborationSnapshot {
  schemaVersion: 1
  revision: number
  seq: number
  runId?: string
  threads: TeamMessageThread[]
  messages: Record<string, TeamMessage>
  messageOrder: string[]
  events: TeamCollaborationEvent[]
  updatedAt: number
}

export interface CreateTeamMessageInput {
  runId: string
  sender: TeamMessageActor
  recipient: TeamMessageActor
  kind: TeamMessageKind
  content: string
  clientMessageId: string
  subject?: string
  threadId?: string
  replyToMessageId?: string
}

export interface AuthorizedTeamAgent {
  agentSessionId: string
  workspaceId: string
  runId: string
  slotId: string
  channelId: string
  roleKey: string
  roleTemplateKey: string
  roleName: string
  capabilities: string[]
  skills: AssignedAgentSkill[]
  /** 是否为临时主控：主控离线时由系统或手动指定，优先级高于角色模板。 */
  isActingLead?: boolean
}

/** 通道活性状态。 */
export type ChannelLiveness =
  | 'active'           // 已验证活跃
  | 'suspected_offline' // 疑似离线（ping 失败但未确认）
  | 'confirmed_offline' // 已确认离线（连续多次 ping 失败）

export interface ChannelLivenessRecord {
  channelId: string
  liveness: ChannelLiveness
  lastVerifiedAt: number
  consecutiveFailures: number
  lastPingAt?: number
  lastPongAt?: number
}

export interface TeamMemberDirectoryEntry {
  slotId: string
  roleKey: string
  roleTemplateKey: string
  roleName: string
  channelId?: string
  capabilities: string[]
  skills: AssignedAgentSkill[]
}

export interface TeamAgentRuntimeIdentity {
  agentSessionId: string
  runId: string
  slotId: string
  capabilities: string[]
}

export function emptyTeamCollaborationSnapshot(runId?: string): TeamCollaborationSnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    seq: 0,
    runId,
    threads: [],
    messages: {},
    messageOrder: [],
    events: [],
    updatedAt: Date.now()
  }
}

export function teamMessageReceiptStage(receipt: TeamMessageReceipt): TeamMessageReceiptStage {
  if (receipt.respondedAt !== undefined) return 'responded'
  if (receipt.acknowledgedAt !== undefined) return 'acknowledged'
  if (receipt.readAt !== undefined) return 'read'
  if (receipt.notificationState === 'notified' || receipt.notificationState === 'not_required') {
    return 'notified'
  }
  if (receipt.notificationState === 'uncertain') return 'uncertain'
  if (receipt.notificationState === 'failed') return 'failed'
  return 'queued'
}

export function teamMessageRequiresResponse(kind: TeamMessageKind): boolean {
  return kind === 'directive' || kind === 'question'
}

export function sameTeamMessageActor(left: TeamMessageActor, right: TeamMessageActor): boolean {
  return left.type === right.type
    && (left.type === 'operator' || (right.type === 'agent' && left.slotId === right.slotId))
}
