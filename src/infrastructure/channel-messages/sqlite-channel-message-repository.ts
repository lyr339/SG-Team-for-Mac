import { numberOf, type SqliteRow } from '../sqlite/rows'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  CHANNEL_OUTBOX_MAX_PENDING,
  CHANNEL_OUTBOUND_DEDUPE_WINDOW_MS,
  CHANNEL_REPLY_DEDUPE_WINDOW_MS,
  PRESENCE_REVIVED_PHASE,
  isExplicitlyStoppedPhase,
  type ChannelInboundReply,
  type ChannelOutboundMessage,
  type ChannelPresence
} from '../../domain/channel-message'
import type { MessageAttachment, ProcessBlock } from '../../domain/conversation-entry'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function stringArrayOf(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed)) return []
  return parsed.map(String).filter(Boolean)
}

/** attachments_json 解析：异常/非数组一律视为无附件。 */
function attachmentsOf(value: unknown): MessageAttachment[] | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length ? parsed as MessageAttachment[] : undefined
  } catch {
    return undefined
  }
}

function processBlocksOf(value: unknown): ProcessBlock[] | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length ? parsed as ProcessBlock[] : undefined
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
    runId: optionalString(row.run_id),
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
  const visible = row.visible === undefined || row.visible === null || numberOf(row.visible) !== 0
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    content: String(row.content),
    title: optionalString(row.title),
    groupId: optionalString(row.group_id),
    taskId: optionalString(row.task_id),
    files: stringArrayOf(row.files_json),
    visible: visible ? undefined : false,
    createdAt: numberOf(row.created_at),
    consumedAt: row.consumed_at === null ? undefined : numberOf(row.consumed_at),
    outboundId: optionalString(row.outbound_id),
    processBlocks: processBlocksOf(row.process_blocks_json),
    processTurn: optionalString(row.process_turn),
    processTruncatedItemCount: row.process_truncated_count === null || row.process_truncated_count === undefined
      ? undefined : numberOf(row.process_truncated_count)
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
    pendingOutboundId: optionalString(row.pending_outbound_id),
    pendingGroupChat: numberOf(row.pending_group_chat) === 1,
    pendingGroupId: optionalString(row.pending_group_id),
    runtimeActiveAt: row.runtime_active_at === null || row.runtime_active_at === undefined
      ? undefined
      : numberOf(row.runtime_active_at),
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
  /** false 表示后台/内部同步，不进入用户可见时间线；缺省为 true。 */
  visible?: boolean
  outboundId?: string
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
  pendingOutboundId?: string | null
  pendingGroupChat?: boolean
  pendingGroupId?: string | null
}

