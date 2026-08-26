import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  CHANNEL_OUTBOX_MAX_PENDING,
  CHANNEL_OUTBOUND_DEDUPE_WINDOW_MS,
  CHANNEL_PROCESS_EVENTS_ARCHIVED_TTL_MS,
  CHANNEL_PROCESS_EVENTS_MAX_PENDING,
  CHANNEL_REPLY_DEDUPE_WINDOW_MS,
  type ChannelInboundReply,
  type ChannelOutboundMessage,
  type ChannelPresence,
  type ChannelProcessEvent
} from '../../domain/channel-message'
import type { MessageAttachment, ProcessBlock } from '../../domain/conversation-entry'

type SqliteRow = Record<string, string | number | bigint | null>

function numberOf(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function stringArrayOf(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed)) return []
  return parsed.map(String).filter(Boolean)
}

/** process_json 解析：异常/非数组一律视为无过程，绝不让历史脏数据拖垮读取链路。 */
function processBlocksOf(value: unknown): ProcessBlock[] | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length ? parsed as ProcessBlock[] : undefined
  } catch {
    return undefined
  }
}

/** 单块过程事件 payload 解析（容错同上）。 */
function processBlockOf(value: unknown): ProcessBlock | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as ProcessBlock : undefined
  } catch {
    return undefined
  }
}

function processEventOf(row: SqliteRow): ChannelProcessEvent | undefined {
  const block = processBlockOf(row.payload_json)
  if (!block) return undefined
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    turn: String(row.turn),
    blockId: String(row.block_id),
    seq: numberOf(row.seq),
    block,
    createdAt: numberOf(row.created_at),
    updatedAt: numberOf(row.updated_at),
    archived: numberOf(row.archived) === 1
  }
}

/** attachments_json 解析：异常/非数组一律视为无附件（与 process_json 同一容错原则）。 */
function attachmentsOf(value: unknown): MessageAttachment[] | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length ? parsed as MessageAttachment[] : undefined
  } catch {
    return undefined
  }
}

function canonicalReplyContent(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function outboundOf(row: SqliteRow): ChannelOutboundMessage {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    seq: numberOf(row.seq),
    text: String(row.text),
    attachments: attachmentsOf(row.attachments_json),
    createdAt: numberOf(row.created_at),
    deliveredAt: row.delivered_at === null ? undefined : numberOf(row.delivered_at),
    silent: numberOf(row.silent) === 1 ? true : undefined
  }
}

function replyOf(row: SqliteRow): ChannelInboundReply {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    content: String(row.content),
    title: optionalString(row.title),
    groupId: optionalString(row.group_id),
    taskId: optionalString(row.task_id),
    files: stringArrayOf(row.files_json),
    process: processBlocksOf(row.process_json),
    turn: optionalString(row.turn),
    createdAt: numberOf(row.created_at),
    consumedAt: row.consumed_at === null ? undefined : numberOf(row.consumed_at)
  }
}

function presenceOf(row: SqliteRow): ChannelPresence {
  return {
    channelId: String(row.channel_id),
    lastSeenAt: numberOf(row.last_seen_at),
    waiting: numberOf(row.waiting) === 1,
    connectionPhase: String(row.connection_phase),
    turnCount: numberOf(row.turn_count),
    deliveredCount: numberOf(row.delivered_count),
    keepaliveRound: numberOf(row.keepalive_round),
    pendingReplySyncSince: row.pending_reply_sync_since === null
      ? undefined
      : numberOf(row.pending_reply_sync_since),
    pendingGroupChat: numberOf(row.pending_group_chat) === 1,
    pendingGroupId: optionalString(row.pending_group_id),
    updatedAt: numberOf(row.updated_at)
  }
}

export interface RecordReplyInput {
  channelId: string
  content: string
  title?: string
  groupId?: string
  taskId?: string
  files?: string[]
  /** 过程区块（record_reply process 契约 v1）；缺省表示本轮无过程归档。 */
  process?: ProcessBlock[]
  /** 流式过程回合标识：落地时把该 turn 的过程事件整批归档（archived=1）。 */
  turn?: string
}

export interface PresencePatch {
  lastSeenAt?: number
  waiting?: boolean
  connectionPhase?: string
  turnCount?: number
  deliveredCount?: number
  keepaliveRound?: number
  /** 传入 number 设置守门，传入 null 清除守门；不传保持不变。 */
  pendingReplySyncSince?: number | null
  pendingGroupChat?: boolean
  pendingGroupId?: string | null
}

