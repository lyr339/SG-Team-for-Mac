import { sanitizeModelGeneratedText } from './model-output-sanitizer'

export type ConversationRole = 'user' | 'assistant' | 'system' | 'error'
export type ConversationEntryStatus = 'pending' | 'streaming' | 'complete' | 'failed'

export interface ProcessBlockTiming {
  /** 拾光首次观测到该步骤的时间。 */
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

/** 模型上报文本统一先净化（工具调用标记泄漏截断）再做转义换行归一。 */
function sanitizeThenNormalize(text: string): string {
  return normalizeEscapedNewlines(sanitizeModelGeneratedText(text).text)
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
  commandId?: string
  streamId?: string
  /** Agent 回合标识；用于把 Cursor transcript 过程贴回对应回复。 */
  turn?: string
  error?: string
  /** 助手消息关联的过程区块（工具调用 / 思考 / 命令输出） */
  processBlocks?: ProcessBlock[]
  /** 用户消息携带的附件 */
  attachments?: MessageAttachment[]
  /** 静默条目：系统内部协作通知不进入用户时间线，仅通过 DesktopSnapshot.commandReceipts 保留投递回执 */
  silent?: boolean
}
