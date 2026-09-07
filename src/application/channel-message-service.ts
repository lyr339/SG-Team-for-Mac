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
  /**
   * 整个 keepalive 周期内存储层始终不可用（拾光桌面端启停时的锁竞争、磁盘异常）。
   * 不抛给 MCP SDK 变成裸的 "database is locked"，而是带 retryable 的结构化结果，
   * 让 Agent 按协议瞬断续接，连续多次才停止。
   */
  | { type: 'storage_unavailable'; message: string; retryable: boolean; failures: number }

/** 连续以 storage_unavailable 收尾多少次后，不再建议 Agent 自动重试。 */
export const CHANNEL_STORAGE_RETRY_LIMIT = 3

/**
 * SQLite 瞬时错误：另一连接持有写锁（拾光桌面端启停时的迁移/关闭）或表级锁。
 * node:sqlite 的错误带 errcode（5 = SQLITE_BUSY，6 = SQLITE_LOCKED）；也兼容仅有文案的错误。
 */
export function isTransientStorageError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const errcode = (error as { errcode?: unknown }).errcode
  if (errcode === 5 || errcode === 6) return true
  const message = String((error as { message?: unknown }).message ?? '')
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(message)
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error'
}

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

interface OpenTurn {
  turnCount: number
  deliveredCount: number
  keepaliveRound: number
}

/**
 * 通道消息服务：承载 check_messages / record_reply 的完整业务语义
 * ，供内嵌 MCP server 进程调用。
 * 主进程只使用 repository 直写/轮询，不经过本服务的长轮询。
 */
export class ChannelMessageService {
  /** 按通道记录连续以 storage_unavailable 收尾的次数；任何一次成功即清零。 */
  private readonly storageFailureStreak = new Map<string, number>()

  constructor(private readonly repository: SqliteChannelMessageRepository) {}

  /**
   * check_messages 长轮询：
   * 1. 顺带提交上轮回复（reply 参数）
   * 2. 回复同步守门：上轮已投递未同步则拒绝（宽限超时自动放行）
   * 3. 轮询出站队列：有消息立即投递（合并同内容连发），空队列超 keepalive 周期返回 keepalive
   *
   * 存储层的每一步都可能在拾光桌面端启停的瞬间撞上锁：单次失败不结束本次调用，
   * 按轮询间隔重试到 keepalive 周期末；周期内始终失败才以 storage_unavailable 收尾。
   * MCP 进程由 Cursor 托管、状态全在 SQLite——桌面端重启本身不会中断这条循环。
   */
  async checkMessages(input: ChannelCheckInput): Promise<ChannelCheckResult> {
    const channelId = String(input.channelId).trim()
    const pollIntervalMs = Math.max(100, input.pollIntervalMs ?? CHANNEL_POLL_INTERVAL_MS)
    const keepaliveTimeoutMs = Math.max(1_000, input.keepaliveTimeoutMs ?? CHANNEL_KEEPALIVE_TIMEOUT_MS)
    const inlineReply = typeof input.reply === 'string' ? input.reply.trim() : ''
    const session = input.session?.trim() || null
    const deadline = Date.now() + keepaliveTimeoutMs

    let turn: OpenTurn | undefined
    let lastError: unknown
    while (!input.signal?.aborted) {
      try {
        if (!turn) {
          const opened = this.openTurn(channelId, inlineReply)
          if (opened.kind === 'gate') return opened.result
          turn = opened.turn
        }
        const delivered = this.deliverPending(channelId, session, turn)
        lastError = undefined
        if (delivered) {
          this.storageFailureStreak.delete(channelId)
          return delivered
        }
      } catch (error) {
        lastError = error
      }
      if (Date.now() >= deadline) break
      const progressed = await sleepWithAbort(input.signal, pollIntervalMs)
      if (!progressed) break
    }

    if (input.signal?.aborted) {
      this.touchQuietly(channelId, { waiting: false, connectionPhase: 'tool_aborted' })
      return { type: 'stopped', reason: 'tool_aborted' }
    }
    if (lastError !== undefined) {
      const failures = (this.storageFailureStreak.get(channelId) ?? 0) + 1
      this.storageFailureStreak.set(channelId, failures)
      return {
        type: 'storage_unavailable',
        message: describeError(lastError),
        retryable: failures < CHANNEL_STORAGE_RETRY_LIMIT,
        failures
      }
    }
    this.storageFailureStreak.delete(channelId)
    const keepaliveRound = (turn?.keepaliveRound ?? 0) + 1
    // keepalive 只是长轮询的周期间隔，Agent 随即会再次进入 check_messages——
    // 保持 waiting=true，避免推理间隙被大厅/launcher 误判为未待命。
    this.touchQuietly(channelId, { waiting: true, connectionPhase: 'keepalive', keepaliveRound })
    return { type: 'keepalive', round: keepaliveRound, turnCount: turn?.turnCount ?? 0 }
  }

