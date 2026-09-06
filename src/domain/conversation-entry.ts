import {
  sanitizeModelDisplayText,
  sanitizeModelGeneratedText,
  stripRedactionMarkers
} from './model-output-sanitizer'

export type ConversationRole = 'user' | 'assistant' | 'system' | 'error'
export type ConversationEntryStatus = 'pending' | 'streaming' | 'complete' | 'failed'

export interface ProcessBlockTiming {
  /** Cursor bubble 原生创建时间；旧来源缺失时回退为拾光首次观测时间。 */
  startedAt?: number
  /** 步骤进入 done/failed 的时间。 */
  completedAt?: number
  /** true 表示时间来自 CDP 采样边界，仅为观测近似值，不是 Cursor 原生耗时。 */
  timingEstimated?: boolean
}

/** 工具调用过程区块 */
export interface ProcessBlockTool extends ProcessBlockTiming {
  kind: 'tool'
  id: string
  toolName: string
  toolKind?: 'command' | 'read' | 'search' | 'edit' | 'write' | 'browser' | 'mcp' | 'todo' | 'other'
  /** 工具调用摘要（如文件路径、命令行） */
  summary?: string
  /** 工具输入参数明细 */
  input?: Record<string, unknown>
  /** Cursor 原生 todo 项（toolKind=todo）。 */
  todos?: Array<{ content: string; status: string }>
  /** 工具执行输出（如有） */
  output?: string
  /** 执行状态 */
  status: 'running' | 'done' | 'failed'
  /** 错误信息（status=failed 时） */
  error?: string
}

/** 思考过程区块 */
export interface ProcessBlockThinking extends ProcessBlockTiming {
  kind: 'thinking'
  id: string
  text: string
  status: 'running' | 'done'
  /** Cursor 原生 thinkingDurationMs；存在时优先于采样时间。 */
  durationMs?: number
}

/** Cursor 回合中夹在思考与工具之间的原生 assistant-message。 */
export interface ProcessBlockMessage extends ProcessBlockTiming {
  kind: 'message'
  id: string
  text: string
  status: 'running' | 'done'
}

/** 命令执行输出区块 */
export interface ProcessBlockCommand extends ProcessBlockTiming {
  kind: 'command'
  id: string
  command: string
  output: string
  exitCode?: number
  status: 'running' | 'done' | 'failed'
}

export type ProcessBlock = ProcessBlockTool | ProcessBlockThinking | ProcessBlockMessage | ProcessBlockCommand

export function normalizeEscapedNewlines(text: string): string {
  let normalized = text.replace(/\r\n?/g, '\n')
  for (let index = 0; index < 3; index += 1) {
    const next = normalized
      .replace(/\\{1,2}r\\{1,2}n/g, '\n')
      .replace(/\\{1,2}n/g, '\n')
      .replace(/\\{1,2}r/g, '\n')
    if (next === normalized) break
    normalized = next
  }
  return normalized
}

function normalizeOptionalText(text: string | undefined): string | undefined {
  return text === undefined ? undefined : normalizeEscapedNewlines(text)
}

/** 模型上报文本统一先净化（工具调用标记泄漏截断 + 脱敏占位符剥离）再做转义换行归一。 */
function sanitizeThenNormalize(text: string): string {
  return normalizeEscapedNewlines(sanitizeModelDisplayText(text).text)
}

function sanitizeOptionalText(text: string | undefined): string | undefined {
  return text === undefined ? undefined : sanitizeThenNormalize(text)
}

export function normalizeProcessBlockText(block: ProcessBlock): ProcessBlock {
  if (block.kind === 'thinking') {
    return { ...block, text: sanitizeThenNormalize(block.text) }
  }
  if (block.kind === 'message') {
    return { ...block, text: sanitizeThenNormalize(block.text) }
  }
  if (block.kind === 'tool') {
    return {
      ...block,
      summary: sanitizeOptionalText(block.summary),
      output: sanitizeOptionalText(block.output),
      error: sanitizeOptionalText(block.error)
    }
  }
  return {
    ...block,
    command: sanitizeModelGeneratedText(block.command).text,
    output: sanitizeThenNormalize(block.output)
  }
}

/**
 * 跨来源回复身份比对：剥脱敏占位符 + 折叠全部空白。
 * 同一条回复会经过不同净化管线（CDP sanitizeModelDisplayText 剥 [REDACTED]、
 * 落库 normalizeEscapedNewlines 保留），精确比较会假性不等——用于判定
 * 「转录兜底的文本是否已由 record_reply 落库」。
 */
export function conversationTextIdentity(text: string): string {
  // 先与落库管线对齐（字面 \n → 真换行，幂等），再剥脱敏 + 折叠空白。
  return stripRedactionMarkers(normalizeEscapedNewlines(text)).replace(/\s+/g, ' ').trim()
}