/**
 * 通道消息队列 SQLite 仓库。与任务池共用同一数据库文件（WAL），
 * 拾光主进程与内嵌 MCP server 进程通过该库交换消息，不引入额外 IPC。
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
    silent = false,
    runId?: string
  ): ChannelOutboundMessage {
    const normalizedChannel = String(channelId).trim()
    if (!/^\d+$/.test(normalizedChannel)) throw new Error(`通道号无效：${channelId}`)
    const normalizedText = String(text ?? '').trim()
    const normalizedRunId = runId?.trim() || undefined
    const activeRunId = this.currentScopeRunId()
    if (normalizedRunId && activeRunId && normalizedRunId !== activeRunId) {
      throw new Error(`消息属于已结束的 TeamRun，拒绝写入当前队列`)
    }
    const effectiveRunId = normalizedRunId ?? activeRunId
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
          now,
          effectiveRunId
        )
      if (duplicate) {
        this.database.exec('COMMIT')
        return duplicate
      }
      const depth = this.database.prepare(
        'SELECT COUNT(*) AS count FROM channel_outbox WHERE channel_id = ? AND delivered_at IS NULL AND retired_at IS NULL'
      ).get(normalizedChannel) as SqliteRow
      if (numberOf(depth.count) >= CHANNEL_OUTBOX_MAX_PENDING) {
        throw new Error(`CH-${normalizedChannel} 待投递消息已达上限，请等待 Agent 消费`)
      }
      const last = this.database.prepare(
        'SELECT MAX(seq) AS seq FROM channel_outbox WHERE channel_id = ?'
      ).get(normalizedChannel) as SqliteRow
      const message: ChannelOutboundMessage = {
        id: randomUUID(),
        runId: effectiveRunId,
        channelId: normalizedChannel,
        seq: numberOf(last.seq) + 1,
        text: normalizedText,
        attachments: attachments?.length ? attachments : undefined,
        createdAt: now,
        silent: silent ? true : undefined
      }
      this.database.prepare(
        'INSERT INTO channel_outbox (id, run_id, channel_id, seq, text, attachments_json, created_at, silent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        message.id,
        message.runId ?? null,
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
    now: number,
    runId?: string
  ): ChannelOutboundMessage | undefined {
    const row = this.database.prepare(`
      SELECT * FROM channel_outbox
      WHERE channel_id = ?
        AND ${runId ? 'run_id = ?' : 'run_id IS NULL'}
        AND text = ?
        AND attachments_json IS NULL
        AND silent = ?
        AND retired_at IS NULL
        AND created_at > ?
      ORDER BY created_at DESC, seq DESC
      LIMIT 1
    `).get(
      channelId,
      ...(runId ? [runId] : []),
      text,
      silent ? 1 : 0,
      now - CHANNEL_OUTBOUND_DEDUPE_WINDOW_MS
    ) as SqliteRow | undefined
    return row ? outboundOf(row) : undefined
  }

  /** Agent 侧：按 seq 升序读取通道待投递消息。 */
  listPendingOutbound(channelId: string): ChannelOutboundMessage[] {
    const runId = this.currentScopeRunId()
    const rows = this.database.prepare(`
      SELECT * FROM channel_outbox
      WHERE channel_id = ? AND delivered_at IS NULL AND retired_at IS NULL
        AND ${runId ? 'run_id = ?' : 'run_id IS NULL'}
      ORDER BY seq ASC
    `).all(String(channelId).trim(), ...(runId ? [runId] : [])) as SqliteRow[]
    return rows.map(outboundOf)
  }

  /** Agent 侧：标记消息已投递（取出即标记，保证最多一次投递）。 */
  markOutboundDelivered(ids: string[], now = Date.now()): void {
    if (!ids.length) return
    const statement = this.database.prepare(
      'UPDATE channel_outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL AND retired_at IS NULL'
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
  latestDeliveredOutbound(channelId: string, options: { visibleOnly?: boolean } = {}): ChannelOutboundMessage | undefined {
    const runId = this.currentScopeRunId()
    const row = this.database.prepare(`
      SELECT * FROM channel_outbox
      WHERE channel_id = ? AND delivered_at IS NOT NULL AND retired_at IS NULL
        AND ${runId ? 'run_id = ?' : 'run_id IS NULL'}
        ${options.visibleOnly ? 'AND silent = 0' : ''}
      ORDER BY delivered_at DESC, seq DESC
      LIMIT 1
    `).get(String(channelId).trim(), ...(runId ? [runId] : [])) as SqliteRow | undefined
    return row ? outboundOf(row) : undefined
  }

  countPendingOutbound(channelId: string): number {
    const runId = this.currentScopeRunId()
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM channel_outbox
      WHERE channel_id = ? AND delivered_at IS NULL AND retired_at IS NULL
        AND ${runId ? 'run_id = ?' : 'run_id IS NULL'}
    `).get(String(channelId).trim(), ...(runId ? [runId] : [])) as SqliteRow
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
      'UPDATE channel_outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL AND retired_at IS NULL'
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

  /**
   * 进入新 TeamRun 时原子结算旧作用域：
   * - 旧未投递消息标记 retired（保留审计，但不再计数/投递）；
   * - 清除旧轮 reply-sync 守门，避免新轮 check_messages 被上一轮回复阻塞；
   */
  retireScopeBefore(startedAt: number, now = Date.now()): {
    outbound: number
    presence: number
  } {
    const boundary = Math.max(0, Math.floor(startedAt))
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const outbound = this.database.prepare(`
        UPDATE channel_outbox
        SET retired_at = ?
        WHERE delivered_at IS NULL AND retired_at IS NULL AND created_at < ?
      `).run(now, boundary)
      const presence = this.database.prepare(`
        UPDATE channel_presence
        SET pending_reply_sync_since = NULL, pending_outbound_id = NULL,
            pending_group_chat = 0,
            pending_group_id = NULL,
            updated_at = ?
        WHERE (pending_reply_sync_since IS NOT NULL AND pending_reply_sync_since < ?)
           OR pending_outbound_id IS NOT NULL
      `).run(now, boundary)
      this.database.exec('COMMIT')
      return {
        outbound: numberOf(outbound.changes),
        presence: numberOf(presence.changes)
      }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** 原子切换当前 TeamRun；非当前轮消息一律退役，MCP 进程只读取该 run。 */
  beginScope(runId: string, startedAt: number, now = Date.now()): ReturnType<SqliteChannelMessageRepository['retireScopeBefore']> {
    const normalizedRunId = runId.trim()
    if (!normalizedRunId) throw new Error('TeamRun 作用域无效')
    const boundary = Math.max(0, Math.floor(startedAt))
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        INSERT INTO channel_scope (id, run_id, started_at, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          run_id = excluded.run_id,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at
      `).run(normalizedRunId, boundary, now)
      const outbound = this.database.prepare(`
        UPDATE channel_outbox SET retired_at = ?
        WHERE delivered_at IS NULL AND retired_at IS NULL
          AND (run_id IS NULL OR run_id <> ? OR created_at < ?)
      `).run(now, normalizedRunId, boundary)
      const presence = this.database.prepare(`
        UPDATE channel_presence
        SET pending_reply_sync_since = NULL, pending_outbound_id = NULL, pending_group_chat = 0,
            pending_group_id = NULL, updated_at = ?
        WHERE (pending_reply_sync_since IS NOT NULL AND pending_reply_sync_since < ?)
           OR pending_outbound_id IS NOT NULL
      `).run(now, boundary)
      // 上一轮残留的终止相位（cursor_stopped/tool_aborted）必须随作用域切换清除：
      // presence 行不按 run 分表，死亡证据跨轮存活会把新 run 的签到 Agent
      // 永久判死。清除后进入 reviving 中转相，等待 Agent 的协议相位接管。
      const revived = this.database.prepare(`
        UPDATE channel_presence
        SET connection_phase = ?, waiting = 0, updated_at = ?
        WHERE connection_phase IN ('cursor_stopped', 'tool_aborted')
      `).run(PRESENCE_REVIVED_PHASE, now)
      this.database.exec('COMMIT')
      return {
        outbound: numberOf(outbound.changes),
        presence: numberOf(presence.changes) + numberOf(revived.changes)
      }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  currentScopeRunId(): string | undefined {
    const row = this.database.prepare('SELECT run_id FROM channel_scope WHERE id = 1').get() as SqliteRow | undefined
    return row ? optionalString(row.run_id) : undefined
  }

  /** 持久化会话域（relay 重启水合的事实源）：runId + 起始时间。 */
  currentScope(): { runId: string; startedAt: number } | undefined {
    const row = this.database.prepare(
      'SELECT run_id, started_at FROM channel_scope WHERE id = 1'
    ).get() as SqliteRow | undefined
    const runId = row ? optionalString(row.run_id) : undefined
    return runId && row ? { runId, startedAt: numberOf(row.started_at) } : undefined
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
   * Agent → 用户：归档一条完整可见回复。
   * 幂等语义：MCP 客户端超时重试 / Agent 补同步重复提交时，同一轮回复只入一行——
   * CHANNEL_REPLY_DEDUPE_WINDOW_MS 窗口内同内容视为重复提交，返回原行。
   */
  recordReply(input: RecordReplyInput, now = Date.now()): ChannelInboundReply {
    const channelId = String(input.channelId).trim()
    if (!/^\d+$/.test(channelId)) throw new Error(`通道号无效：${input.channelId}`)
    const content = String(input.content ?? '').trim()
    if (!content) throw new Error('回复内容不能为空')
    const files = (input.files ?? []).map(String).filter(Boolean).slice(0, 32)
    const visible = input.visible !== false

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const presence = this.getPresence(channelId)
      const allowContentDedupe = presence?.pendingReplySyncSince === undefined
      const duplicate = this.findDuplicateReply(channelId, content, visible, now, allowContentDedupe)
      if (duplicate) {
        this.database.exec('COMMIT')
        return duplicate
      }

      const reply: ChannelInboundReply = {
        id: randomUUID(),
        channelId,
        content,
        title: input.title?.trim() || undefined,
        groupId: input.groupId?.trim() || undefined,
        taskId: input.taskId?.trim() || undefined,
        files,
        visible: visible ? undefined : false,
        outboundId: input.outboundId?.trim() || undefined,
        createdAt: now
      }
      this.database.prepare(`
        INSERT INTO channel_replies (id, channel_id, content, title, group_id, task_id, files_json, visible, outbound_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reply.id,
        reply.channelId,
        reply.content,
        reply.title ?? null,
        reply.groupId ?? null,
        reply.taskId ?? null,
        JSON.stringify(reply.files),
        visible ? 1 : 0,
        reply.outboundId ?? null,
        reply.createdAt
      )
      this.database.exec('COMMIT')
      return reply
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** 按时间窗口内同 (channel_id, content) 查重。 */
  private findDuplicateReply(
    channelId: string,
    content: string,
    visible: boolean,
    now: number,
    allowContentDedupe = true
  ): ChannelInboundReply | undefined {
    if (!allowContentDedupe) return undefined
    const rows = this.database.prepare(`
      SELECT * FROM channel_replies
      WHERE channel_id = ? AND visible = ? AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(channelId, visible ? 1 : 0, now - CHANNEL_REPLY_DEDUPE_WINDOW_MS) as SqliteRow[]
    const canonical = canonicalReplyContent(content)
    const duplicate = rows.find((row) => canonicalReplyContent(String(row.content)) === canonical)
    return duplicate ? replyOf(duplicate) : undefined
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

  /**
   * 把主进程捕获的 Cursor 原生过程持久绑定到已落库回复（幂等重写）。
   * 回复行不存在时返回 false，由调用方在后续快照重试（队列有时效兜底）。
   */
  attachReplyProcess(input: {
    replyId: string
    turn: string
    blocks: ProcessBlock[]
    truncatedItemCount?: number
    outboundId?: string
  }): boolean {
    if (!input.replyId.trim() || !input.turn.trim() || !input.blocks.length) return false
    const result = this.database.prepare(`
      UPDATE channel_replies
      SET process_blocks_json = ?, process_turn = ?, process_truncated_count = ?,
          outbound_id = COALESCE(?, outbound_id)
      WHERE id = ?
    `).run(
      JSON.stringify(input.blocks), input.turn.trim(), input.truncatedItemCount ?? null,
      input.outboundId?.trim() || null, input.replyId.trim()
    )
    return numberOf(result.changes) === 1
  }

  /** MCP 进程刷新活性；通道首次出现时建立基线行。 */
  touchPresence(channelId: string, patch: PresencePatch, now = Date.now()): ChannelPresence {
    const normalizedChannel = String(channelId).trim()
    if (!/^\d+$/.test(normalizedChannel)) throw new Error(`通道号无效：${normalizedChannel}`)
    const current = this.getPresence(normalizedChannel)
    // 纯心跳写入（不带 connectionPhase）即 MCP 工具调用刚发生的生命证据：
    // 终止相位必须让位（2026-09-01 事故：签到后仍被残留 cursor_stopped
    // 永久判死）。显式写相位的调用（markCursorStopped/协议相位机）不受影响。
    const phaseOfPatch = patch.connectionPhase ?? (
      patch.lastSeenAt !== undefined && current && isExplicitlyStoppedPhase(current.connectionPhase)
        ? PRESENCE_REVIVED_PHASE
        : undefined
    )
    const next: ChannelPresence = {
      channelId: normalizedChannel,
      lastSeenAt: patch.lastSeenAt ?? now,
      waiting: patch.waiting ?? current?.waiting ?? false,
      connectionPhase: phaseOfPatch ?? current?.connectionPhase ?? '',
      turnCount: patch.turnCount ?? current?.turnCount ?? 0,
      deliveredCount: patch.deliveredCount ?? current?.deliveredCount ?? 0,
      keepaliveRound: patch.keepaliveRound ?? current?.keepaliveRound ?? 0,
      pendingReplySyncSince: patch.pendingReplySyncSince === undefined
        ? current?.pendingReplySyncSince
        : patch.pendingReplySyncSince === null
          ? undefined
          : patch.pendingReplySyncSince,
      pendingOutboundId: patch.pendingOutboundId === undefined
        ? current?.pendingOutboundId
        : patch.pendingOutboundId === null
          ? undefined
          : patch.pendingOutboundId.trim() || undefined,
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
        delivered_count, keepalive_round, pending_reply_sync_since, pending_outbound_id,
        pending_group_chat, pending_group_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (channel_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        waiting = excluded.waiting,
        connection_phase = excluded.connection_phase,
        turn_count = excluded.turn_count,
        delivered_count = excluded.delivered_count,
        keepalive_round = excluded.keepalive_round,
        pending_reply_sync_since = excluded.pending_reply_sync_since,
        pending_outbound_id = excluded.pending_outbound_id,
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
      next.pendingOutboundId ?? null,
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

  /**
   * CDP 运行时探测的正面生命证据落库（主进程写入）：
   * - 只单调推进 runtime_active_at（迟到证据不回拨）；
   * - 不触碰 last_seen_at（MCP 心跳语义）与协议相位机的其他字段；
   * - 更新的 CDP 活动推翻终止相位（对称于 markCursorStopped 的新鲜度
   *   守门与 touchPresence 的心跳复活）：死亡证据必须新鲜于生命证据。
   * 无变化（行不存在/证据更旧且无需复活）时不产生任何写入，避免
   * updated_at 噪声触发会话指纹抖动。
   */
  touchRuntimeActivity(channelId: string, observedAt: number): { advanced: boolean; revived: boolean } {
    const normalizedChannel = String(channelId).trim()
    if (!/^\d+$/.test(normalizedChannel)) throw new Error(`通道号无效：${normalizedChannel}`)
    const before = this.getPresence(normalizedChannel)
    const result = this.database.prepare(`
      UPDATE channel_presence
      SET runtime_active_at = ?,
          connection_phase = CASE
            WHEN connection_phase IN ('cursor_stopped', 'tool_aborted') AND last_seen_at <= ? THEN ?
            ELSE connection_phase
          END,
          updated_at = ?
      WHERE channel_id = ?
        AND (
          COALESCE(runtime_active_at, 0) < ?
          OR (connection_phase IN ('cursor_stopped', 'tool_aborted') AND last_seen_at <= ?)
        )
    `).run(
      observedAt,
      observedAt,
      PRESENCE_REVIVED_PHASE,
      observedAt,
      normalizedChannel,
      observedAt,
      observedAt
    )
    if (numberOf(result.changes) === 0 || !before) return { advanced: false, revived: false }
    const after = this.getPresence(normalizedChannel)
    return {
      advanced: (after?.runtimeActiveAt ?? 0) > (before.runtimeActiveAt ?? 0),
      revived: isExplicitlyStoppedPhase(before.connectionPhase)
        && after?.connectionPhase === PRESENCE_REVIVED_PHASE
    }
  }

  listPresence(): ChannelPresence[] {
    const rows = this.database.prepare(
      'SELECT * FROM channel_presence ORDER BY CAST(channel_id AS INTEGER) ASC'
    ).all() as SqliteRow[]
    return rows.map(presenceOf)
  }

  /**
   * 内嵌通道注册：安装器登记由拾光内嵌 server 接管的通道，
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
   * 精确同步当前工作区由拾光内嵌接管的通道。团队席位减少后，旧通道必须撤下，
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
        run_id TEXT,
        channel_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        attachments_json TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        retired_at INTEGER,
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
        visible INTEGER NOT NULL DEFAULT 1,
        outbound_id TEXT,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER
      );

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
        pending_outbound_id TEXT,
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

      CREATE TABLE IF NOT EXISTS channel_scope (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        run_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    this.migrateAttachmentsColumn()
    this.migrateOutboundSilentColumn()
    this.migrateOutboundRetiredColumn()
    this.migrateOutboundRunColumn()
    this.migrateReplyVisibleColumn()
    this.migratePresenceRuntimeActiveColumn()
    this.migratePresencePendingOutboundColumn()
    this.migrateReplyProcessColumns()
    this.migrateReplyOutboundColumn()
    // 旧版过程事件来自 Agent 主动上报，与 Cursor 原生过程重复且失真；迁移时彻底清除。
    this.database.exec('DROP TABLE IF EXISTS channel_process_events')
  }

  /** 老库增量迁移：channel_replies 补 visible 列，用于隐藏后台 record_reply。 */
  private migrateReplyVisibleColumn(): void {
    this.migrateColumn('channel_replies', 'visible', 'INTEGER NOT NULL DEFAULT 1')
  }

  /** 老库增量迁移：channel_outbox 补 attachments_json 列（新库建表已含）。 */
  private migrateAttachmentsColumn(): void {
    this.migrateColumn('channel_outbox', 'attachments_json')
  }

  /** 老库增量迁移：channel_outbox 补 silent 列，用于重启水合时隐藏内部消息。 */
  private migrateOutboundSilentColumn(): void {
    this.migrateColumn('channel_outbox', 'silent', 'INTEGER NOT NULL DEFAULT 0')
  }

  /** 老库增量迁移：区分正常投递与 TeamRun 换轮退役。 */
  private migrateOutboundRetiredColumn(): void {
    this.migrateColumn('channel_outbox', 'retired_at', 'INTEGER')
  }

  /** 老库增量迁移：出站消息显式绑定 TeamRun。 */
  private migrateOutboundRunColumn(): void {
    this.migrateColumn('channel_outbox', 'run_id', 'TEXT')
  }

  /** 老库增量迁移：presence 补 CDP 运行时活动时间列（长任务续命证据）。 */
  private migratePresenceRuntimeActiveColumn(): void {
    this.migrateColumn('channel_presence', 'runtime_active_at', 'INTEGER')
  }

  /** 老库增量迁移：回复同步守门同时保存真实出站消息身份。 */
  private migratePresencePendingOutboundColumn(): void {
    this.migrateColumn('channel_presence', 'pending_outbound_id', 'TEXT')
  }

  /** 老库增量迁移：回复补 Cursor 原生过程持久化列（重启后恢复过程卡）。 */
  private migrateReplyProcessColumns(): void {
    this.migrateColumn('channel_replies', 'process_blocks_json', 'TEXT')
    this.migrateColumn('channel_replies', 'process_turn', 'TEXT')
    this.migrateColumn('channel_replies', 'process_truncated_count', 'INTEGER')
  }

  /** 老库增量迁移：把可见回复稳定关联到触发它的出站消息。 */
  private migrateReplyOutboundColumn(): void {
    this.migrateColumn('channel_replies', 'outbound_id', 'TEXT')
  }

  private migrateColumn(table: string, column: string, definition = 'TEXT'): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as SqliteRow[]
    if (columns.some((row) => String(row.name) === column)) return
    this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}
