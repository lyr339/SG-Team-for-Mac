/**
 * 拾光通道消息领域模型（一体化 S1）。
 *
 * 通道消息队列替代原 qingtian-v2 插件的文件队列（messages.json）：
 * - 出站（用户 → Agent）：拾光主进程 enqueue，内嵌 MCP server 长轮询取出投递
 * - 入站（Agent → 用户）：Agent 调 record_reply 归档，拾光主进程消费进会话时间线
 * - 活性：MCP server 每次调用刷新 presence，主进程据此投影会话状态
 */

export interface ChannelOutboundMessage {
  id: string
  /** 所属 TeamRun；用于换轮硬隔离。旧版本迁移行可能缺失。 */
  runId?: string
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

export const INTERNAL_COLLABORATION_NOTIFICATION_PREFIX = '【拾光内部协作通知】'

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
  /** false 表示后台/内部同步回复：落库留痕并消费，但不进入用户可见会话时间线。 */
  visible?: boolean
  createdAt: number
  consumedAt?: number
  /** 主进程捕获的 Cursor 原生过程（持久绑定到该回复，重启后恢复过程卡）。 */
  processBlocks?: import('./conversation-entry').ProcessBlock[]
  processTurn?: string
  processTruncatedItemCount?: number
}

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
  /**
   * CDP 运行时探测最近一次确认「正在生成」的时间（主进程写入）。
   * 与 lastSeenAt（MCP 工具调用心跳）是两条独立的生命证据流：
   * Agent 跑长任务期间按协议不触碰 MCP，但 Cursor 侧 isGenerating
   * 持续为真——该证据写回 presence 让 processing 窗口持续续命。
   */
  runtimeActiveAt?: number
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
 * 该分相只放宽到 5 分钟，与 Cursor 遥测的长任务宽限一致。超过窗口后，
 * 必须由转录增长或有效运行租约等正面证据继续保活；没有新证据就先判离线，
 * 后续 MCP 调用或 Composer 活动会自动复活。不能把 processing 字段本身当成
 * 30 分钟存活证明，否则 Agent 已退出后会长期假在线。
 */
export const CHANNEL_PROCESSING_STALE_MS = 5 * 60_000

/** 连接阶段是否属于「已取走消息、正在处理」（该分相适用宽松活性阈值）。 */
export function isProcessingPhase(connectionPhase: string): boolean {
  const phase = connectionPhase.toLowerCase()
  return phase.includes('process') || phase.includes('need_reply_sync')
}

/** Cursor 主进程给出的明确终止相位；与“心跳暂时没刷新”严格区分。 */
export function isExplicitlyStoppedPhase(connectionPhase: string): boolean {
  const phase = connectionPhase.toLowerCase()
  return phase.includes('cursor_stopped') || phase.includes('tool_aborted')
}

/**
 * 终止相位的中转复活相：新 TeamRun 作用域开启、或更新的 MCP 心跳推翻
 * 死亡证据后进入。上一轮残留的 cursor_stopped/tool_aborted 若不清除，
 * 新 run 的 Agent 签到后仍被永久判死（2026-09-01 事故：14:19:52 签到、
 * 14:19:58 即被清扫器判定主控终止）。
 */
export const PRESENCE_REVIVED_PHASE = 'reviving'

/**
 * presence 活性判定的唯一权威（主进程 relay 与 MCP server 共用，跨进程一致）：
 * 1. 明确终止相位（cursor_stopped/tool_aborted）且未被更新的生命证据推翻 → 离线；
 * 2. processing/need_reply_sync 分相：5 分钟宽限窗口（长任务在途）；
 * 3. 其余相位（waiting/keepalive/reviving 等）严格 120s 窗口。
 * 两个窗口的证据基准都是 max(lastSeenAt, runtimeActiveAt)：MCP 工具调用心跳与
 * CDP 运行时探测（生成期 150ms fast loop 直采）是两条独立生命证据流，取较新
 * 者——Agent 长回合生成中不调用任何 MCP 工具时，CDP 证据单独维持在线，
 * 通道间不再互相误判离线。
 *
 * 模型不变式：死亡证据必须新鲜于生命证据。写入层（touchPresence 心跳复活 /
 * touchRuntimeActivity 活动复活 / markCursorStopped 新鲜度守门）已保证持久的
 * 终止相位不被更晚的生命证据压制；本函数对「终止相位 + 更新 runtimeActiveAt」
 * 的组合再做一次读取侧防御，兜底跨进程写序竞争。
 */
export function isPresenceOnline(presence: ChannelPresence | undefined, now: number): boolean {
  if (!presence) return false
  const runtimeActiveAt = presence.runtimeActiveAt ?? 0
  if (isExplicitlyStoppedPhase(presence.connectionPhase)) {
    // 终止相位之后 CDP 又观测到生成：死亡证据已过时，按时间窗口继续判定。
    if (runtimeActiveAt <= presence.lastSeenAt) return false
  }
  const lastLifeAt = Math.max(presence.lastSeenAt, runtimeActiveAt)
  const staleMs = isProcessingPhase(presence.connectionPhase)
    ? CHANNEL_PROCESSING_STALE_MS
    : CHANNEL_PRESENCE_STALE_MS
  return now - lastLifeAt <= staleMs
}

/**
 * 已取走真实消息的执行租约。
 *
 * processing / need_reply_sync 期间 Agent 正在推理、跑命令或生成回复，协议上本来
 * 就不会持续调用 check_messages，也可能暂时处理不了 team_ping。只要没有
 * cursor_stopped/tool_aborted 这类正面终止证据，这个相位就必须受保护，不能仅凭
 * lastSeenAt 超时触发主控接管、角色交接或整轮结束。
 */
export function hasInFlightExecution(session: { connectionPhase?: string } | undefined): boolean {
  const phase = session?.connectionPhase ?? ''
  return isProcessingPhase(phase) && !isExplicitlyStoppedPhase(phase)
}

/** 只有正面终止证据才允许自动接管；普通租约超时只能进入 suspected。 */
export function hasConfirmedRuntimeStop(
  session: { connectionPhase?: string; runtimeEvidence?: 'active' | 'suspected' | 'stopped' } | undefined
): boolean {
  return session?.runtimeEvidence === 'stopped'
    || isExplicitlyStoppedPhase(session?.connectionPhase ?? '')
}

/**
 * 连接阶段是否属于「协议内在岗」：长轮询待命 / 保活间隙 / 处理中 / 等待回复同步。
 * 大厅与 launcher 的「未待命」判定必须以此为据，不能只认裸 waiting——
 * waiting 仅在 check_messages 调用栈内为 true，Agent 处理消息、keepalive 推理
 * 间隙均为 false，裸用会把健康在岗误判成未待命。
 */
export function isOnDutyPhase(connectionPhase: string): boolean {
  const phase = connectionPhase.toLowerCase()
  return phase.includes('wait') || phase.includes('keepalive') || isProcessingPhase(phase)
}

/** 会话是否健康在岗（在线且处于协议内相位）。 */
export function isAgentOnDuty(session: { online: boolean; waiting: boolean; connectionPhase?: string } | undefined): boolean {
  if (!session?.online) return false
  return session.waiting || isOnDutyPhase(session.connectionPhase ?? '')
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
 * 拾光单一 MCP 服务器名（S4）：Cursor 面板只出现一条原生条目，
 * 所有工具以 channel_id 参数区分通道。
 */
/** Cursor MCP 配置键与握手名称统一显示正式品牌名。 */
export const SG_TEAM_MCP_SERVER_ID = 'SG Team'
export const SG_TEAM_MCP_DISPLAY_NAME = 'SG Team'
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
