import { numberOf, type SqliteRow } from '../sqlite/rows'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TeamCollaborationRepository } from '../../application/team-collaboration-repository'
import type {
  AuthorizedTeamAgent,
  ChannelLivenessRecord,
  CreateTeamMessageInput,
  TeamAgentRuntimeIdentity,
  TeamCollaborationEvent,
  TeamCollaborationSnapshot,
  TeamMessage,
  TeamMessageActor,
  TeamMessageKind,
  TeamMessageNotificationState,
  TeamMessageThread,
  TeamMemberDirectoryEntry
} from '../../domain/team-collaboration'
import { sameTeamMessageActor } from '../../domain/team-collaboration'
import { TaskPoolError } from '../../domain/task-pool'
import type { AssignedAgentSkill } from '../../domain/agent-skill'
import { assertAgentRegistrationAuthorized } from '../sqlite/agent-registrations'

const SCHEMA_VERSION = 2
const EVENT_LIMIT = 2_000
const MESSAGE_KINDS = new Set<TeamMessageKind>([
  'directive',
  'question',
  'response',
  'status',
  'notice'
])
const NOTIFICATION_RESULTS = new Set<TeamMessageNotificationState>([
  'notified',
  'uncertain',
  'failed'
])
const CLIENT_MESSAGE_ID = /^[a-zA-Z0-9:_-]{8,200}$/

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : numberOf(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function assignedSkillsOf(value: unknown): AssignedAgentSkill[] {
  if (typeof value !== 'string' || !value) return []
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is AssignedAgentSkill => Boolean(
    item && typeof item === 'object'
    && typeof (item as AssignedAgentSkill).id === 'string'
    && typeof (item as AssignedAgentSkill).name === 'string'
  ))
}

function stringArrayOf(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  const parsed = JSON.parse(value)
  return Array.isArray(parsed)
    ? [...new Set(parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))]
    : []
}

function actorKey(actor: TeamMessageActor): string {
  return actor.type === 'operator' ? 'operator' : `agent:${actor.slotId}`
}

function actorOf(value: unknown): TeamMessageActor {
  const key = String(value ?? '')
  if (key === 'operator') return { type: 'operator' }
  if (key.startsWith('agent:') && key.length > 6) return { type: 'agent', slotId: key.slice(6) }
  throw new Error(`团队消息包含无效 Actor：${key}`)
}

function normalizedText(value: string, field: string, maxLength: number): string {
  const text = value.replace(/\r\n/g, '\n').trim()
  if (!text) throw new Error(`${field}不能为空`)
  if (text.length > maxLength) throw new Error(`${field}不能超过 ${maxLength} 个字符`)
  return text
}

function messageFromRows(message: SqliteRow, receipt: Record<string, unknown>): TeamMessage {
  return {
    id: String(message.id),
    runId: String(message.run_id),
    threadId: String(message.thread_id),
    sender: actorOf(message.sender_key),
    recipient: actorOf(message.recipient_key),
    kind: String(message.kind) as TeamMessageKind,
    content: String(message.content),
    replyToMessageId: optionalString(message.reply_to_message_id),
    clientMessageId: String(message.client_message_id),
    createdAt: numberOf(message.created_at),
    receipt: {
      notificationState: String(receipt.notification_state) as TeamMessageNotificationState,
      notificationCommandId: optionalString(receipt.notification_command_id),
      notificationDetail: String(receipt.notification_detail),
      notifiedAt: optionalNumber(receipt.notified_at),
      readAt: optionalNumber(receipt.read_at),
      acknowledgedAt: optionalNumber(receipt.acknowledged_at),
      respondedAt: optionalNumber(receipt.responded_at),
      responseMessageId: optionalString(receipt.response_message_id),
      updatedAt: numberOf(receipt.updated_at)
    }
  }
}

