import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentSession } from '../domain/agent-session'
import {
  CHANNEL_ATTACHMENT_MAX_COUNT,
  CHANNEL_ATTACHMENT_MAX_FILE_BYTES,
  CHANNEL_ATTACHMENT_MAX_TOTAL_BYTES,
  isExplicitlyStoppedPhase,
  isInternalCollaborationNotificationText,
  isPresenceOnline,
  type ChannelInboundReply,
  type ChannelOutboundMessage,
  type ChannelPresence
} from '../domain/channel-message'
import {
  conversationTextIdentity,
  normalizeEscapedNewlines,
  sniffedAttachmentMimeType,
  type ConversationEntry,
  type MessageAttachment
} from '../domain/conversation-entry'
import type { SqliteChannelMessageRepository } from '../infrastructure/channel-messages/sqlite-channel-message-repository'
import type {
  DesktopSnapshot,
  LiveProcessState,
  SendMessageAccepted,
  SendMessageInput
} from '../shared/desktop-api'

const MAX_ENTRIES_PER_CHANNEL = 500
const MAX_MESSAGE_CHARS = 100_000
const DEFAULT_POLL_MS = 250
const CONVERSATION_SCOPE_CLOCK_SKEW_MS = 5_000
const CONVERSATION_DUPLICATE_ENTRY_WINDOW_MS = 5 * 60_000

type RelayListener = () => void

/** 同一消息内附件落盘文件名去重：同名追加 -2/-3…（保留扩展名），避免互相覆盖丢文件。 */
function uniqueAttachmentName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

/** 分相活性判定：三段模型收口在 domain 的 isPresenceOnline，主进程与 MCP 共用。 */

function sessionStatusOf(presence: ChannelPresence, online: boolean): AgentSession['status'] {
  const phase = presence.connectionPhase.toLowerCase()
  if (phase.includes('reviv') || phase.includes('recover') || phase.includes('reconnect')) return 'reviving'
  if (phase.includes('review')) return 'review'
  // 生成中断（工具调用标记泄漏）需要用户介入，与阻塞同类呈现
  if (phase.includes('block') || phase.includes('approval') || phase.includes('need_') || phase.includes('interrupt')) return 'blocked'
  if (!online) return 'offline'
  if (presence.waiting) return 'waiting'
  if (phase.includes('process') || phase.includes('deliver')) return 'running'
  return 'idle'
}

function canonicalConversationText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function visibleConversationText(text: string): string {
  return normalizeEscapedNewlines(text).trim()
}

function isRecentDuplicateEntry(left: ConversationEntry, right: ConversationEntry): boolean {
  if (left.id === right.id) return true
  if (left.channelId !== right.channelId || left.role !== right.role || left.source !== right.source) return false
  if (left.role !== 'assistant' || right.role !== 'assistant') return false
  if (left.attachments?.length || right.attachments?.length) return false
  if (Math.abs(left.timestamp - right.timestamp) > CONVERSATION_DUPLICATE_ENTRY_WINDOW_MS) return false
  return canonicalConversationText(left.text) === canonicalConversationText(right.text)
}

/**
 * 通道消息中继（一体化 S1 主进程侧）。
 *
 * 职责对齐旧版桥接插件的 WS 链路，但后端是拾光 SQLite：
 * - 发送改道：内嵌通道的用户消息直写 channel_outbox（Agent 长轮询取走）
 * - 入站消费：轮询 channel_replies，把 Agent record_reply 转入会话时间线
 * - 活性投影：channel_presence → AgentSession 覆盖（check_messages 调用流即心跳）
 *
 * 通过 DesktopSessionService 组合进快照管线；与插件 WS 桥并存，
 * 按 channel_links 注册表逐通道分流，支持迁移期混合运行。
 */
export class ChannelMessageRelay {
  private readonly listeners = new Set<RelayListener>()
  private readonly conversations = new Map<string, ConversationEntry[]>()
  private readonly commandReceipts = new Map<string, ConversationEntry>()
  /** sessions 增量缓存：fingerprint 命中即复用引用（结构共享，渲染层 memo 红利）。 */
  private readonly sessionCache = new Map<string, { fingerprint: string; session: AgentSession }>()
  private timer?: ReturnType<typeof setInterval>
  private polling = false
  private scopeStartedAt?: number
  private scopeRunId?: string

