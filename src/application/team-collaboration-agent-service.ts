import { createHash, randomUUID } from 'node:crypto'
import type { PlanTaskInput } from '../domain/task-pool'
import { TaskPoolError } from '../domain/task-pool'
import type {
  AuthorizedTeamAgent,
  ChannelLivenessRecord,
  TeamAgentRuntimeIdentity,
  TeamMessage,
  TeamMessageKind
} from '../domain/team-collaboration'
import {
  sameTeamMessageActor,
  teamMessageReceiptStage,
  teamMessageRequiresResponse
} from '../domain/team-collaboration'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { AgentTaskView, TaskAgentService } from './task-agent-service'
import { orchestratorMessageId } from './orchestration-source'

const GENERATED_MESSAGE_ID_BUCKET_MS = 30_000

function generatedClientMessageId(prefix: string, parts: unknown[]): string {
  const bucket = Math.floor(Date.now() / GENERATED_MESSAGE_ID_BUCKET_MS)
  const hash = createHash('sha256')
    .update(JSON.stringify([bucket, ...parts]))
    .digest('hex')
    .slice(0, 24)
  return `${prefix}:${hash}:${bucket}`
}

export interface TeamInboxEntry {
  id: string
  threadId: string
  sender: TeamMessage['sender']
  kind: TeamMessageKind
  preview: string
  createdAt: number
  stage: ReturnType<typeof teamMessageReceiptStage>
}

export class TeamCollaborationAgentService {
  readonly identity: TeamAgentRuntimeIdentity

  constructor(
    private readonly repository: TeamCollaborationRepository,
    identity: TeamAgentRuntimeIdentity,
    private readonly tasks: TaskAgentService
  ) {
    const agentSessionId = identity.agentSessionId.trim()
    const runId = identity.runId.trim()
    const slotId = identity.slotId.trim()
    if (!/^[a-zA-Z0-9:_-]{3,200}$/.test(agentSessionId)) {
      throw new Error('QINGTIAN_AGENT_SESSION_ID 无效')
    }
    if (!/^[a-zA-Z0-9:_-]{3,200}$/.test(runId)) throw new Error('QINGTIAN_TEAM_RUN_ID 无效')
    if (!/^[a-zA-Z0-9:_-]{3,240}$/.test(slotId)) throw new Error('QINGTIAN_AGENT_SLOT_ID 无效')
    this.identity = {
      agentSessionId,
      runId,
      slotId,
      capabilities: [...new Set(identity.capabilities.map((item) => item.trim()).filter(Boolean))]
    }
  }

  getContext(): Record<string, unknown> {
    const agent = this.currentAgent()
    const members = this.repository.listRunMembers(agent.runId)
    const snapshot = this.repository.loadRun(agent.runId)
    const self = { type: 'agent' as const, slotId: agent.slotId }
    const unread = snapshot.messageOrder
      .map((id) => snapshot.messages[id])
      .filter((message): message is TeamMessage => Boolean(message))
      .filter((message) => sameTeamMessageActor(message.recipient, self) && message.receipt.readAt === undefined)
      .length
    const awaitingResponses = snapshot.messageOrder
      .map((id) => snapshot.messages[id])
      .filter((message): message is TeamMessage => Boolean(message))
      .filter((message) => sameTeamMessageActor(message.sender, self))
      .filter((message) => (
        message.recipient.type === 'agent'
        && teamMessageRequiresResponse(message.kind)
        && message.receipt.respondedAt === undefined
      ))
      .length
    const liveness = this.repository.listLiveness(agent.runId)
    const memberLiveness = new Map(members.map((member) => {
      const record = liveness.find((item) => item.channelId === member.channelId)
      return [member.slotId, record?.liveness ?? 'unknown']
    }))
    return {
      self: agent,
      members: members.map((member) => ({
        ...member,
        liveness: memberLiveness.get(member.slotId)
      })),
      unreadMessages: unread,
      awaitingResponses,
      instructions: unread > 0
        ? '先调用 team_list_inbox，再对需要处理的消息调用 team_read_message。'
        : '当前没有未读团队消息。'
    }
  }

  isCoordinator(): boolean {
    const agent = this.currentAgent()
    if (agent.isActingLead) return true
    const capabilities = new Set(this.identity.capabilities)
    return capabilities.has('coordination') && capabilities.has('planning')
  }

