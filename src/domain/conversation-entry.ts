export type ConversationRole = 'user' | 'assistant' | 'system' | 'error'
export type ConversationEntryStatus = 'pending' | 'streaming' | 'complete' | 'failed'

/** 工具调用过程区块 */
export interface ProcessBlockTool {
  kind: 'tool'
  id: string
  toolName: string
  toolKind?: 'command' | 'read' | 'search' | 'edit' | 'write' | 'mcp' | 'todo' | 'other'
  /** 工具调用摘要（如文件路径、命令行） */
  summary?: string
  /** 工具输入参数明细 */
  input?: Record<string, unknown>
  /** 工具执行输出（如有） */
  output?: string
  /** 执行状态 */
  status: 'running' | 'done' | 'failed'
  /** 错误信息（status=failed 时） */
  error?: string
}

/** 思考过程区块 */
export interface ProcessBlockThinking {
  kind: 'thinking'
  id: string
  text: string
  status: 'running' | 'done'
}

/** 命令执行输出区块 */
export interface ProcessBlockCommand {
  kind: 'command'
  id: string
  command: string
  output: string
  exitCode?: number
  status: 'running' | 'done' | 'failed'
}

export type ProcessBlock = ProcessBlockTool | ProcessBlockThinking | ProcessBlockCommand

export function normalizeEscapedNewlines(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\\n/g, '\n')
}

function normalizeOptionalText(text: string | undefined): string | undefined {
  return text === undefined ? undefined : normalizeEscapedNewlines(text)
}

export function normalizeProcessBlockText(block: ProcessBlock): ProcessBlock {
  if (block.kind === 'thinking') {
    return { ...block, text: normalizeEscapedNewlines(block.text) }
  }
  if (block.kind === 'tool') {
    return {
      ...block,
      summary: normalizeOptionalText(block.summary),
      output: normalizeOptionalText(block.output),
      error: normalizeOptionalText(block.error)
    }
  }
  return { ...block, output: normalizeEscapedNewlines(block.output) }
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
  source: 'desktop' | 'qingtian' | 'cursor' | 'recovery'
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