  constructor(
    private readonly repository: SqliteChannelMessageRepository,
    private readonly now: () => number = () => Date.now()
  ) {}

  handlesChannel(channelId: string): boolean {
    return this.repository.isChannelEmbedded(channelId)
  }

  embeddedChannels(): string[] {
    return this.repository.listEmbeddedChannels()
  }

  /** 读取通道当前会话时间线（只读引用；封口扫描等主进程旁路只读消费，不得改写）。 */
  conversationsOf(channelId: string): readonly ConversationEntry[] | undefined {
    return this.conversations.get(String(channelId).trim())
  }

  /** Cursor 实时桥确认绑定 Composer 已终止；持久化到 presence，重启后仍保持离线。 */
  markCursorStopped(channelId: string, observedAt = this.now()): boolean {
    const current = this.repository.getPresence(channelId)
    if (current?.connectionPhase === 'cursor_stopped') return false
    // 生命证据更新则不覆盖：停止观测之后 Agent 仍有 MCP 调用（lastSeenAt）或
    // CDP 探测到生成（runtimeActiveAt），说明模型仍在执行——过时的死亡证据
    // 不得压过新生命证据把健康 Agent 判死。
    if (current && Math.max(current.lastSeenAt, current.runtimeActiveAt ?? 0) > observedAt) return false
    // 只写终止相位，不清回复同步守门：Composer 终止时 Agent（MCP 循环）仍欠
    // 已投递消息的 record_reply——守门保留，下一次 check_messages 的
    // reply_sync_required 会推动 Agent 收口（或按 CHANNEL_REPLY_SYNC_STALE_MS
    // 自动放行）；提前清门会让最终回复以 visible=0 落库，用户消息永远无回应。
    this.repository.touchPresence(channelId, {
      lastSeenAt: observedAt,
      waiting: false,
      connectionPhase: 'cursor_stopped'
    }, observedAt)
    this.sessionCache.delete(channelId)
    this.emit()
    return true
  }

  /**
   * CDP 运行时探测确认 Composer 正在生成（refreshRuntimeEvidence 的
   * live.state==='active'）：正面生命证据写回 presence。长任务（>5min 的
   * shell/推理）期间 Agent 按协议不触碰 MCP，但 Cursor 侧持续生成——
   * runtimeActiveAt 让 processing 窗口持续续命，活性不再只停留在内存 telemetry。
   * 只在终止相位被推翻（状态翻转）时 emit；纯证据推进由活性翻转自调度兜底。
   */
  noteRuntimeActivity(channelId: string, observedAt: number): void {
    let revived = false
    try {
      revived = this.repository.touchRuntimeActivity(channelId, observedAt).revived
    } catch {
      return
    }
    if (revived) {
      this.sessionCache.delete(channelId)
      this.emit()
    }
  }

  /** 发送改道入口：仅接受内嵌通道；入队即视为投递受理（无 WS 回执等待）。 */
  sendMessage(input: SendMessageInput): SendMessageAccepted {
    const channelId = String(input.channelId ?? '').trim()
    const text = String(input.text ?? '').trim()
    if (!/^\d+$/.test(channelId)) throw new Error('通道号无效')
    if (!this.handlesChannel(channelId)) throw new Error(`CH-${channelId} 尚未接入拾光内嵌通道`)
    if (text.length > MAX_MESSAGE_CHARS) throw new Error(`消息不能超过 ${MAX_MESSAGE_CHARS} 字符`)

    const messageId = randomUUID()
    const attachments = this.prepareAttachments(messageId, input.attachments)
    // 纯附件消息合法（对齐前端输入框「文本或附件至少其一」）
    if (!text && !attachments?.length) throw new Error('消息不能为空')
    const silent = input.silent === true || isInternalCollaborationNotificationText(text)
    this.repository.dedupePendingOutbound(channelId, this.now())
    const runId = input.scopeRunId?.trim() || this.scopeRunId
    const holdSessionToken = input.holdSessionToken?.trim() || undefined
    const message = this.repository.enqueueOutbound(
      channelId, text, this.now(), attachments, silent, runId, { holdSessionToken }
    )
    const commandId = randomUUID()
    const entry: ConversationEntry = {
      id: `outbox:${message.id}`,
      channelId,
      role: 'user',
      text: message.text,
      timestamp: message.createdAt,
      deliveredAt: message.deliveredAt,
      heldForNextSession: message.holdSessionToken ? true : undefined,
      status: 'complete',
      source: 'desktop',
      commandId,
      attachments: message.attachments,
      silent: silent ? true : undefined
    }
    if (silent) this.storeCommandReceipt(entry)
    else this.appendEntry(entry)
    return { commandId }
  }

