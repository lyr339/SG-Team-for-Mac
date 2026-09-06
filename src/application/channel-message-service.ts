import {
  CHANNEL_KEEPALIVE_TIMEOUT_MS,
  CHANNEL_POLL_INTERVAL_MS,
  CHANNEL_REPLY_SYNC_STALE_MS,
  isInternalCollaborationNotificationText,
  mergeConsecutiveDuplicates,
  type ChannelOutboundMessage
} from '../domain/channel-message'
import { buildReplySyncRequiredMessage } from '../domain/channel-delivery-policy'
import { sanitizeModelGeneratedText } from '../domain/model-output-sanitizer'
import type { SqliteChannelMessageRepository } from '../infrastructure/channel-messages/sqlite-channel-message-repository'

export interface ChannelCheckInput {
  channelId: string
  /** Agent 顺带提交的上轮回复（等价于先 record_reply）。 */
  reply?: string
  /**
   * 调用方会话令牌（围栏已放行）。带「等待新会话」保持位的消息只投递给持有不同令牌的
   * 新会话；未携带令牌的旧会话取不到它们。
   */
  session?: string
  signal?: AbortSignal
  keepaliveTimeoutMs?: number
  pollIntervalMs?: number
}

export type ChannelCheckResult =
  | {
      type: 'delivered'
      message: ChannelOutboundMessage
      mergedCount: number
      remainingQueue: number
      turnCount: number
      deliveredCount: number
    }
  | { type: 'keepalive'; round: number; turnCount: number }
  | { type: 'reply_sync_required'; message: string; pendingSince?: number }
  | { type: 'stopped'; reason: string }

function sleepWithAbort(signal: AbortSignal | undefined, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => resolve(true), ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve(false)
    }, { once: true })
  })
}

/**
 * 通道消息服务：承载 check_messages / record_reply 的完整业务语义
 * ，供内嵌 MCP server 进程调用。
 * 主进程只使用 repository 直写/轮询，不经过本服务的长轮询。
 */
export class ChannelMessageService {
  constructor(private readonly repository: SqliteChannelMessageRepository) {}

