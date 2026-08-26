import {
  CHANNEL_KEEPALIVE_TIMEOUT_MS,
  CHANNEL_POLL_INTERVAL_MS,
  CHANNEL_REPLY_SYNC_STALE_MS,
  isInternalCollaborationNotificationText,
  mergeConsecutiveDuplicates,
  type ChannelOutboundMessage
} from '../domain/channel-message'
import { buildReplySyncRequiredMessage } from '../domain/channel-delivery-policy'
import type { SqliteChannelMessageRepository } from '../infrastructure/channel-messages/sqlite-channel-message-repository'

export interface ChannelCheckInput {
  channelId: string
  /** Agent 顺带提交的上轮回复（等价于先 record_reply）。 */
  reply?: string
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
 * （对齐 qingtian-v2 插件契约），供内嵌 MCP server 进程调用。
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
        pendingGroupChat: false,
        pendingGroupId: null
      })
    }

    const startedAt = Date.now()
    while (!input.signal?.aborted) {
      this.repository.touchPresence(channelId, { lastSeenAt: Date.now(), waiting: true })
      this.repository.dedupePendingOutbound(channelId)
      const pending = this.repository.listPendingOutbound(channelId)
      if (pending.length > 0) {
        const { head, mergedCount } = mergeConsecutiveDuplicates(pending)
        if (!head) continue
        const silentDelivery = head.silent === true || isInternalCollaborationNotificationText(head.text)
        const deliveredIds = pending.slice(0, mergedCount).map((message) => message.id)
        const remainingQueue = pending.length - mergedCount
        this.repository.markOutboundDelivered(deliveredIds)
        deliveredCount += 1
        keepaliveRound = 0
        // 只有用户可见消息需要 record_reply 守门。内部协作通知走 team_* 回执，
        // 若也打开守门，会把静默待命错误地逼成可见 record_reply。
        this.repository.touchPresence(channelId, {
          waiting: false,
          connectionPhase: 'processing',
          deliveredCount,
          keepaliveRound,
          pendingReplySyncSince: silentDelivery ? null : Date.now(),
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
        this.repository.touchPresence(channelId, {
          waiting: false,
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

  /**
   * record_reply：归档 Agent 完整可见回复（可携带过程区块），并清除回复同步守门。
   * 返回归档记录（含 messageId，对齐插件返回结构）。
   * 流式守门：turn 存在且直带 process，但该 turn 从未 record_process 流式上报时，
   * 附 streamingWarning——直带只是兜底归档，过程中未流式上报的回合界面只能整批
   * 展示（用户视角即断流），提示 Agent 下轮先流式上报再归档。
   */
  recordReply(input: {
    channelId: string
    content: string
    title?: string
    groupId?: string
    taskId?: string
    files?: string[]
    process?: import('../domain/conversation-entry').ProcessBlock[]
    turn?: string
  }) {
    const streamed = input.turn
      ? this.repository.listProcessEventsForTurn(input.channelId, input.turn).length > 0
      : true
    const reply = this.repository.recordReply(input)
    const presence = this.repository.getPresence(input.channelId)
    this.repository.touchPresence(input.channelId, {
      lastSeenAt: Date.now(),
      waiting: false,
      connectionPhase: 'processing',
      pendingReplySyncSince: null,
      pendingGroupChat: false,
      pendingGroupId: null,
      turnCount: presence?.turnCount
    })
    if (!streamed && input.process?.length) {
      return {
        ...reply,
        streamingWarning: '本轮过程块仅随 record_reply 整批归档，界面无法实时流式展示。下轮开始：每个工具调用/关键思考完成后立即 record_process（同 turn 上报，running→done 翻转），收尾 record_reply 只需带同 turn。'
      }
    }
    return reply
  }

  /**
   * record_process：流式上报过程区块（按 block.id upsert，running→done 翻转）。
   * 调用即活性证据——上报过程说明 Agent 正在干活，presence 刷新为 processing 相
   *（长任务活性由此与 record_reply 解耦，不再依赖回复落地才刷活性）。
   */
  recordProcess(input: {
    channelId: string
    turn: string
    block: import('../domain/conversation-entry').ProcessBlock
  }) {
    const event = this.repository.recordProcessEvent(input)
    this.repository.touchPresence(input.channelId, {
      lastSeenAt: Date.now(),
      waiting: false,
      connectionPhase: 'processing'
    })
    return event
  }
}