  private outboundIdOf(entryId: string): string {
    const id = String(entryId ?? '').trim()
    return id.startsWith('outbox:') ? id.slice('outbox:'.length) : ''
  }

  /** 撤回仍在队列中的用户消息：SQLite 软删除 + 时间线立即移除；已投递/不存在返回 false。 */
  withdrawQueuedMessage(channelId: string, entryId: string): boolean {
    const outboundId = this.outboundIdOf(entryId)
    if (!outboundId) return false
    if (!this.repository.withdrawOutbound(outboundId, this.now())) return false
    const key = String(channelId).trim()
    const entries = this.conversations.get(key)
    if (entries?.some((entry) => entry.id === entryId)) {
      this.conversations.set(key, entries.filter((entry) => entry.id !== entryId))
    }
    this.sessionCache.delete(key)
    this.emit()
    return true
  }

  /** 解除「等待新会话」保持位：消息回到普通排队，当前会话下一次轮询即可取走。 */
  releaseQueuedMessage(channelId: string, entryId: string): boolean {
    const outboundId = this.outboundIdOf(entryId)
    if (!outboundId) return false
    if (!this.repository.releaseOutboundHold(outboundId)) return false
    const key = String(channelId).trim()
    const entries = this.conversations.get(key)
    if (entries) {
      this.conversations.set(key, entries.map((entry) => (
        entry.id === entryId && entry.heldForNextSession ? { ...entry, heldForNextSession: undefined } : entry
      )))
    }
    this.emit()
    return true
  }

  /**
   * 附件入队前处理（协议定稿）：
   * - data base64 小文件（≤2MB/个、合计 ≤8MB、≤8 个）落盘到 channel-attachments/<messageId>/，
   *   落盘后清掉 data 只留 path；MCP 投递阶段会按文件类型读取 path，图片转 MCP image block，
   *   文本/小型二进制文件按内联附件格式投递；
   * - path 绝对路径引用不复制不落盘，Agent 直接读原文件；
   * - 图片保留 data: 预览 URL 供 UI 缩略展示。
   */
  private prepareAttachments(messageId: string, input?: MessageAttachment[]): MessageAttachment[] | undefined {
    if (!input?.length) return undefined
    if (input.length > CHANNEL_ATTACHMENT_MAX_COUNT) {
      throw new Error(`附件最多 ${CHANNEL_ATTACHMENT_MAX_COUNT} 个`)
    }
    let totalBytes = 0
    const usedNames = new Set<string>()
    return input.map((attachment, index) => {
      const name = uniqueAttachmentName(
        String(attachment.name || `附件 ${index + 1}`).replace(/[/\\]/g, '_').slice(0, 120),
        usedNames
      )
      // MIME 兜底嗅探：扩展名可确认图片时纠正空/万金油声明（含路径引用附件）。
      const mimeType = sniffedAttachmentMimeType(name, String(attachment.mimeType || '')).slice(0, 120)
      const previewUrl = typeof attachment.previewUrl === 'string' && attachment.previewUrl.length <= 4_000_000
        ? attachment.previewUrl
        : undefined
      if (attachment.data) {
        const bytes = Buffer.from(String(attachment.data), 'base64')
        if (bytes.length > CHANNEL_ATTACHMENT_MAX_FILE_BYTES) {
          throw new Error(`附件「${name}」超过 ${Math.round(CHANNEL_ATTACHMENT_MAX_FILE_BYTES / 1024 / 1024)} MB，请改用路径引用`)
        }
        totalBytes += bytes.length
        if (totalBytes > CHANNEL_ATTACHMENT_MAX_TOTAL_BYTES) {
          throw new Error(`附件总大小超过 ${Math.round(CHANNEL_ATTACHMENT_MAX_TOTAL_BYTES / 1024 / 1024)} MB`)
        }
        const directory = join(this.attachmentRoot(), messageId)
        mkdirSync(directory, { recursive: true })
        const path = join(directory, name)
        writeFileSync(path, bytes)
        return {
          id: String(attachment.id || randomUUID()),
          name,
          mimeType,
          size: bytes.length,
          path,
          previewUrl: previewUrl ?? (mimeType.startsWith('image/') ? `data:${mimeType};base64,${attachment.data}` : undefined)
        }
      }
      if (attachment.path) {
        return {
          id: String(attachment.id || randomUUID()),
          name,
          mimeType,
          size: Math.max(0, Math.round(Number(attachment.size) || 0)),
          path: String(attachment.path),
          previewUrl
        }
      }
      throw new Error(`附件「${name}」缺少内容：data（base64）与 path（路径引用）至少提供一个`)
    })
  }