/**
 * 通道消息队列 SQLite 仓库。与任务池共用同一数据库文件（WAL），
 * 群枢主进程与内嵌 MCP server 进程通过该库交换消息，不引入额外 IPC。
 */
export class SqliteChannelMessageRepository {
  private readonly database: DatabaseSync

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path, { timeout: 5_000, defensive: true })
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA synchronous = NORMAL')
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  /** 用户 → Agent：入队一条出站消息（可携带附件），返回分配的消息（含通道内单调 seq）。 */
  enqueueOutbound(
    channelId: string,
    text: string,
    now = Date.now(),
    attachments?: MessageAttachment[],
    silent = false
  ): ChannelOutboundMessage {
    const normalizedChannel = String(channelId).trim()
    if (!/^\d+$/.test(normalizedChannel)) throw new Error(`通道号无效：${channelId}`)
    const normalizedText = String(text ?? '').trim()
    // 纯附件消息合法：文本或附件至少其一
    if (!normalizedText && !attachments?.length) throw new Error('消息不能为空')

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const duplicate = attachments?.length
        ? undefined
        : this.findRecentDuplicateOutbound(
          normalizedChannel,
          normalizedText,
          silent,
          now
        )
      if (duplicate) {
        this.database.exec('COMMIT')
        return duplicate
      }
      const depth = this.database.prepare(
        'SELECT COUNT(*) AS count FROM channel_outbox WHERE channel_id = ? AND delivered_at IS NULL'
      ).get(normalizedChannel) as SqliteRow
      if (numberOf(depth.count) >= CHANNEL_OUTBOX_MAX_PENDING) {
        throw new Error(`CH-${normalizedChannel} 待投递消息已达上限，请等待 Agent 消费`)
      }
      const last = this.database.prepare(
        'SELECT MAX(seq) AS seq FROM channel_outbox WHERE channel_id = ?'
      ).get(normalizedChannel) as SqliteRow
      const message: ChannelOutboundMessage = {
        id: randomUUID(),
        channelId: normalizedChannel,
        seq: numberOf(last.seq) + 1,
        text: normalizedText,
        attachments: attachments?.length ? attachments : undefined,
        createdAt: now,
        silent: silent ? true : undefined
      }
      this.database.prepare(
        'INSERT INTO channel_outbox (id, channel_id, seq, text, attachments_json, created_at, silent) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        message.id,
        message.channelId,
        message.seq,
        message.text,
        message.attachments ? JSON.stringify(message.attachments) : null,
        message.createdAt,
        message.silent ? 1 : 0
      )
      this.database.exec('COMMIT')
      return message
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** 查重：仅纯文本出站消息参与；附件消息必须逐条保留。 */
  private findRecentDuplicateOutbound(
    channelId: string,
    text: string,
    silent: boolean,
    now: number
  ): ChannelOutboundMessage | undefined {
    const row = this.database.prepare(`
      SELECT * FROM channel_outbox
      WHERE channel_id = ?
        AND text = ?
        AND attachments_json IS NULL
        AND silent = ?
        AND created_at > ?
      ORDER BY created_at DESC, seq DESC
      LIMIT 1
    `).get(
      channelId,
      text,
      silent ? 1 : 0,
      now - CHANNEL_OUTBOUND_DEDUPE_WINDOW_MS
    ) as SqliteRow | undefined
    return row ? outboundOf(row) : undefined
  }

  /** Agent 侧：按 seq 升序读取通道待投递消息。 */
  listPendingOutbound(channelId: string): ChannelOutboundMessage[] {
    const rows = this.database.prepare(
      'SELECT * FROM channel_outbox WHERE channel_id = ? AND delivered_at IS NULL ORDER BY seq ASC'
    ).all(String(channelId).trim()) as SqliteRow[]
    return rows.map(outboundOf)
  }

  /** Agent 侧：标记消息已投递（取出即标记，保证最多一次投递）。 */
  markOutboundDelivered(ids: string[], now = Date.now()): void {
    if (!ids.length) return
    const statement = this.database.prepare(
      'UPDATE channel_outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL'
    )
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids) statement.run(now, id)
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** 读取通道最后一次已投递消息，用于恢复旧版本错误留下的 reply-sync 守门。 */
  latestDeliveredOutbound(channelId: string): ChannelOutboundMessage | undefined {
    const row = this.database.prepare(`
      SELECT * FROM channel_outbox
      WHERE channel_id = ? AND delivered_at IS NOT NULL
      ORDER BY delivered_at DESC, seq DESC
      LIMIT 1
    `).get(String(channelId).trim()) as SqliteRow | undefined
    return row ? outboundOf(row) : undefined
  }

  countPendingOutbound(channelId: string): number {
    const row = this.database.prepare(
      'SELECT COUNT(*) AS count FROM channel_outbox WHERE channel_id = ? AND delivered_at IS NULL'
    ).get(String(channelId).trim()) as SqliteRow
    return numberOf(row.count)
  }

  /**
   * 压缩当前待投递队列里的文本重复项。
   * 只动 delivered_at，不删除历史行；附件消息不参与，避免误吞文件/图片。
   */
  dedupePendingOutbound(channelId: string, now = Date.now()): number {
    const normalizedChannel = String(channelId).trim()
    if (!/^\d+$/.test(normalizedChannel)) throw new Error(`通道号无效：${channelId}`)
    const pending = this.listPendingOutbound(normalizedChannel)
    if (pending.length < 2) return 0

    const recent = new Map<string, number>()
    const duplicateIds: string[] = []
    for (const message of pending) {
      if (message.attachments?.length) continue
      const key = `${message.silent ? 1 : 0}\0${message.text.trim()}`
      const previousAt = recent.get(key)
      if (previousAt !== undefined && message.createdAt - previousAt <= CHANNEL_OUTBOUND_DEDUPE_WINDOW_MS) {
        duplicateIds.push(message.id)
      }
      recent.set(key, message.createdAt)
    }
    if (!duplicateIds.length) return 0

    const statement = this.database.prepare(
      'UPDATE channel_outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL'
    )
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const id of duplicateIds) statement.run(now, id)
      this.database.exec('COMMIT')
      return duplicateIds.length
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** 主进程侧：按时间窗口读取已入队的可回放出站消息（含已投递/未投递）。 */
  listOutboundSince(startedAt: number, limit = 500): ChannelOutboundMessage[] {
    const rows = this.database.prepare(`
      SELECT * FROM (
        SELECT * FROM channel_outbox
        WHERE created_at >= ?
        ORDER BY created_at DESC, seq DESC
        LIMIT ?
      )
      ORDER BY created_at ASC, seq ASC
    `).all(Math.max(0, Math.floor(startedAt)), Math.max(1, limit)) as SqliteRow[]
    return rows.map(outboundOf)
  }

  /**
   * Agent → 用户：归档一条完整可见回复（可携带过程区块 / 流式回合标识）。
   * 幂等语义：MCP 客户端超时重试 / Agent 补同步重复提交时，同一轮回复只入一行——
   * 有 turn 按 (channel_id, turn) 覆盖原行（保留行身份与时间线位置）；
   * 无 turn 在 CHANNEL_REPLY_DEDUPE_WINDOW_MS 窗口内同内容视为重复提交，返回原行。
   */
  recordReply(input: RecordReplyInput, now = Date.now()): ChannelInboundReply {
    const channelId = String(input.channelId).trim()
    if (!/^\d+$/.test(channelId)) throw new Error(`通道号无效：${input.channelId}`)
    const content = String(input.content ?? '').trim()
    if (!content) throw new Error('回复内容不能为空')
    const files = (input.files ?? []).map(String).filter(Boolean).slice(0, 32)
    const process = input.process?.length ? input.process.slice(0, 200) : undefined
    const turn = input.turn?.trim() || undefined

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const presence = this.getPresence(channelId)
      const allowContentDedupe = !turn && presence?.pendingReplySyncSince === undefined
      const duplicate = this.findDuplicateReply(channelId, content, turn, now, allowContentDedupe)
      if (duplicate && !turn) {
        this.database.exec('COMMIT')
        return duplicate
      }
      if (duplicate && turn) {
        // 同 turn 重试可能携带更完整的过程块/附件，覆盖内容字段但保留行身份与 created_at
        this.database.prepare(`
          UPDATE channel_replies
          SET content = ?, title = ?, group_id = ?, task_id = ?, files_json = ?, process_json = ?
          WHERE id = ?
        `).run(
          content,
          input.title?.trim() || null,
          input.groupId?.trim() || null,
          input.taskId?.trim() || null,
          JSON.stringify(files),
          process ? JSON.stringify(process) : null,
          duplicate.id
        )
        this.archiveProcessEvents(channelId, turn, now)
        this.database.exec('COMMIT')
        return {
          ...duplicate,
          content,
          title: input.title?.trim() || undefined,
          groupId: input.groupId?.trim() || undefined,
          taskId: input.taskId?.trim() || undefined,
          files,
          process
        }
      }

      const reply: ChannelInboundReply = {
        id: randomUUID(),
        channelId,
        content,
        title: input.title?.trim() || undefined,
        groupId: input.groupId?.trim() || undefined,
        taskId: input.taskId?.trim() || undefined,
        files,
        process,
        turn,
        createdAt: now
      }
      this.database.prepare(`
        INSERT INTO channel_replies (id, channel_id, content, title, group_id, task_id, files_json, process_json, turn, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reply.id,
        reply.channelId,
        reply.content,
        reply.title ?? null,
        reply.groupId ?? null,
        reply.taskId ?? null,
        JSON.stringify(reply.files),
        reply.process ? JSON.stringify(reply.process) : null,
        reply.turn ?? null,
        reply.createdAt
      )
      if (turn) {
        // 回复落地即归档同 turn 的流式过程事件：live 透出消失，时间线改由回复承载
        this.archiveProcessEvents(channelId, turn, now)
      }
      this.database.exec('COMMIT')
      return reply
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** 查重：有 turn 按 (channel_id, turn)；无 turn 按窗口内同 (channel_id, content)。 */
  private findDuplicateReply(
    channelId: string,
    content: string,
    turn: string | undefined,
    now: number,
    allowContentDedupe = true
  ): ChannelInboundReply | undefined {
    if (turn) {
      const row = this.database.prepare(
        'SELECT * FROM channel_replies WHERE channel_id = ? AND turn = ? ORDER BY created_at ASC LIMIT 1'
      ).get(channelId, turn) as SqliteRow | undefined
      return row ? replyOf(row) : undefined
    }
    if (!allowContentDedupe) return undefined
    const rows = this.database.prepare(`
      SELECT * FROM channel_replies
      WHERE channel_id = ? AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(channelId, now - CHANNEL_REPLY_DEDUPE_WINDOW_MS) as SqliteRow[]
    const canonical = canonicalReplyContent(content)
    const duplicate = rows.find((row) => canonicalReplyContent(String(row.content)) === canonical)
    return duplicate ? replyOf(duplicate) : undefined
  }

  /** 归档同 turn 的流式过程事件（record_reply 落地语义，insert/update 路径共用）。 */
  private archiveProcessEvents(channelId: string, turn: string, now: number): void {
    this.database.prepare(
      'UPDATE channel_process_events SET archived = 1, updated_at = ? WHERE channel_id = ? AND turn = ? AND archived = 0'
    ).run(now, channelId, turn)
  }

  /**
   * record_process：按 (channel_id, turn, block_id) upsert 过程区块（状态翻转语义）。
   * 单通道未归档事件超上限拒绝；写入时顺手清理过期已归档事件（零额外交互）。
   */
  recordProcessEvent(input: {
    channelId: string
    turn: string
    block: ProcessBlock
  }, now = Date.now()): ChannelProcessEvent {
    const channelId = String(input.channelId).trim()
    if (!/^\d+$/.test(channelId)) throw new Error(`通道号无效：${input.channelId}`)
    const turn = String(input.turn ?? '').trim()
    if (!turn || turn.length > 120) throw new Error('过程回合标识无效')
    const block = input.block
    if (!block || typeof block !== 'object' || !block.id) throw new Error('过程区块无效')

    this.database.exec('BEGIN IMMEDIATE')
    try {
      // 顺手清理：已归档且过期的过程事件（reply 归档后 live 已不再需要）
      this.database.prepare(
        'DELETE FROM channel_process_events WHERE archived = 1 AND updated_at < ?'
      ).run(now - CHANNEL_PROCESS_EVENTS_ARCHIVED_TTL_MS)

      const existing = this.database.prepare(
        'SELECT id, seq, created_at FROM channel_process_events WHERE channel_id = ? AND turn = ? AND block_id = ?'
      ).get(channelId, turn, block.id) as SqliteRow | undefined
      if (!existing) {
        const pending = this.database.prepare(
          'SELECT COUNT(*) AS count FROM channel_process_events WHERE channel_id = ? AND archived = 0'
        ).get(channelId) as SqliteRow
        if (numberOf(pending.count) >= CHANNEL_PROCESS_EVENTS_MAX_PENDING) {
          throw new Error(`CH-${channelId} 未归档过程事件已达上限（${CHANNEL_PROCESS_EVENTS_MAX_PENDING}），请先 record_reply 归档`)
        }
      }
      const seq = existing
        ? numberOf(existing.seq)
        : numberOf((this.database.prepare(
            'SELECT MAX(seq) AS seq FROM channel_process_events WHERE channel_id = ?'
          ).get(channelId) as SqliteRow).seq) + 1
      const id = existing ? String(existing.id) : randomUUID()
      const createdAt = existing ? numberOf(existing.created_at) : now
      this.database.prepare(`
        INSERT INTO channel_process_events (id, channel_id, turn, block_id, seq, payload_json, created_at, updated_at, archived)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT (channel_id, turn, block_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `).run(id, channelId, turn, block.id, seq, JSON.stringify(block), createdAt, now)
      this.database.exec('COMMIT')
      return { id, channelId, turn, blockId: block.id, seq, block, createdAt, updatedAt: now, archived: false }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** 通道当前活跃回合的过程事件（未归档，按 seq 升序）。 */
  listLiveProcessEvents(channelId: string): ChannelProcessEvent[] {
    const rows = this.database.prepare(
      'SELECT * FROM channel_process_events WHERE channel_id = ? AND archived = 0 ORDER BY seq ASC'
    ).all(String(channelId).trim()) as SqliteRow[]
    return rows.flatMap((row) => {
      const event = processEventOf(row)
      return event ? [event] : []
    })
  }

  /** 指定回合的全部过程事件（含已归档，按 seq 升序）——reply 透出重建用。 */
  listProcessEventsForTurn(channelId: string, turn: string): ChannelProcessEvent[] {
    const rows = this.database.prepare(
      'SELECT * FROM channel_process_events WHERE channel_id = ? AND turn = ? ORDER BY seq ASC'
    ).all(String(channelId).trim(), turn.trim()) as SqliteRow[]
    return rows.flatMap((row) => {
      const event = processEventOf(row)
      return event ? [event] : []
    })
  }

  /** 主进程侧：读取未消费的入站回复（全通道，按时间升序）。 */
  listUnconsumedReplies(limit = 100): ChannelInboundReply[] {
    const rows = this.database.prepare(
      'SELECT * FROM channel_replies WHERE consumed_at IS NULL ORDER BY created_at ASC LIMIT ?'
    ).all(Math.max(1, limit)) as SqliteRow[]
    return rows.map(replyOf)
  }

  /** 主进程侧：按时间窗口读取可回放入站回复（含已消费/未消费）。 */
  listRepliesSince(startedAt: number, limit = 500): ChannelInboundReply[] {
    const rows = this.database.prepare(`
      SELECT * FROM (
        SELECT * FROM channel_replies
        WHERE created_at >= ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      )
      ORDER BY created_at ASC, id ASC
    `).all(Math.max(0, Math.floor(startedAt)), Math.max(1, limit)) as SqliteRow[]
    return rows.map(replyOf)
  }

  markReplyConsumed(id: string, now = Date.now()): void {
    this.database.prepare(
      'UPDATE channel_replies SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL'
    ).run(now, id)
  }

  /** MCP 进程刷新活性；通道首次出现时建立基线行。 */
  touchPresence(channelId: string, patch: PresencePatch, now = Date.now()): ChannelPresence {
    const normalizedChannel = String(channelId).trim()
    if (!/^\d+$/.test(normalizedChannel)) throw new Error(`通道号无效：${channelId}`)
    const current = this.getPresence(normalizedChannel)
    const next: ChannelPresence = {
      channelId: normalizedChannel,
      lastSeenAt: patch.lastSeenAt ?? now,
      waiting: patch.waiting ?? current?.waiting ?? false,
      connectionPhase: patch.connectionPhase ?? current?.connectionPhase ?? '',
      turnCount: patch.turnCount ?? current?.turnCount ?? 0,
      deliveredCount: patch.deliveredCount ?? current?.deliveredCount ?? 0,
      keepaliveRound: patch.keepaliveRound ?? current?.keepaliveRound ?? 0,
      pendingReplySyncSince: patch.pendingReplySyncSince === undefined
        ? current?.pendingReplySyncSince
        : patch.pendingReplySyncSince === null
          ? undefined
          : patch.pendingReplySyncSince,
      pendingGroupChat: patch.pendingGroupChat ?? current?.pendingGroupChat ?? false,
      pendingGroupId: patch.pendingGroupId === undefined
        ? current?.pendingGroupId
        : patch.pendingGroupId === null
          ? undefined
          : patch.pendingGroupId,
      updatedAt: now
    }
    this.database.prepare(`
      INSERT INTO channel_presence (
        channel_id, last_seen_at, waiting, connection_phase, turn_count,
        delivered_count, keepalive_round, pending_reply_sync_since,
        pending_group_chat, pending_group_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (channel_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        waiting = excluded.waiting,
        connection_phase = excluded.connection_phase,
        turn_count = excluded.turn_count,
        delivered_count = excluded.delivered_count,
        keepalive_round = excluded.keepalive_round,
        pending_reply_sync_since = excluded.pending_reply_sync_since,
        pending_group_chat = excluded.pending_group_chat,
        pending_group_id = excluded.pending_group_id,
        updated_at = excluded.updated_at
    `).run(
      next.channelId,
      next.lastSeenAt,
      next.waiting ? 1 : 0,
      next.connectionPhase,
      next.turnCount,
      next.deliveredCount,
      next.keepaliveRound,
      next.pendingReplySyncSince ?? null,
      next.pendingGroupChat ? 1 : 0,
      next.pendingGroupId ?? null,
      next.updatedAt
    )
    return next
  }

  getPresence(channelId: string): ChannelPresence | undefined {
    const row = this.database.prepare(
      'SELECT * FROM channel_presence WHERE channel_id = ?'
    ).get(String(channelId).trim()) as SqliteRow | undefined
    return row ? presenceOf(row) : undefined
  }

  listPresence(): ChannelPresence[] {
    const rows = this.database.prepare(
      'SELECT * FROM channel_presence ORDER BY CAST(channel_id AS INTEGER) ASC'
    ).all() as SqliteRow[]
    return rows.map(presenceOf)
  }

  /**
   * 内嵌通道注册：安装器把 qtwx-mcp-N 指向群枢内嵌 server 后记录，
   * 主进程发送分流与活性投影据此判定通道归属（重启后可恢复）。
   */
  markChannelEmbedded(channelId: string, workspaceId: string, workspacePath: string, now = Date.now()): void {
    const normalizedChannel = String(channelId).trim()
    if (!/^\d+$/.test(normalizedChannel)) throw new Error(`通道号无效：${channelId}`)
    if (!workspaceId.trim() || !workspacePath.trim()) throw new Error('工作区标识无效')
    this.database.prepare(`
      INSERT INTO channel_links (channel_id, workspace_id, workspace_path, embedded, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (channel_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        workspace_path = excluded.workspace_path,
        embedded = 1,
        updated_at = excluded.updated_at
    `).run(normalizedChannel, workspaceId.trim(), workspacePath.trim(), now)
  }

  /**
   * 精确同步当前工作区由群枢内嵌接管的通道。团队席位减少后，旧通道必须撤下，
   * 否则会话页会继续展示 CH-6/7/8 这类已不属于当前团队的历史通道。
   */
  replaceEmbeddedChannels(workspaceId: string, workspacePath: string, channelIds: string[], now = Date.now()): void {
    const normalizedWorkspaceId = workspaceId.trim()
    const normalizedWorkspacePath = workspacePath.trim()
    if (!normalizedWorkspaceId || !normalizedWorkspacePath) throw new Error('工作区标识无效')
    const normalizedChannels = [...new Set(channelIds.map((channelId) => String(channelId).trim()).filter(Boolean))]
    if (normalizedChannels.some((channelId) => !/^\d+$/.test(channelId))) {
      throw new Error('通道号无效')
    }

    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (normalizedChannels.length) {
        const placeholders = normalizedChannels.map(() => '?').join(', ')
        this.database.prepare(`
          UPDATE channel_links
          SET embedded = 0, updated_at = ?
          WHERE workspace_id = ? AND embedded = 1 AND channel_id NOT IN (${placeholders})
        `).run(now, normalizedWorkspaceId, ...normalizedChannels)
      } else {
        this.database.prepare(`
          UPDATE channel_links
          SET embedded = 0, updated_at = ?
          WHERE workspace_id = ? AND embedded = 1
        `).run(now, normalizedWorkspaceId)
      }
      const upsert = this.database.prepare(`
        INSERT INTO channel_links (channel_id, workspace_id, workspace_path, embedded, updated_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT (channel_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          workspace_path = excluded.workspace_path,
          embedded = 1,
          updated_at = excluded.updated_at
      `)
      for (const channelId of normalizedChannels) {
        upsert.run(channelId, normalizedWorkspaceId, normalizedWorkspacePath, now)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** 撤销内嵌标记（例如工作区重装回插件模式）；不常用，保留给退役路径。 */
  markChannelDetached(channelId: string, now = Date.now()): void {
    this.database.prepare(
      'UPDATE channel_links SET embedded = 0, updated_at = ? WHERE channel_id = ?'
    ).run(now, String(channelId).trim())
  }

  isChannelEmbedded(channelId: string): boolean {
    const row = this.database.prepare(
      'SELECT embedded FROM channel_links WHERE channel_id = ?'
    ).get(String(channelId).trim()) as SqliteRow | undefined
    return row ? numberOf(row.embedded) === 1 : false
  }

  listEmbeddedChannels(): string[] {
    const rows = this.database.prepare(
      'SELECT channel_id FROM channel_links WHERE embedded = 1 ORDER BY CAST(channel_id AS INTEGER) ASC'
    ).all() as SqliteRow[]
    return rows.map((row) => String(row.channel_id))
  }

  close(): void {
    if (this.database.isOpen) this.database.close()
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS channel_outbox (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        attachments_json TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE (channel_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_channel_outbox_pending
        ON channel_outbox (channel_id, delivered_at, seq);

      CREATE INDEX IF NOT EXISTS idx_channel_outbox_history
        ON channel_outbox (created_at, channel_id, seq);

      CREATE TABLE IF NOT EXISTS channel_replies (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        content TEXT NOT NULL,
        title TEXT,
        group_id TEXT,
        task_id TEXT,
        files_json TEXT NOT NULL,
        process_json TEXT,
        turn TEXT,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS channel_process_events (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        turn TEXT NOT NULL,
        block_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        UNIQUE (channel_id, turn, block_id)
      );

      CREATE INDEX IF NOT EXISTS idx_channel_process_events_live
        ON channel_process_events (channel_id, archived, seq);

      CREATE INDEX IF NOT EXISTS idx_channel_replies_unconsumed
        ON channel_replies (consumed_at, created_at);

      CREATE INDEX IF NOT EXISTS idx_channel_replies_history
        ON channel_replies (created_at, channel_id);

      CREATE TABLE IF NOT EXISTS channel_presence (
        channel_id TEXT PRIMARY KEY,
        last_seen_at INTEGER NOT NULL,
        waiting INTEGER NOT NULL,
        connection_phase TEXT NOT NULL,
        turn_count INTEGER NOT NULL,
        delivered_count INTEGER NOT NULL,
        keepalive_round INTEGER NOT NULL,
        pending_reply_sync_since INTEGER,
        pending_group_chat INTEGER NOT NULL,
        pending_group_id TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_links (
        channel_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        embedded INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    this.migrateProcessColumn()
    this.migrateAttachmentsColumn()
    this.migrateOutboundSilentColumn()
    this.migrateReplyTurnColumn()
  }

  /** 老库增量迁移：channel_replies 补 process_json 列（新库建表已含）。 */
  private migrateProcessColumn(): void {
    this.migrateColumn('channel_replies', 'process_json')
  }

  /** 老库增量迁移：channel_replies 补 turn 列（流式过程回合标识）。 */
  private migrateReplyTurnColumn(): void {
    this.migrateColumn('channel_replies', 'turn')
  }

  /** 老库增量迁移：channel_outbox 补 attachments_json 列（新库建表已含）。 */
  private migrateAttachmentsColumn(): void {
    this.migrateColumn('channel_outbox', 'attachments_json')
  }

  /** 老库增量迁移：channel_outbox 补 silent 列，用于重启水合时隐藏内部消息。 */
  private migrateOutboundSilentColumn(): void {
    this.migrateColumn('channel_outbox', 'silent', 'INTEGER NOT NULL DEFAULT 0')
  }

  private migrateColumn(table: string, column: string, definition = 'TEXT'): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as SqliteRow[]
    if (columns.some((row) => String(row.name) === column)) return
    this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}
