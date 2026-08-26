import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentSession } from '../domain/agent-session'
import {
  CHANNEL_ATTACHMENT_MAX_COUNT,
  CHANNEL_ATTACHMENT_MAX_FILE_BYTES,
  CHANNEL_ATTACHMENT_MAX_TOTAL_BYTES,
  CHANNEL_PRESENCE_STALE_MS,
  CHANNEL_PROCESSING_STALE_MS,
  isInternalCollaborationNotificationText,
  isProcessingPhase,
  type ChannelInboundReply,
  type ChannelOutboundMessage,
  type ChannelPresence
} from '../domain/channel-message'
import {
  normalizeEscapedNewlines,
  normalizeProcessBlockText,
  type ConversationEntry,
  type MessageAttachment,
  type ProcessBlock
} from '../domain/conversation-entry'
import type { SqliteChannelMessageRepository } from '../infrastructure/channel-messages/sqlite-channel-message-repository'
import type { LiveProcessState } from '../shared/desktop-api'
import type {
  DesktopSnapshot,
  SendMessageAccepted,
  SendMessageInput
} from '../shared/desktop-api'

const MAX_ENTRIES_PER_CHANNEL = 500
const MAX_MESSAGE_CHARS = 100_000
const DEFAULT_POLL_MS = 1_000
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