  private attachmentRoot(): string {
    return this.repository.path === ':memory:'
      ? join(tmpdir(), 'sg-team-channel-attachments')
      : join(dirname(this.repository.path), 'channel-attachments')
  }

  /** 会话域切换（新 TeamRun）：清空时间线与 live 过程，丢弃域前的未消费回复。 */
  resetScope(runId: string, startedAt: number): void {
    this.scopeRunId = runId.trim()
    this.scopeStartedAt = startedAt
    this.repository.beginScope(this.scopeRunId, startedAt, this.now())
    this.conversations.clear()
    this.commandReceipts.clear()
    this.sessionCache.clear()
    for (const reply of this.repository.listUnconsumedReplies()) {
      if (reply.createdAt + CONVERSATION_SCOPE_CLOCK_SKEW_MS < startedAt) {
        this.repository.markReplyConsumed(reply.id)
      }
    }
    this.hydrateScope()
    this.emit()
  }

  /**
   * TeamRun 结束：退役本轮未投递出站消息，幂等且保留历史审计。
   * 已投递消息的回复同步守门不在此时清除——run 状态切换不等于回复契约关闭，
   * Agent 随后的 record_reply 仍须以 visible=1 + 精确 outboundId 落库收尾
   * （守门由 record_reply 关闭，或新 run 的 beginScope 硬隔离清空）。
   */
  completeScope(completedAt = this.now()): void {
    this.repository.retireScopeBefore(completedAt + 1, completedAt)
    this.commandReceipts.clear()
    this.sessionCache.clear()
    this.emit()
  }

  /** 轮询入站回复并转入会话时间线（幂等：消费即标记）。 */
  pollReplies(): void {
    const replies = this.repository.listUnconsumedReplies()
    for (const reply of replies) {
      if (this.scopeStartedAt !== undefined
        && reply.createdAt + CONVERSATION_SCOPE_CLOCK_SKEW_MS < this.scopeStartedAt) {
        this.repository.markReplyConsumed(reply.id)
        continue
      }
      const entry = this.entryFromReply(reply)
      if (entry) this.appendEntry(entry)
      this.repository.markReplyConsumed(reply.id)
    }
  }

