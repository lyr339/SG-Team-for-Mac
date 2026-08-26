/**
 * 晴天通道消息领域模型（一体化 S1）。
 *
 * 通道消息队列替代原 qingtian-v2 插件的文件队列（messages.json）：
 * - 出站（用户 → Agent）：群枢主进程 enqueue，内嵌 MCP server 长轮询取出投递
 * - 入站（Agent → 用户）：Agent 调 record_reply 归档，群枢主进程消费进会话时间线
 * - 活性：MCP server 每次调用刷新 presence，主进程据此投影会话状态
 */

export interface ChannelOutboundMessage {
  id: string
  channelId: string
  seq: number
  text: string
  /** 用户随消息携带的附件（base64 小文件入队前落盘为 path；MCP 投递时再按类型读取为 image/file 内容）。 */
  attachments?: import('./conversation-entry').MessageAttachment[]
  createdAt: number
  deliveredAt?: number
  /** 内部投递消息只用于 Agent 调度/对账，不进入用户可见会话时间线。 */
  silent?: boolean
}

export const INTERNAL_COLLABORATION_NOTIFICATION_PREFIX = '【群枢内部协作通知】'

export function isInternalCollaborationNotificationText(text: string): boolean {
  return text.trimStart().startsWith(INTERNAL_COLLABORATION_NOTIFICATION_PREFIX)
}

/** 附件上限：数量 8 个；单文件 base64 解码后 ≤2 MB；单条消息合计 ≤8 MB。 */
export const CHANNEL_ATTACHMENT_MAX_COUNT = 8
export const CHANNEL_ATTACHMENT_MAX_FILE_BYTES = 2 * 1024 * 1024
export const CHANNEL_ATTACHMENT_MAX_TOTAL_BYTES = 8 * 1024 * 1024

export interface ChannelInboundReply {
  id: string
  channelId: string
  content: string
  title?: string
  groupId?: string
  taskId?: string
  files: string[]
  /** Agent 随回复归档的过程区块（工具调用 / 思考 / 命令执行），透出到会话时间线展示。 */
  process?: import('./conversation-entry').ProcessBlock[]
  /** 流式过程回合标识：record_process 上报的 turn，归档后用于从事件表重建 processBlocks。 */
  turn?: string
  createdAt: number
  consumedAt?: number
}

/**
 * 流式过程事件（record_process）：Agent 在回合（turn）内按 block.id upsert
 * 过程区块（running→done 状态翻转），relay 轮询透出为 liveProcess 供前端
 * 实时渲染；record_reply 带同 turn 落地后整批 archived，随后定期清理。
 */
export interface ChannelProcessEvent {
  id: string
  channelId: string
  turn: string
  blockId: string
  seq: number
  block: import('./conversation-entry').ProcessBlock
  createdAt: number
  updatedAt: number
  archived: boolean
}

/** 单通道未归档过程事件上限（超出拒绝写入，防止失控堆积）。 */
export const CHANNEL_PROCESS_EVENTS_MAX_PENDING = 500

/** 已归档过程事件的保留时长：超过即在下一次写入时顺手清理（零额外交互）。 */
export const CHANNEL_PROCESS_EVENTS_ARCHIVED_TTL_MS = 10 * 60_000

/**
 * 通道活性快照。语义对齐插件 heartbeat/waiting/connection 三文件：
 * - lastSeenAt：MCP 进程最近一次工具调用时间（心跳）
 * - waiting：Agent 是否正处于 check_messages 长轮询待命
 * - connectionPhase：waiting / processing / keepalive / need_reply_sync
 * - pendingReplySyncSince：已投递待回复同步的起始时间（回复同步守门）
 */
export interface ChannelPresence {
  channelId: string
  lastSeenAt: number
  waiting: boolean
  connectionPhase: string
  turnCount: number
  deliveredCount: number
  keepaliveRound: number
  pendingReplySyncSince?: number
  pendingGroupChat: boolean
  pendingGroupId?: string
  updatedAt: number
}

/**
 * 活性判定阈值：超过该时长无任何 MCP 工具调用证据即视为离线。
 * 对齐插件 sendUserMessage 的心跳校验窗口（120s）——Agent 长回合
 * 不调用工具的生成过程属正常在岗，阈值必须覆盖该场景。
 */