export class SqliteTeamCollaborationRepository implements TeamCollaborationRepository {
  private readonly database: DatabaseSync

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path, { timeout: 5_000, defensive: true })
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA synchronous = NORMAL')
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  revision(): number {
    const row = this.database.prepare(
      'SELECT revision FROM team_collaboration_meta WHERE id = 1'
    ).get() as SqliteRow
    return numberOf(row.revision)
  }

  loadRun(runId: string): TeamCollaborationSnapshot {
    const normalizedRunId = runId.trim()
    const meta = this.database.prepare(
      'SELECT revision, seq, updated_at FROM team_collaboration_meta WHERE id = 1'
    ).get() as SqliteRow
    const threads = (this.database.prepare(`
      SELECT * FROM team_message_threads WHERE run_id = ? ORDER BY updated_at DESC, id ASC
    `).all(normalizedRunId) as SqliteRow[]).map((row): TeamMessageThread => ({
      id: String(row.id),
      runId: String(row.run_id),
      subject: String(row.subject),
      createdAt: numberOf(row.created_at),
      updatedAt: numberOf(row.updated_at)
    }))
    const rows = this.database.prepare(`
      SELECT m.*, r.notification_state, r.notification_command_id,
        r.notification_detail, r.notified_at, r.read_at, r.acknowledged_at,
        r.responded_at, r.response_message_id, r.updated_at AS receipt_updated_at
      FROM team_messages m
      JOIN team_message_receipts r ON r.message_id = m.id
      WHERE m.run_id = ?
      ORDER BY m.created_at ASC, m.id ASC
    `).all(normalizedRunId) as SqliteRow[]
    const messages: Record<string, TeamMessage> = {}
    const messageOrder: string[] = []
    for (const row of rows) {
      const message = messageFromRows(row, {
        notification_state: row.notification_state,
        notification_command_id: row.notification_command_id,
        notification_detail: row.notification_detail,
        notified_at: row.notified_at,
        read_at: row.read_at,
        acknowledged_at: row.acknowledged_at,
        responded_at: row.responded_at,
        response_message_id: row.response_message_id,
        updated_at: row.receipt_updated_at
      })
      messages[message.id] = message
      messageOrder.push(message.id)
    }
    const events = (this.database.prepare(`
      SELECT * FROM team_collaboration_events
      WHERE run_id = ? ORDER BY seq DESC LIMIT 500
    `).all(normalizedRunId) as SqliteRow[]).reverse().map((row): TeamCollaborationEvent => ({
      seq: numberOf(row.seq),
      type: String(row.event_type),
      runId: String(row.run_id),
      threadId: optionalString(row.thread_id),
      messageId: optionalString(row.message_id),
      actor: actorOf(row.actor_key),
      detail: optionalString(row.detail),
      at: numberOf(row.created_at)
    }))
    return {
      schemaVersion: 1,
      revision: numberOf(meta.revision),
      seq: numberOf(meta.seq),
      runId: normalizedRunId,
      threads,
      messages,
      messageOrder,
      events,
      updatedAt: numberOf(meta.updated_at)
    }
  }

  resolveAuthorizedAgent(identity: TeamAgentRuntimeIdentity): AuthorizedTeamAgent {
    assertAgentRegistrationAuthorized(this.database, identity)
    const row = this.database.prepare(`
      SELECT b.workspace_id, b.slot_id, b.channel_id, r.role_key, r.template_key,
        r.name AS role_name, r.skills_json, tr.acting_lead_slot_id
      FROM runtime_bindings b
      JOIN agent_slots s ON s.id = b.slot_id
      JOIN team_roles r ON r.id = s.role_id
      JOIN team_runs tr ON tr.id = b.run_id
      WHERE b.agent_session_id = ? AND b.run_id = ? AND b.slot_id = ?
    `).get(identity.agentSessionId, identity.runId, identity.slotId) as SqliteRow | undefined
    if (!row) {
      throw new TaskPoolError(
        'agent_slot_mismatch',
        '当前 AgentSlot 与已注册 RuntimeBinding 不一致'
      )
    }
    const slotId = String(row.slot_id)
    const actingLeadSlotId = optionalString(row.acting_lead_slot_id)
    const roleTemplateKey = String(row.template_key)
    return {
      agentSessionId: identity.agentSessionId,
      workspaceId: String(row.workspace_id),
      runId: identity.runId,
      slotId,
      channelId: String(row.channel_id),
      roleKey: String(row.role_key),
      roleTemplateKey,
      roleName: String(row.role_name),
      capabilities: [...identity.capabilities],
      skills: assignedSkillsOf(row.skills_json),
      isActingLead: actingLeadSlotId === slotId,
      isEffectiveLead: actingLeadSlotId ? actingLeadSlotId === slotId : roleTemplateKey === 'lead'
    }
  }

  listRunMembers(runId: string): TeamMemberDirectoryEntry[] {
    return (this.database.prepare(`
      SELECT s.id AS slot_id, r.role_key, r.template_key, r.name AS role_name,
        r.capabilities_json, r.skills_json, b.channel_id, tr.acting_lead_slot_id
      FROM agent_slots s
      JOIN team_roles r ON r.id = s.role_id
      JOIN team_runs tr ON tr.id = s.run_id
      LEFT JOIN runtime_bindings b ON b.slot_id = s.id AND b.run_id = s.run_id
      WHERE s.run_id = ?
      ORDER BY s.slot_order ASC, s.id ASC
    `).all(runId.trim()) as SqliteRow[]).map((row) => {
      const slotId = String(row.slot_id)
      const actingLeadSlotId = optionalString(row.acting_lead_slot_id)
      const roleTemplateKey = String(row.template_key)
      return {
        slotId,
        roleKey: String(row.role_key),
        roleTemplateKey,
        roleName: String(row.role_name),
        channelId: optionalString(row.channel_id),
        capabilities: stringArrayOf(row.capabilities_json),
        skills: assignedSkillsOf(row.skills_json),
        isEffectiveLead: actingLeadSlotId ? actingLeadSlotId === slotId : roleTemplateKey === 'lead'
      }
    })
  }

  clearRun(runId: string, at = Date.now()): boolean {
    const normalizedRunId = normalizedText(runId, 'runId', 200)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        DELETE FROM team_message_receipts
        WHERE message_id IN (SELECT id FROM team_messages WHERE run_id = ?)
      `).run(normalizedRunId)
      this.database.prepare(`
        UPDATE team_messages SET reply_to_message_id = NULL WHERE run_id = ?
      `).run(normalizedRunId)
      const messages = this.database.prepare(`
        DELETE FROM team_messages WHERE run_id = ?
      `).run(normalizedRunId)
      const threads = this.database.prepare(`
        DELETE FROM team_message_threads WHERE run_id = ?
      `).run(normalizedRunId)
      const events = this.database.prepare(`
        DELETE FROM team_collaboration_events WHERE run_id = ?
      `).run(normalizedRunId)
      const liveness = this.database.prepare(`
        DELETE FROM channel_liveness WHERE run_id = ?
      `).run(normalizedRunId)
      const changed = numberOf(messages.changes)
        + numberOf(threads.changes)
        + numberOf(events.changes)
        + numberOf(liveness.changes) > 0
      if (changed) {
        this.database.prepare(`
          UPDATE team_collaboration_meta
          SET revision = revision + 1, updated_at = ? WHERE id = 1
        `).run(at)
      }
      this.database.exec('COMMIT')
      return changed
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  createMessage(input: CreateTeamMessageInput): TeamMessage {
    const runId = normalizedText(input.runId, 'runId', 200)
    const content = normalizedText(input.content, '消息正文', 20_000)
    const clientMessageId = input.clientMessageId.trim()
    if (!CLIENT_MESSAGE_ID.test(clientMessageId)) throw new Error('clientMessageId 无效')
    if (!MESSAGE_KINDS.has(input.kind)) throw new Error('消息类型无效')
    this.assertActorInRun(runId, input.sender)
    this.assertActorInRun(runId, input.recipient)
    if (sameTeamMessageActor(input.sender, input.recipient)) throw new Error('不能给自己发送团队消息')

    const duplicate = this.findIdempotentMessage(runId, input.sender, clientMessageId)
    if (duplicate) return duplicate

    const now = Date.now()
    const messageId = `team-message:${randomUUID()}`
    this.database.exec('BEGIN IMMEDIATE')
    try {
      let threadId = input.threadId?.trim()
      let replyTo: TeamMessage | undefined
      if (input.replyToMessageId?.trim()) {
        replyTo = this.messageById(input.replyToMessageId.trim())
        if (!replyTo || replyTo.runId !== runId) throw new Error('回复的原消息不存在')
        if (!sameTeamMessageActor(input.sender, replyTo.recipient)
          || !sameTeamMessageActor(input.recipient, replyTo.sender)) {
          throw new Error('回复双方必须与原消息严格对应')
        }
        if (threadId && threadId !== replyTo.threadId) throw new Error('回复不能切换到其他会话线程')
        threadId = replyTo.threadId
      }

      if (threadId) {
        const thread = this.database.prepare(
          'SELECT run_id FROM team_message_threads WHERE id = ?'
        ).get(threadId) as SqliteRow | undefined
        if (!thread || String(thread.run_id) !== runId) throw new Error('团队消息线程不存在')
      } else {
        threadId = `team-thread:${randomUUID()}`
        const subject = normalizedText(
          input.subject?.trim() || content.split('\n')[0]!.slice(0, 120),
          '会话主题',
          160
        )
        this.database.prepare(`
          INSERT INTO team_message_threads (id, run_id, subject, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(threadId, runId, subject, now, now)
      }

      this.database.prepare(`
        INSERT INTO team_messages (
          id, run_id, thread_id, sender_key, recipient_key, kind, content,
          reply_to_message_id, client_message_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        messageId,
        runId,
        threadId,
        actorKey(input.sender),
        actorKey(input.recipient),
        input.kind,
        content,
        replyTo?.id ?? null,
        clientMessageId,
        now
      )
      const operatorRecipient = input.recipient.type === 'operator'
      this.database.prepare(`
        INSERT INTO team_message_receipts (
          message_id, notification_state, notification_command_id,
          notification_detail, notified_at, read_at, acknowledged_at,
          responded_at, response_message_id, updated_at
        ) VALUES (?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, ?)
      `).run(
        messageId,
        operatorRecipient ? 'not_required' : 'queued',
        operatorRecipient ? '外置软件已持久化接收' : '等待通知目标 Agent',
        operatorRecipient ? now : null,
        now
      )
      this.database.prepare(
        'UPDATE team_message_threads SET updated_at = ? WHERE id = ?'
      ).run(now, threadId)

      if (replyTo) {
        this.database.prepare(`
          UPDATE team_message_receipts
          SET read_at = COALESCE(read_at, ?),
              acknowledged_at = COALESCE(acknowledged_at, ?),
              responded_at = COALESCE(responded_at, ?),
              response_message_id = COALESCE(response_message_id, ?),
              updated_at = ?
          WHERE message_id = ?
        `).run(now, now, now, messageId, now, replyTo.id)
        this.appendEvent({
          type: 'message.responded',
          runId,
          threadId,
          messageId: replyTo.id,
          actor: input.sender,
          detail: messageId,
          at: now
        })
      }
      this.appendEvent({
        type: 'message.created',
        runId,
        threadId,
        messageId,
        actor: input.sender,
        detail: input.kind,
        at: now
      })
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      const racedDuplicate = this.findIdempotentMessage(runId, input.sender, clientMessageId)
      if (racedDuplicate) return racedDuplicate
      throw error
    }
    return this.messageById(messageId)!
  }

  markNotificationSending(messageId: string, commandId: string, detail = '正在通知目标 Agent', at = Date.now()): TeamMessage {
    const message = this.requireMessage(messageId)
    if (message.recipient.type !== 'agent') return message
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.database.prepare(`
        UPDATE team_message_receipts
        SET notification_state = 'sending', notification_command_id = ?,
            notification_detail = ?, updated_at = ?
        WHERE message_id = ? AND notification_state = 'queued' AND read_at IS NULL
      `).run(commandId.trim(), detail.trim().slice(0, 2_000), at, message.id)
      if (numberOf(result.changes) > 0) {
        this.appendEvent({
          type: 'message.notification_sending',
          runId: message.runId,
          threadId: message.threadId,
          messageId: message.id,
          actor: { type: 'operator' },
          detail: commandId,
          at
        })
      }
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
    return this.requireMessage(message.id)
  }

  markNotificationResult(
    messageId: string,
    result: 'notified' | 'uncertain' | 'failed',
    detail: string,
    at = Date.now()
  ): TeamMessage {
    if (!NOTIFICATION_RESULTS.has(result)) throw new Error('通知结果无效')
    const message = this.requireMessage(messageId)
    if (message.recipient.type !== 'agent') return message
    if (message.receipt.notificationState === 'notified' && result !== 'notified') return message
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const updated = this.database.prepare(`
        UPDATE team_message_receipts
        SET notification_state = ?, notification_detail = ?,
            notified_at = CASE WHEN ? = 'notified' THEN COALESCE(notified_at, ?) ELSE notified_at END,
            updated_at = ?
        WHERE message_id = ?
      `).run(result, detail.trim().slice(0, 2_000), result, at, at, message.id)
      if (numberOf(updated.changes) > 0) {
        this.appendEvent({
          type: `message.notification_${result}`,
          runId: message.runId,
          threadId: message.threadId,
          messageId: message.id,
          actor: { type: 'operator' },
          detail,
          at
        })
      }
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
    return this.requireMessage(message.id)
  }

  markRead(messageId: string, recipient: TeamMessageActor, at = Date.now()): TeamMessage {
    return this.advanceReceipt(messageId, recipient, 'read', at)
  }

  acknowledge(messageId: string, recipient: TeamMessageActor, at = Date.now()): TeamMessage {
    return this.advanceReceipt(messageId, recipient, 'acknowledged', at)
  }

  listPendingNotifications(runId?: string, limit = 25): TeamMessage[] {
    const normalizedLimit = Math.min(100, Math.max(1, Math.floor(limit)))
    const rows = runId?.trim()
      ? this.database.prepare(`
          SELECT m.id FROM team_messages m
          JOIN team_message_receipts r ON r.message_id = m.id
          WHERE m.run_id = ? AND m.recipient_key LIKE 'agent:%'
            AND r.notification_state = 'queued' AND r.read_at IS NULL
          ORDER BY m.created_at ASC, m.id ASC LIMIT ?
        `).all(runId.trim(), normalizedLimit) as SqliteRow[]
      : this.database.prepare(`
          SELECT m.id FROM team_messages m
          JOIN team_message_receipts r ON r.message_id = m.id
          WHERE m.recipient_key LIKE 'agent:%'
            AND r.notification_state = 'queued' AND r.read_at IS NULL
          ORDER BY m.created_at ASC, m.id ASC LIMIT ?
        `).all(normalizedLimit) as SqliteRow[]
    return rows.map((row) => this.requireMessage(String(row.id)))
  }

  recoverStaleSending(beforeAt: number): number {
    const rows = this.database.prepare(`
      SELECT m.id FROM team_messages m
      JOIN team_message_receipts r ON r.message_id = m.id
      WHERE r.notification_state = 'sending' AND r.updated_at <= ?
      ORDER BY r.updated_at ASC
    `).all(beforeAt) as SqliteRow[]
    if (!rows.length) return 0
    const recoveredAt = Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const message = this.requireMessage(String(row.id))
        this.database.prepare(`
          UPDATE team_message_receipts
          SET notification_state = 'uncertain',
              notification_detail = '外置软件重启前未收到最终投递回执；未自动重发',
              updated_at = ?
          WHERE message_id = ? AND notification_state = 'sending'
        `).run(recoveredAt, message.id)
        this.appendEvent({
          type: 'message.notification_uncertain',
          runId: message.runId,
          threadId: message.threadId,
          messageId: message.id,
          actor: { type: 'operator' },
          detail: 'recovered_stale_sending',
          at: recoveredAt
        })
      }
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
    return rows.length
  }

  recordLiveness(input: { channelId: string; runId: string; verified: boolean; at: number }): void {
    const existing = this.getLiveness(input.channelId, input.runId)
    const consecutiveFailures = input.verified
      ? 0
      : (existing?.consecutiveFailures ?? 0) + 1
    const liveness = input.verified
      ? 'active'
      : consecutiveFailures >= 3
        ? 'confirmed_offline'
        : 'suspected_offline'
    this.database.prepare(`
      INSERT INTO channel_liveness (
        channel_id, run_id, liveness, last_verified_at, consecutive_failures,
        last_ping_at, last_pong_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id, run_id) DO UPDATE SET
        liveness = excluded.liveness,
        last_verified_at = excluded.last_verified_at,
        consecutive_failures = excluded.consecutive_failures,
        last_ping_at = excluded.last_ping_at,
        last_pong_at = excluded.last_pong_at,
        updated_at = excluded.updated_at
    `).run(
      input.channelId,
      input.runId,
      liveness,
      input.verified ? input.at : existing?.lastVerifiedAt ?? input.at,
      consecutiveFailures,
      input.at,
      input.verified ? input.at : existing?.lastPongAt ?? null,
      input.at
    )
  }

  getLiveness(channelId: string, runId: string): ChannelLivenessRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM channel_liveness WHERE channel_id = ? AND run_id = ?
    `).get(channelId, runId) as SqliteRow | undefined
    if (!row) return undefined
    return {
      channelId: String(row.channel_id),
      liveness: String(row.liveness) as ChannelLivenessRecord['liveness'],
      lastVerifiedAt: numberOf(row.last_verified_at),
      consecutiveFailures: numberOf(row.consecutive_failures),
      lastPingAt: optionalNumber(row.last_ping_at),
      lastPongAt: optionalNumber(row.last_pong_at)
    }
  }

  listLiveness(runId: string): ChannelLivenessRecord[] {
    return (this.database.prepare(`
      SELECT * FROM channel_liveness WHERE run_id = ? ORDER BY updated_at DESC
    `).all(runId) as SqliteRow[]).map((row) => ({
      channelId: String(row.channel_id),
      liveness: String(row.liveness) as ChannelLivenessRecord['liveness'],
      lastVerifiedAt: numberOf(row.last_verified_at),
      consecutiveFailures: numberOf(row.consecutive_failures),
      lastPingAt: optionalNumber(row.last_ping_at),
      lastPongAt: optionalNumber(row.last_pong_at)
    }))
  }

  close(): void {
    if (this.database.isOpen) this.database.close()
  }

  private advanceReceipt(
    messageId: string,
    recipient: TeamMessageActor,
    stage: 'read' | 'acknowledged',
    at: number
  ): TeamMessage {
    const message = this.requireMessage(messageId)
    if (!sameTeamMessageActor(message.recipient, recipient)) {
      throw new TaskPoolError('message_recipient_mismatch', '只有消息接收者可以推进回执')
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const sql = stage === 'read'
        ? `UPDATE team_message_receipts
           SET read_at = COALESCE(read_at, ?), updated_at = ?
           WHERE message_id = ? AND read_at IS NULL`
        : `UPDATE team_message_receipts
           SET read_at = COALESCE(read_at, ?),
               acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ?
           WHERE message_id = ? AND acknowledged_at IS NULL`
      const result = stage === 'read'
        ? this.database.prepare(sql).run(at, at, message.id)
        : this.database.prepare(sql).run(at, at, at, message.id)
      if (numberOf(result.changes) > 0) {
        this.appendEvent({
          type: `message.${stage}`,
          runId: message.runId,
          threadId: message.threadId,
          messageId: message.id,
          actor: recipient,
          at
        })
      }
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
    return this.requireMessage(message.id)
  }

  private findIdempotentMessage(
    runId: string,
    sender: TeamMessageActor,
    clientMessageId: string
  ): TeamMessage | undefined {
    const row = this.database.prepare(`
      SELECT id FROM team_messages
      WHERE run_id = ? AND sender_key = ? AND client_message_id = ?
    `).get(runId, actorKey(sender), clientMessageId) as SqliteRow | undefined
    return row ? this.requireMessage(String(row.id)) : undefined
  }

  private messageById(messageId: string): TeamMessage | undefined {
    const row = this.database.prepare('SELECT * FROM team_messages WHERE id = ?').get(messageId) as SqliteRow | undefined
    if (!row) return undefined
    const receipt = this.database.prepare(
      'SELECT * FROM team_message_receipts WHERE message_id = ?'
    ).get(messageId) as SqliteRow | undefined
    if (!receipt) throw new Error(`消息 ${messageId} 缺少回执行`)
    return messageFromRows(row, receipt)
  }

  private requireMessage(messageId: string): TeamMessage {
    const normalizedId = messageId.trim()
    if (!normalizedId || normalizedId.length > 240) throw new Error('messageId 无效')
    const message = this.messageById(normalizedId)
    if (!message) throw new TaskPoolError('message_not_found', '团队消息不存在')
    return message
  }

  private assertActorInRun(runId: string, actor: TeamMessageActor): void {
    const run = this.database.prepare('SELECT id FROM team_runs WHERE id = ?').get(runId)
    if (!run) throw new Error('TeamRun 不存在')
    if (actor.type === 'operator') return
    const row = this.database.prepare(
      'SELECT id FROM agent_slots WHERE id = ? AND run_id = ?'
    ).get(actor.slotId.trim(), runId)
    if (!row) throw new Error('AgentSlot 不属于当前 TeamRun')
  }

  private appendEvent(input: {
    type: string
    runId: string
    threadId?: string
    messageId?: string
    actor: TeamMessageActor
    detail?: string
    at: number
  }): void {
    const meta = this.database.prepare(
      'SELECT seq FROM team_collaboration_meta WHERE id = 1'
    ).get() as SqliteRow
    const seq = numberOf(meta.seq) + 1
    this.database.prepare(`
      INSERT INTO team_collaboration_events (
        seq, event_type, run_id, thread_id, message_id, actor_key, detail, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      seq,
      input.type,
      input.runId,
      input.threadId ?? null,
      input.messageId ?? null,
      actorKey(input.actor),
      input.detail?.trim().slice(0, 2_000) ?? null,
      input.at
    )
    this.database.prepare(`
      UPDATE team_collaboration_meta
      SET revision = revision + 1, seq = ?, updated_at = ? WHERE id = 1
    `).run(seq, input.at)
    this.database.prepare(`
      DELETE FROM team_collaboration_events
      WHERE seq <= (SELECT MAX(seq) - ? FROM team_collaboration_events)
    `).run(EVENT_LIMIT)
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS team_collaboration_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_message_threads (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES team_message_threads(id) ON DELETE CASCADE,
        sender_key TEXT NOT NULL,
        recipient_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        reply_to_message_id TEXT REFERENCES team_messages(id) ON DELETE RESTRICT,
        client_message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (run_id, sender_key, client_message_id)
      );

      CREATE TABLE IF NOT EXISTS team_message_receipts (
        message_id TEXT PRIMARY KEY REFERENCES team_messages(id) ON DELETE CASCADE,
        notification_state TEXT NOT NULL,
        notification_command_id TEXT,
        notification_detail TEXT NOT NULL,
        notified_at INTEGER,
        read_at INTEGER,
        acknowledged_at INTEGER,
        responded_at INTEGER,
        response_message_id TEXT REFERENCES team_messages(id) ON DELETE SET NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_collaboration_events (
        seq INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL,
        run_id TEXT NOT NULL,
        thread_id TEXT,
        message_id TEXT,
        actor_key TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_liveness (
        channel_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        liveness TEXT NOT NULL,
        last_verified_at INTEGER NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_ping_at INTEGER,
        last_pong_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_team_threads_run_updated
      ON team_message_threads(run_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_team_messages_run_created
      ON team_messages(run_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_team_messages_recipient
      ON team_messages(run_id, recipient_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_team_receipts_notification
      ON team_message_receipts(notification_state, read_at, updated_at);
      CREATE INDEX IF NOT EXISTS idx_team_collaboration_events_run
      ON team_collaboration_events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_channel_liveness_run
      ON channel_liveness(run_id, updated_at DESC);

      INSERT OR IGNORE INTO team_collaboration_meta (
        id, schema_version, revision, seq, updated_at
      ) VALUES (1, ${SCHEMA_VERSION}, 0, 0, 0);
    `)
    const meta = this.database.prepare(
      'SELECT schema_version FROM team_collaboration_meta WHERE id = 1'
    ).get() as SqliteRow
    const version = numberOf(meta.schema_version)
    if (version === 1) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS channel_liveness (
            channel_id TEXT NOT NULL,
            run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
            liveness TEXT NOT NULL,
            last_verified_at INTEGER NOT NULL,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            last_ping_at INTEGER,
            last_pong_at INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (channel_id, run_id)
          );
          CREATE INDEX IF NOT EXISTS idx_channel_liveness_run
          ON channel_liveness(run_id, updated_at DESC);
        `)
        this.database.prepare(
          'UPDATE team_collaboration_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(SCHEMA_VERSION, Date.now())
        this.database.exec('COMMIT')
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    } else if (version !== SCHEMA_VERSION) {
      throw new Error(`团队协作数据库版本不兼容：${version}，当前支持 ${SCHEMA_VERSION}`)
    }
  }
}