  /** 重启/切换域后从 SQLite 回放本轮可见消息，避免 UI 会话只依赖内存 Map。 */
  private hydrateScope(): void {
    const threshold = this.scopeStartedAt === undefined
      ? 0
      : Math.max(0, this.scopeStartedAt - CONVERSATION_SCOPE_CLOCK_SKEW_MS)
    const embeddedChannels = new Set(this.repository.listEmbeddedChannels())
    if (!embeddedChannels.size) return
    const limit = MAX_ENTRIES_PER_CHANNEL * Math.max(1, embeddedChannels.size)
    const byChannel = new Map<string, ConversationEntry[]>()

    const push = (entry: ConversationEntry): void => {
      if (!embeddedChannels.has(entry.channelId)) return
      const entries = byChannel.get(entry.channelId) ?? []
      if (entries.some((candidate) => isRecentDuplicateEntry(candidate, entry))) return
      entries.push(entry)
      byChannel.set(entry.channelId, entries)
    }

    for (const message of this.repository.listOutboundSince(threshold, limit)) {
      const entry = this.entryFromOutbound(message)
      if (entry) push(entry)
    }
    for (const reply of this.repository.listRepliesSince(threshold, limit)) {
      if (!embeddedChannels.has(reply.channelId)) continue
      const entry = this.entryFromReply(reply)
      if (entry) push(entry)
      if (reply.consumedAt === undefined) this.repository.markReplyConsumed(reply.id, this.now())
    }

    this.conversations.clear()
    for (const [channelId, entries] of byChannel) {
      this.conversations.set(channelId, entries
        .sort((left, right) => (
          left.timestamp - right.timestamp
          || this.timelineRoleOrder(left.role) - this.timelineRoleOrder(right.role)
          || left.id.localeCompare(right.id)
        ))
        .slice(-MAX_ENTRIES_PER_CHANNEL))
    }
  }

  private timelineRoleOrder(role: ConversationEntry['role']): number {
    if (role === 'user') return 0
    if (role === 'assistant') return 1
    if (role === 'system') return 2
    return 3
  }

  private entryFromOutbound(message: ChannelOutboundMessage): ConversationEntry | undefined {
    if (message.silent || isInternalCollaborationNotificationText(message.text)) return undefined
    // 用户撤回的消息不回放：它从未投递，留在时间线只会像一条永远排队的消息。
    if (message.withdrawnAt !== undefined) return undefined
    return {
      id: `outbox:${message.id}`,
      channelId: message.channelId,
      role: 'user',
      text: message.text,
      timestamp: message.createdAt,
      deliveredAt: message.deliveredAt,
      heldForNextSession: message.deliveredAt === undefined && message.holdSessionToken ? true : undefined,
      status: 'complete',
      source: 'desktop',
      attachments: message.attachments
    }
  }

  private entryFromReply(reply: ChannelInboundReply): ConversationEntry | undefined {
    if (reply.visible === false) return undefined
    return {
      id: `reply:${reply.id}`,
      channelId: reply.channelId,
      role: 'assistant',
      text: visibleConversationText(reply.content),
      timestamp: reply.createdAt,
      status: 'complete',
      source: 'cursor',
      replyToEntryId: reply.outboundId ? `outbox:${reply.outboundId}` : undefined,
      processBlocks: reply.processBlocks,
      processTruncatedItemCount: reply.processTruncatedItemCount,
      turn: reply.processTurn
    }
  }

  /**
   * 把主进程捕获的 Cursor 原生过程持久绑定到已落库回复：
   * SQLite 持久化（重启后 entryFromReply 水合恢复过程卡）+ 内存会话缓存同步。
   * 返回 true 仅表示 SQLite 写入成功；行不存在时 false，由调用方按快照重试。
   */
  attachProcessToReply(entryId: string, process: LiveProcessState, replyToEntryId?: string): boolean {
    const replyId = entryId.startsWith('reply:') ? entryId.slice('reply:'.length) : ''
    const outboundId = replyToEntryId?.startsWith('outbox:') ? replyToEntryId.slice('outbox:'.length) : undefined
    if (!replyId || !process.blocks.length) return false
    const persisted = this.repository.attachReplyProcess({
      replyId,
      turn: process.turn,
      blocks: process.blocks,
      truncatedItemCount: process.truncatedItemCount,
      outboundId
    })
    if (!persisted) return false
    for (const [channelId, entries] of this.conversations) {
      const index = entries.findIndex((entry) => entry.id === entryId)
      if (index < 0) continue
      const next = [...entries]
      next[index] = {
        ...next[index]!,
        processBlocks: process.blocks,
        processTruncatedItemCount: process.truncatedItemCount,
        turn: process.turn,
        replyToEntryId: replyToEntryId ?? next[index]!.replyToEntryId
      }
      this.conversations.set(channelId, next)
      return true
    }
    return true
  }