function sessionStatusOf(presence: ChannelPresence, online: boolean): AgentSession['status'] {
  const phase = presence.connectionPhase.toLowerCase()
  if (phase.includes('reviv') || phase.includes('recover') || phase.includes('reconnect')) return 'reviving'
  if (phase.includes('review')) return 'review'
  if (phase.includes('block') || phase.includes('approval') || phase.includes('need_')) return 'blocked'
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
 * 职责对齐原 QingtianBridge 的 WS 链路，但后端是群枢 SQLite：
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
  private readonly liveProcess = new Map<string, LiveProcessState & { fingerprint: string }>()
  /** sessions 增量缓存：fingerprint 命中即复用引用（结构共享，渲染层 memo 红利）。 */
  private readonly sessionCache = new Map<string, { fingerprint: string; session: AgentSession }>()
  private timer?: ReturnType<typeof setInterval>
  private polling = false
  private scopeStartedAt?: number

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

  /** 发送改道入口：仅接受内嵌通道；入队即视为投递受理（无 WS 回执等待）。 */
  sendMessage(input: SendMessageInput): SendMessageAccepted {
    const channelId = String(input.channelId ?? '').trim()
    const text = String(input.text ?? '').trim()
    if (!/^\d+$/.test(channelId)) throw new Error('通道号无效')
    if (!this.handlesChannel(channelId)) throw new Error(`CH-${channelId} 尚未接入群枢内嵌通道`)
    if (text.length > MAX_MESSAGE_CHARS) throw new Error(`消息不能超过 ${MAX_MESSAGE_CHARS} 字符`)

    const messageId = randomUUID()
    const attachments = this.prepareAttachments(messageId, input.attachments)
    // 纯附件消息合法（对齐前端输入框「文本或附件至少其一」）
    if (!text && !attachments?.length) throw new Error('消息不能为空')
    const silent = input.silent === true || isInternalCollaborationNotificationText(text)
    this.repository.dedupePendingOutbound(channelId, this.now())
    const message = this.repository.enqueueOutbound(channelId, text, this.now(), attachments, silent)
    const commandId = randomUUID()
    const entry: ConversationEntry = {
      id: `outbox:${message.id}`,
      channelId,
      role: 'user',
      text: message.text,
      timestamp: message.createdAt,
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

  /**
   * 附件入队前处理（协议定稿）：
   * - data base64 小文件（≤2MB/个、合计 ≤8MB、≤8 个）落盘到 channel-attachments/<messageId>/，
   *   落盘后清掉 data 只留 path；MCP 投递阶段会按文件类型读取 path，图片转 MCP image block，
   *   文本/小型二进制文件按 qingtian-v2 插件兼容格式内联；
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
      const mimeType = String(attachment.mimeType || 'application/octet-stream').slice(0, 120)
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
      ? join(tmpdir(), 'qingtian-channel-attachments')
      : join(dirname(this.repository.path), 'channel-attachments')
  }

  /** 会话域切换（新 TeamRun）：清空时间线与 live 过程，丢弃域前的未消费回复。 */
  resetScope(startedAt: number): void {
    this.scopeStartedAt = startedAt
    this.conversations.clear()
    this.commandReceipts.clear()
    this.liveProcess.clear()
    this.sessionCache.clear()
    for (const reply of this.repository.listUnconsumedReplies()) {
      if (reply.createdAt + CONVERSATION_SCOPE_CLOCK_SKEW_MS < startedAt) {
        this.repository.markReplyConsumed(reply.id)
      }
    }
    this.hydrateScope()
    this.emit()
  }

  /** 轮询入站回复并转入会话时间线（幂等：消费即标记）；顺带聚合流式过程事件。 */
  pollReplies(): void {
    const replies = this.repository.listUnconsumedReplies()
    for (const reply of replies) {
      if (this.scopeStartedAt !== undefined
        && reply.createdAt + CONVERSATION_SCOPE_CLOCK_SKEW_MS < this.scopeStartedAt) {
        this.repository.markReplyConsumed(reply.id)
        continue
      }
      this.appendEntry(this.entryFromReply(reply))
      this.repository.markReplyConsumed(reply.id)
    }
    this.pollProcessEvents()
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
      push(this.entryFromReply(reply))
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
    this.pollProcessEvents()
  }

  private timelineRoleOrder(role: ConversationEntry['role']): number {
    if (role === 'user') return 0
    if (role === 'assistant') return 1
    if (role === 'system') return 2
    return 3
  }

  private entryFromOutbound(message: ChannelOutboundMessage): ConversationEntry | undefined {
    if (message.silent || isInternalCollaborationNotificationText(message.text)) return undefined
    return {
      id: `outbox:${message.id}`,
      channelId: message.channelId,
      role: 'user',
      text: message.text,
      timestamp: message.createdAt,
      status: 'complete',
      source: 'desktop',
      attachments: message.attachments
    }
  }

  private entryFromReply(reply: ChannelInboundReply): ConversationEntry {
    const processBlocks = reply.process?.length
      ? reply.process.map(normalizeProcessBlockText)
      : reply.turn
        ? this.repository.listProcessEventsForTurn(reply.channelId, reply.turn).map((event) => normalizeProcessBlockText(event.block))
        : undefined
    return {
      id: `reply:${reply.id}`,
      channelId: reply.channelId,
      role: 'assistant',
      text: visibleConversationText(reply.content),
      timestamp: reply.createdAt,
      status: 'complete',
      source: 'cursor',
      turn: reply.turn,
      processBlocks: processBlocks?.length ? processBlocks : undefined
    }
  }

  /**
   * 聚合未归档过程事件 → liveProcess（每通道取最新活跃 turn）。
   * fingerprint 不变不 emit——1s 轮询下避免对渲染层空推。
   */
  private pollProcessEvents(): void {
    const activeChannels = new Set<string>()
    for (const channelId of this.repository.listEmbeddedChannels()) {
      const events = this.repository.listLiveProcessEvents(channelId)
      if (!events.length) continue
      const latestUpdated = Math.max(...events.map((event) => event.updatedAt))
      const turn = events.find((event) => event.updatedAt === latestUpdated)!.turn
      const turnEvents = events.filter((event) => event.turn === turn)
      // updatedAt 取选中 turn 内的最新事件时间（upsert 翻转实时反映在气泡时间戳上）
      const turnUpdatedAt = Math.max(...turnEvents.map((event) => event.updatedAt))
      const fingerprint = `${turn}:${turnEvents.length}:${turnUpdatedAt}`
      const previous = this.liveProcess.get(channelId)
      activeChannels.add(channelId)
      if (previous?.fingerprint === fingerprint) continue
      this.liveProcess.set(channelId, {
        turn,
        blocks: turnEvents.map((event) => normalizeProcessBlockText(event.block)),
        updatedAt: turnUpdatedAt,
        fingerprint
      })
      this.emit()
    }
    for (const channelId of [...this.liveProcess.keys()]) {
      if (!activeChannels.has(channelId)) {
        this.liveProcess.delete(channelId)
        this.emit()
      }
    }
  }

  start(intervalMs = DEFAULT_POLL_MS): void {
    this.stop()
    this.compactPendingOutbound()
    this.pollReplies()
    this.timer = setInterval(() => {
      if (this.polling) return
      this.polling = true
      try {
        this.compactPendingOutbound()
        this.pollReplies()
      } finally {
        this.polling = false
      }
    }, Math.max(250, intervalMs))
    this.timer.unref?.()
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
    const liveProcess = this.liveProcessSnapshot()
    const commandReceipts = this.commandReceiptsSnapshot(snapshot.commandReceipts)
    const commandReceiptsChanged = commandReceipts !== snapshot.commandReceipts
    if (!embedded.length) {
      if (!liveProcess && !commandReceiptsChanged) return snapshot
      return {
        ...snapshot,
        ...(commandReceipts ? { commandReceipts } : {}),
        ...(liveProcess ? { liveProcess } : {})
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
    if (!changed && !liveProcess && !commandReceiptsChanged) return snapshot
    return {
      ...snapshot,
      sessions: [...sessionByChannel.values()]
        .sort((left, right) => Number(left.channelId) - Number(right.channelId) || left.channelId.localeCompare(right.channelId)),
      conversations,
      ...(commandReceipts ? { commandReceipts } : {}),
      ...(liveProcess ? { liveProcess } : {})
    }
  }

  /** 静默消息的投递回执快照：只给调度器对账，不展示给用户。 */
  private commandReceiptsSnapshot(base?: Record<string, ConversationEntry>): Record<string, ConversationEntry> | undefined {
    if (!this.commandReceipts.size) return base
    return { ...(base ?? {}), ...Object.fromEntries(this.commandReceipts) }
  }

  /** liveProcess 透出（去掉内部 fingerprint 字段）。 */
  private liveProcessSnapshot(): Record<string, LiveProcessState> | undefined {
    if (!this.liveProcess.size) return undefined
    const result: Record<string, LiveProcessState> = {}
    for (const [channelId, state] of this.liveProcess) {
      result[channelId] = { turn: state.turn, blocks: state.blocks, updatedAt: state.updatedAt }
    }
    return result
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
    // 长任务期间按协议不碰 MCP，presence 停刷属正常（证据缺失），用宽松阈值；
    // waiting/keepalive 是「正在长轮询」的声称——沉默超 120s 即与声称矛盾，严格判离线。
    const staleMs = presence && isProcessingPhase(presence.connectionPhase)
      ? CHANNEL_PROCESSING_STALE_MS
      : CHANNEL_PRESENCE_STALE_MS
    const online = presence !== undefined && now - presence.lastSeenAt <= staleMs
    const fingerprint = [
      presence?.lastSeenAt ?? 0,
      presence?.waiting ? 1 : 0,
      presence?.connectionPhase ?? '',
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
    const session: AgentSession = {
      id: previous?.id ?? `qingtian-channel:${channelId}`,
      channelId,
      generation: previous?.generation ?? 0,
      displayName: previous?.displayName ?? `Qunshu CH-${channelId}`,
      roleName: previous?.roleName ?? '未绑定外置团队',
      status: presence ? sessionStatusOf(presence, online) : 'offline',
      currentTask: previous?.currentTask ?? '',
      disconnectedAt: online ? undefined : previous?.disconnectedAt ?? presence?.updatedAt,
      lastSeenAt: presence?.lastSeenAt,
      queueDepth,
      connectionPhase: presence?.connectionPhase ?? '',
      online,
      connected: online,
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

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
