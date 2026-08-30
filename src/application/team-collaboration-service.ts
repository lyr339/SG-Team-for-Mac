import { randomUUID } from 'node:crypto'
import type {
  TeamCollaborationSnapshot,
  TeamMessage,
  TeamMessageKind
} from '../domain/team-collaboration'
import { emptyTeamCollaborationSnapshot, sameTeamMessageActor } from '../domain/team-collaboration'
import type { TeamControlSnapshot, TeamRun } from '../domain/team-control'
import type { TeamCollaborationRepository } from './team-collaboration-repository'

export interface TeamCollaborationTeamSource {
  getSnapshot(): TeamControlSnapshot
  subscribe(listener: (snapshot: TeamControlSnapshot) => void): () => void
}

export interface SendOperatorTeamMessageInput {
  recipientSlotId: string
  kind: Exclude<TeamMessageKind, 'response'>
  subject?: string
  content: string
}

type Listener = (snapshot: TeamCollaborationSnapshot) => void

function assertCollaborationWritable(status: TeamRun['status']): void {
  if (status === 'draft' || status === 'ready') throw new Error('本轮团队尚未启动，当前不能发送协作消息')
  if (status === 'completed') throw new Error('本轮团队已经结束，请开始新一轮')
  if (status === 'paused') throw new Error('本轮团队已暂停，当前不能发送协作消息')
}

export class TeamCollaborationService {
  private readonly listeners = new Set<Listener>()
  private readonly unsubscribeTeam: () => void
  private watchTimer?: ReturnType<typeof setInterval>
  private lastRevision: number

  constructor(
    private readonly repository: TeamCollaborationRepository,
    private readonly team: TeamCollaborationTeamSource
  ) {
    this.lastRevision = repository.revision()
    this.unsubscribeTeam = team.subscribe(() => this.emit())
  }

  getSnapshot(): TeamCollaborationSnapshot {
    const runId = this.team.getSnapshot().activeRun?.id
    return runId ? this.repository.loadRun(runId) : emptyTeamCollaborationSnapshot()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  send(input: SendOperatorTeamMessageInput): TeamMessage {
    const team = this.team.getSnapshot()
    const activeRun = team.activeRun
    const runId = activeRun?.id
    if (!runId) throw new Error('当前没有活动 TeamRun')
    assertCollaborationWritable(activeRun.status)
    const recipientSlotId = input.recipientSlotId.trim()
    if (!team.members.some((member) => member.slot.id === recipientSlotId && member.slot.solo !== true)) {
      throw new Error('目标 AgentSlot 不属于当前 TeamRun')
    }
    const message = this.repository.createMessage({
      runId,
      sender: { type: 'operator' },
      recipient: { type: 'agent', slotId: recipientSlotId },
      kind: input.kind,
      subject: input.subject,
      content: input.content,
      clientMessageId: `operator-message:${randomUUID()}`
    })
    this.emit()
    return message
  }

  reply(messageId: string, content: string): TeamMessage {
    const activeRun = this.team.getSnapshot().activeRun
    if (!activeRun) throw new Error('当前没有活动 TeamRun')
    assertCollaborationWritable(activeRun.status)
    const snapshot = this.getSnapshot()
    const original = snapshot.messages[messageId.trim()]
    if (!original || original.recipient.type !== 'operator') {
      throw new Error('只能回复发送给外置控制台的团队消息')
    }
    const operator = { type: 'operator' as const }
    this.repository.acknowledge(original.id, operator)
    const response = this.repository.createMessage({
      runId: original.runId,
      sender: operator,
      recipient: original.sender,
      kind: 'response',
      content,
      clientMessageId: `operator-response:${randomUUID()}`,
      threadId: original.threadId,
      replyToMessageId: original.id
    })
    this.emit()
    return response
  }

  markRead(messageId: string): TeamMessage {
    const snapshot = this.getSnapshot()
    const message = snapshot.messages[messageId.trim()]
    const operator = { type: 'operator' as const }
    if (!message || !sameTeamMessageActor(message.recipient, operator)) {
      throw new Error('这条消息不是发给外置控制台的')
    }
    const updated = this.repository.markRead(message.id, operator)
    this.emit()
    return updated
  }

  startWatcher(intervalMs = 750): void {
    this.stopWatcher()
    this.watchTimer = setInterval(() => {
      const revision = this.repository.revision()
      if (revision !== this.lastRevision) this.emit()
    }, Math.max(250, intervalMs))
    this.watchTimer.unref?.()
  }

  stopWatcher(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = undefined
  }

  dispose(): void {
    this.stopWatcher()
    this.unsubscribeTeam()
    this.listeners.clear()
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    this.lastRevision = snapshot.revision
    for (const listener of this.listeners) listener(snapshot)
  }
}