/** 常见图片扩展名 → 规范 MIME（file.type 缺失时的兜底映射）。 */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon'
}

/**
 * 附件 MIME 兜底嗅探：来源端（剪贴板/部分应用的拖放）可能给出空 type 或
 * 万金油 application/octet-stream——图片会被投递层当成二进制文件塞成 Base64
 * 文本墙（模型看到乱码，正是「图片被识别成完全不相干内容」的事故形态）。
 * 扩展名能确认是图片时纠正 MIME；其余情况原样返回。
 */
export function sniffedAttachmentMimeType(name: string, mimeType?: string): string {
  const declared = (mimeType ?? '').trim().toLowerCase()
  if (declared && declared !== 'application/octet-stream') return declared
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  return IMAGE_MIME_BY_EXTENSION[extension] ?? (declared || 'application/octet-stream')
}

/** 消息附件 */
export interface MessageAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  /** base64 编码内容（小文件）或临时文件路径（大文件） */
  data?: string
  path?: string
  /** 图片附件的预览 URL（data: 或 blob:） */
  previewUrl?: string
}

export interface ConversationEntry {
  id: string
  channelId: string
  role: ConversationRole
  text: string
  timestamp: number
  status: ConversationEntryStatus
  source: 'desktop' | 'cursor' | 'recovery'
  /** 出站消息被 check_messages 实际取走的时间；缺失表示仍在队列中。 */
  deliveredAt?: number
  /** 排队中的用户消息带「等待新会话」保持位：当前会话取不到，留给该席位重建后的新会话。 */
  heldForNextSession?: boolean
  /** 助手回复对应的用户时间线条目（outbox:<id>）。 */
  replyToEntryId?: string
  commandId?: string
  streamId?: string
  /** Agent 回合标识；用于把 Cursor transcript 过程贴回对应回复。 */
  turn?: string
  error?: string
  /** 助手消息关联的过程区块（工具调用 / 思考 / 命令输出） */
  processBlocks?: ProcessBlock[]
  /** 原生超长回合因传输上限折叠的步骤数。 */
  processTruncatedItemCount?: number
  /** 用户消息携带的附件 */
  attachments?: MessageAttachment[]
  /** 静默条目：系统内部协作通知不进入用户时间线，仅通过 DesktopSnapshot.commandReceipts 保留投递回执 */
  silent?: boolean
}

const ROLE_ORDER: Record<ConversationRole, number> = { user: 0, assistant: 1, system: 2, error: 3 }

/**
 * 会话时间线排序：以内容"进入对话"的时刻排位，而不是被创建的时刻。
 *
 * - 用户消息按投递时刻（deliveredAt）排位——它在被模型取走那一刻才成为对话的一部分；
 * - 回复按落库时刻排位；
 * - 仍在排队的用户消息排在一切已发生内容之后（彼此按创建时刻）。
 *
 * 否则「上一回合回复落库前就排队的消息」会按输入时刻插到该回复前面，回合投影
 * 「回复位于本消息与下一条消息之间」的前提被打破，回复就会变成挂在下一回合过程流
 * 下方的孤立条目。创建时刻（timestamp）只用于展示。
 *
 * 兼容不带投递时刻的旧数据：有回复明确指向它（replyToEntryId）的用户消息紧贴在
 * 该回复之前；回复根本没有链路的旧会话退回创建时刻顺序。
 *
 * 同一时刻的条目保持传入顺序（稳定排序）：库里按 created_at, seq 读出，内存里按
 * 追加顺序——同一毫秒连发的两条消息不会因为随机 id 而互换位置。
 */
export function sortConversationEntries(entries: readonly ConversationEntry[]): ConversationEntry[] {
  const linkedReplyAt = new Map<string, number>()
  let hasUnlinkedReply = false
  for (const entry of entries) {
    if (entry.role !== 'assistant') continue
    if (!entry.replyToEntryId) {
      hasUnlinkedReply = true
      continue
    }
    const existing = linkedReplyAt.get(entry.replyToEntryId)
    if (existing === undefined || entry.timestamp < existing) linkedReplyAt.set(entry.replyToEntryId, entry.timestamp)
  }
  const orderAt = (entry: ConversationEntry): number => {
    if (entry.role !== 'user') return entry.timestamp
    if (entry.deliveredAt !== undefined) return entry.deliveredAt
    const replyAt = linkedReplyAt.get(entry.id)
    if (replyAt !== undefined) return replyAt - 1
    return hasUnlinkedReply ? entry.timestamp : Number.POSITIVE_INFINITY
  }
  return entries
    .map((entry) => ({ entry, at: orderAt(entry) }))
    .sort((left, right) => (
      left.at - right.at
      || left.entry.timestamp - right.entry.timestamp
      || ROLE_ORDER[left.entry.role] - ROLE_ORDER[right.entry.role]
    ))
    .map(({ entry }) => entry)
}