  listInbox(unreadOnly = true, limit = 30): TeamInboxEntry[] {
    const agent = this.currentAgent()
    const self = { type: 'agent' as const, slotId: agent.slotId }
    const snapshot = this.repository.loadRun(agent.runId)
    return snapshot.messageOrder
      .map((id) => snapshot.messages[id])
      .filter((message): message is TeamMessage => Boolean(message))
      .filter((message) => sameTeamMessageActor(message.recipient, self))
      .filter((message) => !unreadOnly || message.receipt.readAt === undefined)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, Math.min(100, Math.max(1, Math.floor(limit))))
      .map((message) => ({
        id: message.id,
        threadId: message.threadId,
        sender: message.sender,
        kind: message.kind,
        preview: message.content.replace(/\s+/g, ' ').slice(0, 180),
        createdAt: message.createdAt,
        stage: teamMessageReceiptStage(message.receipt)
      }))
  }

  readMessage(messageId: string): TeamMessage {
    const agent = this.currentAgent()
    return this.repository.markRead(
      messageId,
      { type: 'agent', slotId: agent.slotId }
    )
  }

  sendMessage(input: {
    recipientSlotId: string
    kind: Exclude<TeamMessageKind, 'response'>
    content: string
    subject?: string
    clientMessageId?: string
  }): TeamMessage {
    const agent = this.currentAgent()
    if (input.kind === 'directive' && agent.roleTemplateKey !== 'lead' && !agent.isActingLead) {
      throw new TaskPoolError('lead_only_directive', '只有主控协调可以发送任务指令')
    }
    const recipientSlotId = input.recipientSlotId.trim()
    if (!this.repository.listRunMembers(agent.runId).some((member) => member.slotId === recipientSlotId)) {
      throw new TaskPoolError('recipient_not_found', '目标 AgentSlot 不属于当前 TeamRun')
    }
    return this.repository.createMessage({
      runId: agent.runId,
      sender: { type: 'agent', slotId: agent.slotId },
      recipient: { type: 'agent', slotId: recipientSlotId },
      kind: input.kind,
      content: input.content,
      subject: input.subject,
      clientMessageId: input.clientMessageId?.trim() || generatedClientMessageId('agent-message', [
        agent.runId,
        agent.slotId,
        recipientSlotId,
        input.kind,
        input.subject ?? '',
        input.content
      ])
    })
  }

  broadcast(input: {
    kind: 'question' | 'notice'
    content: string
    subject?: string
    clientMessageId?: string
  }): TeamMessage[] {
    const agent = this.currentAgent()
    if (agent.roleTemplateKey !== 'lead' && !agent.isActingLead) {
      throw new TaskPoolError('lead_only_broadcast', '只有主控协调可以向全体成员广播')
    }
    const recipients = this.repository.listRunMembers(agent.runId)
      .filter((member) => member.slotId !== agent.slotId)
    const baseId = input.clientMessageId?.trim() || generatedClientMessageId('agent-broadcast', [
      agent.runId,
      agent.slotId,
      input.kind,
      input.subject ?? '',
      input.content
    ])
    return recipients.map((recipient) => this.repository.createMessage({
      runId: agent.runId,
      sender: { type: 'agent', slotId: agent.slotId },
      recipient: { type: 'agent', slotId: recipient.slotId },
      kind: input.kind,
      subject: input.subject,
      content: input.content,
      clientMessageId: orchestratorMessageId('broadcast', baseId, recipient.slotId)
    }))
  }

  collectResponses(messageIds?: string[]): Array<{
    messageId: string
    recipientSlotId: string
    stage: ReturnType<typeof teamMessageReceiptStage>
    response?: string
  }> {
    const agent = this.currentAgent()
    if (agent.roleTemplateKey !== 'lead' && !agent.isActingLead) {
      throw new TaskPoolError('lead_only_collect', '只有主控协调可以集中收集团队回应')
    }
    const requestedIds = (messageIds ?? []).map((id) => id.trim()).filter(Boolean)
    const requested = new Set(requestedIds)
    const requestedOrder = new Map(requestedIds.map((id, index) => [id, index]))
    const snapshot = this.repository.loadRun(agent.runId)
    const self = { type: 'agent' as const, slotId: agent.slotId }
    return snapshot.messageOrder
      .map((id) => snapshot.messages[id])
      .filter((message): message is TeamMessage => Boolean(message))
      .filter((message) => sameTeamMessageActor(message.sender, self) && message.recipient.type === 'agent')
      .filter((message) => message.kind === 'question' || message.kind === 'notice')
      .filter((message) => requested.size === 0 || requested.has(message.id))
      .sort((left, right) => requested.size
        ? (requestedOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
          - (requestedOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
        : left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map((message) => ({
        messageId: message.id,
        recipientSlotId: message.recipient.type === 'agent' ? message.recipient.slotId : '',
        stage: teamMessageReceiptStage(message.receipt),
        response: message.receipt.responseMessageId
          ? snapshot.messages[message.receipt.responseMessageId]?.content
          : undefined
      }))
  }

  reportTaskStatus(input: {
    taskId: string
    subject: string
    content: string
    eventKey: string
  }): TeamMessage | undefined {
    const agent = this.currentAgent()
    if (agent.roleTemplateKey === 'lead') return undefined
    const lead = this.repository.listRunMembers(agent.runId)
      .find((member) => member.roleTemplateKey === 'lead')
    if (!lead) return undefined
    return this.repository.createMessage({
      runId: agent.runId,
      sender: { type: 'agent', slotId: agent.slotId },
      recipient: { type: 'agent', slotId: lead.slotId },
      kind: 'status',
      subject: input.subject,
      content: input.content,
      clientMessageId: orchestratorMessageId('task-status', input.taskId, input.eventKey)
    })
  }

  respondMessage(input: {
    messageId: string
    content: string
    clientMessageId?: string
  }): TeamMessage {
    const agent = this.currentAgent()
    const snapshot = this.repository.loadRun(agent.runId)
    const original = snapshot.messages[input.messageId.trim()]
    const self = { type: 'agent' as const, slotId: agent.slotId }
    if (!original || !sameTeamMessageActor(original.recipient, self)) {
      throw new TaskPoolError('message_recipient_mismatch', '只能回应发给当前 AgentSlot 的消息')
    }
    this.repository.acknowledge(original.id, self)
    return this.repository.createMessage({
      runId: agent.runId,
      sender: self,
      recipient: original.sender,
      kind: 'response',
      content: input.content,
      clientMessageId: input.clientMessageId?.trim() || generatedClientMessageId('agent-response', [
        agent.runId,
        agent.slotId,
        original.id,
        input.content
      ]),
      threadId: original.threadId,
      replyToMessageId: original.id
    })
  }

  listTaskBoard(): AgentTaskView[] {
    this.currentAgent()
    return this.tasks.listBoard()
  }

  /**
   * 发送活性验证 ping 到指定通道。
   * 目标通道应在 5 秒内调用 team_pong 响应。
   */
  ping(input: { targetChannelId: string; timeoutMs?: number }): { pingId: string; sentAt: number } {
    const agent = this.currentAgent()
    const members = this.repository.listRunMembers(agent.runId)
    const target = members.find((member) => member.channelId === input.targetChannelId)
    if (!target) throw new TaskPoolError('target_channel_not_found', `目标通道 CH-${input.targetChannelId} 不属于当前 TeamRun`)
    const pingId = `ping:${randomUUID()}`
    const sentAt = Date.now()
    this.repository.createMessage({
      runId: agent.runId,
      sender: { type: 'agent', slotId: agent.slotId },
      recipient: { type: 'agent', slotId: target.slotId },
      kind: 'question',
      subject: '活性验证 ping',
      content: `【活性验证】请立即调用 team_pong 响应。pingId: ${pingId}`,
      clientMessageId: pingId
    })
    this.repository.recordLiveness({
      channelId: input.targetChannelId,
      runId: agent.runId,
      verified: false,
      at: sentAt
    })
    return { pingId, sentAt }
  }

  /**
   * 响应活性验证 ping。
   */
  pong(input: { pingId: string }): void {
    const agent = this.currentAgent()
    this.repository.recordLiveness({
      channelId: agent.channelId,
      runId: agent.runId,
      verified: true,
      at: Date.now()
    })
  }

  /**
   * 检查指定通道的活性状态。
   */
  checkLiveness(targetChannelId: string): ChannelLivenessRecord | undefined {
    const agent = this.currentAgent()
    return this.repository.getLiveness(targetChannelId, agent.runId)
  }

  planTasks(inputs: PlanTaskInput[]): ReturnType<TaskAgentService['plan']> {
    const agent = this.currentAgent()
    const members = this.repository.listRunMembers(agent.runId)
    const memberBySlot = new Map(members.map((member) => [member.slotId, member]))
    for (const input of inputs) {
      const required = [...new Set((input.requiredCapabilities ?? []).map((item) => item.trim()).filter(Boolean))]
      if (input.targetSlotId) {
        const target = memberBySlot.get(input.targetSlotId.trim())
        if (!target) {
          throw new TaskPoolError('target_slot_not_found', `指定 AgentSlot 不属于当前 TeamRun：${input.targetSlotId}`)
        }
        const available = new Set(target.capabilities)
        const missing = required.filter((capability) => !available.has(capability))
        if (missing.length) {
          throw new TaskPoolError(
            'target_capability_mismatch',
            `${target.roleName} 不具备能力 ${missing.join('、')}；请从 team_get_context 返回的 capabilities 中选择，或省略 requiredCapabilities`
          )
        }
      } else if (required.length && !members.some((member) => (
        required.every((capability) => member.capabilities.includes(capability))
      ))) {
        throw new TaskPoolError(
          'team_capability_unavailable',
          `当前团队没有成员同时具备能力：${required.join('、')}`
        )
      }
    }
    return this.tasks.plan(inputs)
  }

  private currentAgent(): AuthorizedTeamAgent {
    return this.repository.resolveAuthorizedAgent(this.identity)
  }
}