  /**
   * check_messages 长轮询：
   * 1. 顺带提交上轮回复（reply 参数）
   * 2. 回复同步守门：上轮已投递未同步则拒绝（宽限超时自动放行）
   * 3. 轮询出站队列：有消息立即投递（合并同内容连发），空队列超 keepalive 周期返回 keepalive
   */
  async checkMessages(input: ChannelCheckInput): Promise<ChannelCheckResult> {
    const channelId = String(input.channelId).trim()
    const pollIntervalMs = Math.max(100, input.pollIntervalMs ?? CHANNEL_POLL_INTERVAL_MS)
    const keepaliveTimeoutMs = Math.max(1_000, input.keepaliveTimeoutMs ?? CHANNEL_KEEPALIVE_TIMEOUT_MS)

    // 顺带提交回复：与 record_reply 同效，并清除守门
    const inlineReply = typeof input.reply === 'string' ? input.reply.trim() : ''
    if (inlineReply) {
      this.recordReply({ channelId, content: inlineReply })
    }

    const presence = this.repository.touchPresence(channelId, {
      lastSeenAt: Date.now(),
      waiting: true,
      connectionPhase: 'waiting'
    })
    let turnCount = presence.turnCount + 1
    let deliveredCount = presence.deliveredCount
    let keepaliveRound = presence.keepaliveRound
    this.repository.touchPresence(channelId, { turnCount })

    // 回复同步守门（对齐插件 need_reply_sync 语义）
    let pendingSince = presence.pendingReplySyncSince
    if (!inlineReply && pendingSince !== undefined && this.isSilentGateOrigin(channelId)) {
      this.repository.touchPresence(channelId, {
        pendingReplySyncSince: null,
        pendingOutboundId: null,
        pendingGroupChat: false,
        pendingGroupId: null
      })
      pendingSince = undefined
    }
    if (!inlineReply && pendingSince !== undefined) {
      const stale = Date.now() - pendingSince > CHANNEL_REPLY_SYNC_STALE_MS
      if (!stale) {
        this.repository.touchPresence(channelId, {
          connectionPhase: 'need_reply_sync',
          waiting: true
        })
        return {
          type: 'reply_sync_required',
          message: buildReplySyncRequiredMessage(presence.pendingGroupChat),
          pendingSince
        }
      }
      // 宽限超时：自动放行，避免死锁（对齐插件 reply_sync_timeout_release）
      this.repository.touchPresence(channelId, {
        pendingReplySyncSince: null,
        pendingOutboundId: null,
        pendingGroupChat: false,
        pendingGroupId: null
      })
    }

    const startedAt = Date.now()
    const session = input.session?.trim() || null
    while (!input.signal?.aborted) {
      this.repository.touchPresence(channelId, { lastSeenAt: Date.now(), waiting: true })
      this.repository.dedupePendingOutbound(channelId)
      const pending = this.repository.listPendingOutbound(channelId, { forSession: session })
      if (pending.length > 0) {
        const { head, mergedCount } = mergeConsecutiveDuplicates(pending)
        if (!head) continue
        const silentDelivery = head.silent === true || isInternalCollaborationNotificationText(head.text)
        const deliveredIds = pending.slice(0, mergedCount).map((message) => message.id)
        const remainingQueue = pending.length - mergedCount
        const deliveredAt = Date.now()
        this.repository.markOutboundDelivered(deliveredIds, deliveredAt)
        deliveredCount += 1
        keepaliveRound = 0
        // 只有用户可见消息需要 record_reply 守门。内部协作通知走 team_* 回执，
        // 若也打开守门，会把静默待命错误地逼成可见 record_reply。
        this.repository.touchPresence(channelId, {
          waiting: false,
          connectionPhase: 'processing',
          deliveredCount,
          keepaliveRound,
          pendingReplySyncSince: silentDelivery ? null : deliveredAt,
          pendingOutboundId: silentDelivery ? null : head.id,
          pendingGroupChat: false,
          pendingGroupId: null
        })
        return {
          type: 'delivered',
          message: silentDelivery ? { ...head, silent: true } : head,
          mergedCount,
          remainingQueue,
          turnCount,
          deliveredCount
        }
      }

      if (Date.now() - startedAt >= keepaliveTimeoutMs) {
        keepaliveRound += 1
        // keepalive 只是长轮询的周期间隔，Agent 随即会再次进入 check_messages——
        // 保持 waiting=true，避免推理间隙被大厅/launcher 误判为未待命。
        this.repository.touchPresence(channelId, {
          waiting: true,
          connectionPhase: 'keepalive',
          keepaliveRound
        })
        return { type: 'keepalive', round: keepaliveRound, turnCount }
      }

      const progressed = await sleepWithAbort(input.signal, pollIntervalMs)
      if (!progressed) break
    }

    this.repository.touchPresence(channelId, { waiting: false, connectionPhase: 'tool_aborted' })
    return { type: 'stopped', reason: 'tool_aborted' }
  }

  private isSilentGateOrigin(channelId: string): boolean {
    const origin = this.repository.latestDeliveredOutbound(channelId)
    return Boolean(origin && (origin.silent || isInternalCollaborationNotificationText(origin.text)))
  }

  /** 归档 Agent 完整可见回复；过程流只来自 Cursor 原生事件。 */
  recordReply(input: {
    channelId: string
    content: string
    title?: string
    groupId?: string
    taskId?: string
    files?: string[]
  }) {
    // 模型工具调用标记可能泄漏进 content（生成缺陷）；截断到泄漏点，
    // 不让标记残片进入时间线。泄漏本身由遥测侧的 interrupted 标记承载。
    const sanitized = sanitizeModelGeneratedText(input.content)
    const content = sanitized.leaked ? sanitized.text : input.content
    const presence = this.repository.getPresence(input.channelId)
    // 只有确实由 check_messages 投递过“用户可见消息”的回合，record_reply 才进入用户时间线。
    // 启动回执、team_* 收件箱处理、keepalive 误回复等后台同步会保留落库/消费语义，但不污染会话页。
    const visible = presence?.pendingReplySyncSince !== undefined
    const outboundId = visible
      ? presence?.pendingOutboundId
        ?? this.repository.latestDeliveredOutbound(input.channelId, { visibleOnly: true })?.id
      : undefined
    const reply = this.repository.recordReply({ ...input, content, visible, outboundId })
    this.repository.touchPresence(input.channelId, {
      lastSeenAt: Date.now(),
      waiting: false,
      connectionPhase: 'processing',
      pendingReplySyncSince: null,
      pendingOutboundId: null,
      pendingGroupChat: false,
      pendingGroupId: null,
      turnCount: presence?.turnCount
    })
    const contentWarning = sanitized.leaked
      ? '检测到工具调用标记泄漏，回复内容已截断到泄漏点之前。'
      : undefined

    return contentWarning ? { ...reply, contentWarning } : reply
  }

}