export const CHANNEL_PRESENCE_STALE_MS = 120_000

/**
 * 「处理中」分相的活性阈值：Agent 取走消息后进入 processing/need_reply_sync，
 * 执行长任务（构建/测试/大型改造）期间按协议不调用任何 MCP 工具，presence
 * 自然停刷——这是证据缺失，不是死亡证据，不能用 120s 心跳窗口误判离线。
 * 该分相放宽到 30 分钟；真死检测由遥测层正面矛盾证据（composer 消失、
 * 转录僵尸判定、租约冲突）承担。
 */
export const CHANNEL_PROCESSING_STALE_MS = 30 * 60_000

/** 连接阶段是否属于「已取走消息、正在处理」（该分相适用宽松活性阈值）。 */
export function isProcessingPhase(connectionPhase: string): boolean {
  const phase = connectionPhase.toLowerCase()
  return phase.includes('process') || phase.includes('need_reply_sync')
}

/** check_messages 长轮询间隔（对齐插件 POLL_INTERVAL_MS）。 */
export const CHANNEL_POLL_INTERVAL_MS = 1_000

/** check_messages 空队列 keepalive 返回间隔（对齐插件默认 60s）。 */
export const CHANNEL_KEEPALIVE_TIMEOUT_MS = 60_000

/**
 * 回复同步守门宽限（对齐插件 REPLY_SYNC_STALE_MS ≈ 290s）：
 * 投递后 Agent 超过该时长仍未 record_reply，自动放行避免死锁。
 */
export const CHANNEL_REPLY_SYNC_STALE_MS = 290_000

/** 同内容连发合并窗口（对齐插件 MERGE_WINDOW_MS 30s）。 */
export const CHANNEL_MERGE_WINDOW_MS = 30_000

/**
 * 出站入队去重窗口：用于防按钮连点、IPC 重试、调度器 tick 重入。
 * 只用于纯文本消息；附件消息不能仅按 text 判重。
 */
export const CHANNEL_OUTBOUND_DEDUPE_WINDOW_MS = CHANNEL_MERGE_WINDOW_MS

/**
 * record_reply 无 turn 时的同内容去重窗口：
 * MCP 客户端超时重试、Agent keepalive 后误补同步、模型重复输出同一回复，
 * 都会把同一轮回复多次入账。窗口内同 (channel_id, content) 视为重复提交，
 * 返回原行不新增。
 */
export const CHANNEL_REPLY_DEDUPE_WINDOW_MS = 5 * 60_000

/** 单通道出站队列上限，防止 Agent 掉线期间无限堆积。 */
export const CHANNEL_OUTBOX_MAX_PENDING = 200

/**
 * 群枢单一 MCP 服务器名（S4）：Cursor 面板只出现一条原生条目，
 * 所有工具以 channel_id 参数区分通道。
 */
export const QUNSHU_MCP_SERVER_NAME = 'qunshu'
/**
 * 合并队首同内容连发（对齐插件 mergeConsecutiveDuplicates 语义）：
 * 队首起连续、内容相同、时间跨度在窗口内的消息合并为一次投递。
 * 返回首条消息与合并条数；调用方据此跳过其余条目。
 *
 * 附件消息一律不参与合并：纯图/文件消息的 text 为空串恒等，
 * 只看文本会把窗口内连发的第二张图静默丢弃（用户视角即丢消息）。
 */
export function mergeConsecutiveDuplicates(
  messages: ChannelOutboundMessage[],
  windowMs = CHANNEL_MERGE_WINDOW_MS
): { head?: ChannelOutboundMessage; mergedCount: number } {
  const head = messages[0]
  if (!head) return { head: undefined, mergedCount: 0 }
  if (head.attachments?.length) return { head, mergedCount: 1 }
  const normalized = head.text.trim()
  let mergedCount = 1
  for (let index = 1; index < messages.length; index += 1) {
    const candidate = messages[index]
    if (!candidate) break
    if (candidate.attachments?.length) break
    if (candidate.text.trim() !== normalized) break
    if (candidate.createdAt - head.createdAt > windowMs) break
    mergedCount += 1
  }
  return { head, mergedCount }
}