  /**
   * 本次调用的开场：顺带回复、心跳与轮次、回复同步守门。可能因存储瞬断抛错，
   * 由 checkMessages 重试；各步幂等（inline reply 有去重窗口，turnCount 以存量 +1 计）。
   */
  private openTurn(
    channelId: string,
    inlineReply: string
  ): { kind: 'gate'; result: ChannelCheckResult } | { kind: 'turn'; turn: OpenTurn } {
    // 顺带提交回复：与 record_reply 同效，并清除守门
    if (inlineReply) this.recordReply({ channelId, content: inlineReply })

    const presence = this.repository.touchPresence(channelId, {
      lastSeenAt: Date.now(),
      waiting: true,
      connectionPhase: 'waiting'
    })
    const turn: OpenTurn = {
      turnCount: presence.turnCount + 1,
      deliveredCount: presence.deliveredCount,
      keepaliveRound: presence.keepaliveRound
    }
    this.repository.touchPresence(channelId, { turnCount: turn.turnCount })

    // 回复同步守门（对齐插件 need_reply_sync 语义）
    let pendingSince = presence.pendingReplySyncSince
    if (!inlineReply && pendingSince !== undefined && this.isSilentGateOrigin(channelId)) {
      this.clearGate(channelId)
      pendingSince = undefined
    }
    if (!inlineReply && pendingSince !== undefined) {
      const stale = Date.now() - pendingSince > CHANNEL_REPLY_SYNC_STALE_MS
      if (!stale) {
        this.repository.touchPresence(channelId, { connectionPhase: 'need_reply_sync', waiting: true })
        return {
          kind: 'gate',
          result: {
            type: 'reply_sync_required',
            message: buildReplySyncRequiredMessage(presence.pendingGroupChat),
            pendingSince
          }
        }
      }
      // 宽限超时：自动放行，避免死锁（对齐插件 reply_sync_timeout_release）
      this.clearGate(channelId)
    }
    return { kind: 'turn', turn }
  }

  /** 一次轮询：刷新心跳、取队首并投递；队列为空返回 undefined。任何一步抛错都由调用方重试。 */
  private deliverPending(channelId: string, session: string | null, turn: OpenTurn): ChannelCheckResult | undefined {
    this.repository.touchPresence(channelId, { lastSeenAt: Date.now(), waiting: true })
    this.repository.dedupePendingOutbound(channelId)
    const pending = this.repository.listPendingOutbound(channelId, { forSession: session })
    if (!pending.length) return undefined
    const { head, mergedCount } = mergeConsecutiveDuplicates(pending)
    if (!head) return undefined
    const silentDelivery = head.silent === true || isInternalCollaborationNotificationText(head.text)
    const deliveredIds = pending.slice(0, mergedCount).map((message) => message.id)
    const remainingQueue = pending.length - mergedCount
    const deliveredAt = Date.now()
    const deliveredCount = turn.deliveredCount + 1
    // 只有用户可见消息需要 record_reply 守门。内部协作通知走 team_* 回执，
    // 若也打开守门，会把静默待命错误地逼成可见 record_reply。
    this.repository.markOutboundDelivered(deliveredIds, deliveredAt, { channelId, patch: {
      waiting: false,
      connectionPhase: 'processing',
      deliveredCount,
      keepaliveRound: 0,
      pendingReplySyncSince: silentDelivery ? null : deliveredAt,
      pendingOutboundId: silentDelivery ? null : head.id,
      pendingGroupChat: false,
      pendingGroupId: null
    } })
    turn.deliveredCount = deliveredCount
    turn.keepaliveRound = 0
    return {
      type: 'delivered',
      message: silentDelivery ? { ...head, silent: true } : head,
      mergedCount,
      remainingQueue,
      turnCount: turn.turnCount,
      deliveredCount: turn.deliveredCount
    }
  }

  private clearGate(channelId: string): void {
    this.repository.touchPresence(channelId, {
      pendingReplySyncSince: null,
      pendingOutboundId: null,
      pendingGroupChat: false,
      pendingGroupId: null
    })
  }

  /** 收尾相位写入尽力而为：存储仍不可用时不能反过来吞掉已决定的返回值。 */
  private touchQuietly(channelId: string, patch: Parameters<SqliteChannelMessageRepository['touchPresence']>[1]): void {
    try {
      this.repository.touchPresence(channelId, patch)
    } catch {
      // 返回值已定；相位由下一次成功的调用纠正。
    }
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