  start(intervalMs = DEFAULT_POLL_MS): void {
    this.stop()
    this.hydratePersistedScope()
    this.compactPendingOutbound()
    this.pollReplies()
    this.timer = setInterval(() => {
      if (this.polling) return
      this.polling = true
      try {
        this.compactPendingOutbound()
        const deliveryChanged = this.refreshOutboundDeliveries()
        this.pollReplies()
        this.emitPresenceFlips()
        if (deliveryChanged) this.emit()
      } finally {
        this.polling = false
      }
    }, Math.max(250, intervalMs))
    this.timer.unref?.()
  }

  /** 把 MCP 进程写入的 delivered_at 同步到内存时间线，作为虚拟回合的权威边界。 */
  private refreshOutboundDeliveries(): boolean {
    if (this.scopeStartedAt === undefined || !this.conversations.size) return false
    const outbound = new Map<string, ChannelOutboundMessage>(this.repository
      .listOutboundSince(Math.max(0, this.scopeStartedAt - CONVERSATION_SCOPE_CLOCK_SKEW_MS),
        MAX_ENTRIES_PER_CHANNEL * Math.max(1, this.conversations.size))
      .map((message) => [`outbox:${message.id}`, message] as const))
    let changed = false
    for (const [channelId, entries] of this.conversations) {
      let next = entries
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]
        if (!entry || entry.role !== 'user' || entry.source !== 'desktop' || entry.deliveredAt !== undefined) continue
        const row = outbound.get(entry.id)
        const deliveredAt = row?.deliveredAt
        if (deliveredAt === undefined) continue
        if (next === entries) next = [...entries]
        // 投递即结束保持位（新会话已取走）：时间线不再显示「等待新会话」。
        next[index] = { ...entry, deliveredAt, heldForNextSession: undefined }
      }
      if (next !== entries) {
        this.conversations.set(channelId, next)
        changed = true
      }
    }
    return changed
  }

  private compactPendingOutbound(): void {
    for (const channelId of this.repository.listEmbeddedChannels()) {
      this.repository.dedupePendingOutbound(channelId, this.now())
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * 重启水合：channel_scope 是上一进程持久化的事实源。内存时间线此前只在
   * 「运行中 run 切换」时经 resetScope 水合——应用重启后无论 run 进行中还是
   * 已结束，会话页都会空白（数据在 SQLite 里却不读）。start() 时按持久化
   * 域回放本轮可见消息，processBlocks 随回复一并恢复。
   */
  private hydratePersistedScope(): void {
    const scope = this.repository.currentScope()
    if (!scope) return
    this.scopeRunId = scope.runId
    this.scopeStartedAt = scope.startedAt
    this.hydrateScope()
  }

  /**
   * 该通道时间线中是否已存在该文本的完整助手回复（跨来源文本身份比对）。
   * 供转录兜底注入前判断：record_reply 已落库的回复不需要兜底展示。
   */
  hasPersistedAssistantText(channelId: string, text: string): boolean {
    const identity = conversationTextIdentity(text)
    if (!identity) return true
    const entries = this.conversations.get(String(channelId).trim())
    return Boolean(entries?.some((entry) => (
      entry.role === 'assistant'
      && entry.status === 'complete'
      && conversationTextIdentity(entry.text) === identity
    )))
  }

  subscribe(listener: RelayListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 把内嵌通道数据合并进桥快照：会话时间线按通道覆盖，
   * sessions 用 presence 重建（保留插件投影不感知的内嵌通道）。
   */
  applyTo(snapshot: DesktopSnapshot): DesktopSnapshot {
    const embedded = this.embeddedChannels()
    const commandReceipts = this.commandReceiptsSnapshot(snapshot.commandReceipts)
    const commandReceiptsChanged = commandReceipts !== snapshot.commandReceipts
    if (!embedded.length) {
      if (!commandReceiptsChanged) return snapshot
      return {
        ...snapshot,
        ...(commandReceipts ? { commandReceipts } : {})
      }
    }
    const now = this.now()
    const conversations = { ...snapshot.conversations }
    const sessionByChannel = new Map(snapshot.sessions.map((session) => [session.channelId, session]))
    let changed = false

    for (const channelId of embedded) {
      const entries = this.conversations.get(channelId)
      if (entries?.length) {
        // 结构共享：直接挂内部数组引用（只有 appendEntry 才会新建数组），
        // 未变通道引用恒定——渲染层 memo 才能吃到红利
        conversations[channelId] = entries
        changed = true
      }
      const presence = this.repository.getPresence(channelId)
      const queueDepth = this.repository.countPendingOutbound(channelId)
      const previous = sessionByChannel.get(channelId)
      const session = this.sessionFor(channelId, presence, queueDepth, previous, now)
      sessionByChannel.set(channelId, session)
      changed = true
    }
    if (!changed && !commandReceiptsChanged) return snapshot
    return {
      ...snapshot,
      sessions: [...sessionByChannel.values()]
        .sort((left, right) => Number(left.channelId) - Number(right.channelId) || left.channelId.localeCompare(right.channelId)),
      conversations,
      ...(commandReceipts ? { commandReceipts } : {})
    }
  }

  /** 静默消息的投递回执快照：只给调度器对账，不展示给用户。 */
  private commandReceiptsSnapshot(base?: Record<string, ConversationEntry>): Record<string, ConversationEntry> | undefined {
    if (!this.commandReceipts.size) return base
    return { ...(base ?? {}), ...Object.fromEntries(this.commandReceipts) }
  }

  /**
   * 按通道增量重建 session：fingerprint（presence 关键字段 + 队列深度 + online 判定
   * + 上游投影字段）命中即复用缓存引用。online 依赖 now（活性窗口翻转）参与指纹；
   * 「Ns 前」活性文本随引用复用静止，翻转瞬间随指纹变化刷新——展示语义不退化。
   */
  private sessionFor(
    channelId: string,
    presence: ChannelPresence | undefined,
    queueDepth: number,
    previous: AgentSession | undefined,
    now: number
  ): AgentSession {
    // 分相活性：processing/need_reply_sync 表示 Agent 已取走消息正在执行——
    // 长任务期间按协议不碰 MCP，presence 停刷属正常（证据缺失），给 5 分钟宽限；
    // 更长任务必须由上层 Cursor 遥测的正面活动证据续命，不能仅凭旧 phase 假在线。
    // waiting/keepalive 是「正在长轮询」的声称——沉默超 120s 即与声称矛盾，严格判离线。
    const online = isPresenceOnline(presence, now)
    const fingerprint = [
      presence?.lastSeenAt ?? 0,
      presence?.waiting ? 1 : 0,
      presence?.connectionPhase ?? '',
      presence?.runtimeActiveAt ?? 0,
      presence?.updatedAt ?? 0,
      queueDepth,
      online ? 1 : 0,
      previous?.id ?? '',
      previous?.displayName ?? '',
      previous?.roleName ?? '',
      previous?.currentTask ?? '',
      previous?.workingFiles?.length ?? 0,
      'queued',
      online ? '' : (previous?.disconnectedAt ?? presence?.updatedAt ?? '')
    ].join('|')
    const cached = this.sessionCache.get(channelId)
    if (cached?.fingerprint === fingerprint) return cached.session
    // 终止相位投影 stopped 的条件与 isPresenceOnline 的读取侧守门一致：
    // 未被更晚 CDP 生命证据推翻的明确终止，才构成清扫器认可的死亡证据。
    const runtimeStopped = presence !== undefined
      && isExplicitlyStoppedPhase(presence.connectionPhase)
      && (presence.runtimeActiveAt ?? 0) <= presence.lastSeenAt
    const session: AgentSession = {
      id: previous?.id ?? `sg-channel:${channelId}`,
      channelId,
      generation: previous?.generation ?? 0,
      displayName: previous?.displayName ?? `SG Team CH-${channelId}`,
      roleName: previous?.roleName ?? '未绑定外置团队',
      status: presence ? sessionStatusOf(presence, online) : 'offline',
      currentTask: previous?.currentTask ?? '',
      disconnectedAt: online ? undefined : previous?.disconnectedAt ?? presence?.updatedAt,
      lastSeenAt: presence?.lastSeenAt,
      queueDepth,
      connectionPhase: presence?.connectionPhase ?? '',
      pendingOutboundId: presence?.pendingOutboundId,
      pendingReplySyncSince: presence?.pendingReplySyncSince,
      online,
      connected: online,
      runtimeEvidence: runtimeStopped
        ? 'stopped'
        : online ? 'active' : 'suspected',
      deliveryMode: 'queued',
      waiting: online && (presence?.waiting ?? false),
      workingFiles: previous?.workingFiles ?? [],
      healthEvidence: this.healthEvidenceOf(presence, online, now)
    }
    this.sessionCache.set(channelId, { fingerprint, session })
    return session
  }

  private healthEvidenceOf(presence: ChannelPresence | undefined, online: boolean, now: number): string[] {
    if (!presence) return ['内嵌通道已注册，等待 Agent 首次调用']
    const evidence = [
      online
        ? `内嵌 MCP 活性正常（${Math.max(0, Math.round((now - presence.lastSeenAt) / 1_000))}s 前）`
        : `内嵌 MCP 活性缺失（${Math.max(0, Math.round((now - presence.lastSeenAt) / 1_000))}s 未调用）`
    ]
    if (presence.waiting) evidence.push('check_messages 正在待命')
    // CDP 生成证据只在新鲜时宣称「生成中」：processing 宽限窗内旧证据只证明
    // 「近期生成过」，不得把 5 分钟前的观测说成正在生成（误导用户）。
    if (presence.runtimeActiveAt !== undefined && now - presence.runtimeActiveAt <= 60_000) {
      evidence.push(`CDP 运行时确认生成中（${Math.max(0, Math.round((now - presence.runtimeActiveAt) / 1_000))}s 前）`)
    }
    if (presence.connectionPhase) evidence.push(`连接阶段：${presence.connectionPhase}`)
    if (presence.pendingReplySyncSince !== undefined) evidence.push('等待 Agent record_reply 同步')
    return evidence
  }

  private appendEntry(entry: ConversationEntry): void {
    const current = this.conversations.get(entry.channelId) ?? []
    if (current.some((candidate) => isRecentDuplicateEntry(candidate, entry))) return
    const entries = [...current, entry].slice(-MAX_ENTRIES_PER_CHANNEL)
    this.conversations.set(entry.channelId, entries)
    this.emit()
  }

  private storeCommandReceipt(entry: ConversationEntry): void {
    if (!entry.commandId) return
    this.commandReceipts.set(entry.commandId, entry)
    while (this.commandReceipts.size > MAX_ENTRIES_PER_CHANNEL) {
      const oldest = this.commandReceipts.keys().next().value
      if (!oldest) break
      this.commandReceipts.delete(oldest)
    }
    this.emit()
  }

  /**
   * 活性翻转自调度：online 由「now - lastSeenAt」推导，阈值跨越瞬间没有任何数据
   * 变化，纯事件驱动的 emit 不会触发——不扫查的话界面会永久停在旧的在线状态。
   * 每秒比对缓存会话的 online 位，任一通道翻转即 emit（下游 getSnapshot 重算推送）。
   */
  private emitPresenceFlips(): void {
    const now = this.now()
    let flipped = false
    for (const channelId of this.repository.listEmbeddedChannels()) {
      const cached = this.sessionCache.get(channelId)
      if (!cached) continue
      if (cached.session.online !== isPresenceOnline(this.repository.getPresence(channelId), now)) {
        flipped = true
        break
      }
    }
    if (flipped) this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
