import type { ConversationEntry } from './conversation-entry'
import { formatFileSize } from '../shared/format-file-size'

/**
 * 会话交接（上下文交接）领域模型。
 *
 * 一个 Cursor Composer 的「上下文文档」是 Cursor 落盘在本机的 agent 转录
 * （`~/.cursor/projects/<project>/agent-transcripts/<composerId>/<composerId>.jsonl`，
 * 每行一条 role/message 记录，含模型思考摘要与工具调用）。交接 = 把该文档的精确
 * 路径连同拾光侧的会话记录，作为一条普通用户消息排进目标通道的出站队列：
 * - 目标为本会话时携带「等待新会话」保持位（hold），当前会话取不到它，只有该席位
 *   之后重建/重启出来的新会话（新会话令牌）才会收到——满足「等待下次启动时读取」；
 * - 目标为其他在线会话时按普通排队立即投递。
 *
 * Cursor 只在原会话回合结束（停止/重启/被新会话接管）后才写入完整转录，交接消息
 * 因此如实携带交接时刻的落盘状态，并给阅读方明确的等待重读指引。
 */

export interface SessionTranscriptLocation {
  /** 转录文件精确路径（不存在时为按工程目录推导的预计路径）。 */
  path: string
  exists: boolean
  sizeBytes?: number
  modifiedAt?: number
  /** JSONL 记录数（按非空行计）。 */
  recordCount?: number
  /** 路径来源：在工程目录直接命中 / 跨目录按 composerId 命中 / 仅推导。 */
  resolution: 'workspace' | 'global' | 'expected'
}

export interface SessionHandoffContext {
  channelId: string
  displayName: string
  composerId?: string
  modelName?: string
  transcript?: SessionTranscriptLocation
  /** 席位已签发会话令牌 → 可以「等待新会话」投递本会话。 */
  holdSupported: boolean
  userMessageCount: number
  assistantMessageCount: number
  /** 拾光侧记录的首末消息时间。 */
  firstMessageAt?: number
  lastMessageAt?: number
}

export type SessionHandoffTarget =
  | { kind: 'self' }
  | { kind: 'channel'; channelId: string }

export interface SessionHandoffRequest {
  sourceChannelId: string
  target: SessionHandoffTarget
  /** 用户附加的交接说明（可选，≤2000 字）。 */
  note?: string
}

export interface SessionHandoffResult {
  targetChannelId: string
  /** 是否以「等待新会话」保持位入队（仅 self 且席位有令牌）。 */
  held: boolean
  transcriptPath: string
  recordPath?: string
  commandId: string
  issuedAt: number
}

export const SESSION_HANDOFF_NOTE_MAX_CHARS = 2_000
export const SESSION_HANDOFF_MARKER = '【会话交接】'

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地时间 `YYYY-MM-DD HH:mm`（交接消息与记录文件共用，不依赖运行时 locale）。 */
export function formatHandoffTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** 记录文件名：`CH-<通道>-<composer 前 8 位>-<YYYYMMDD-HHmmss>.md`。 */
export function handoffRecordFileName(channelId: string, composerId: string | undefined, issuedAt: number): string {
  const date = new Date(issuedAt)
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  const composer = (composerId ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'nocomposer'
  return `CH-${channelId}-${composer}-${stamp}.md`
}

function transcriptStateLine(transcript: SessionTranscriptLocation, issuedAt: number): string {
  if (!transcript.exists) {
    return '交接时该文件尚不存在（Cursor 通常在首次回复后创建）；若读取时仍不存在，请等待约 30 秒后重试，最多 3 次。'
  }
  const parts = [
    transcript.recordCount !== undefined ? `${transcript.recordCount} 条记录` : '',
    transcript.sizeBytes !== undefined ? formatFileSize(transcript.sizeBytes) : '',
    transcript.modifiedAt !== undefined ? `最后写入 ${formatHandoffTime(transcript.modifiedAt)}` : ''
  ].filter(Boolean)
  return `交接时状态：${parts.join(' · ')}。Cursor 只在原会话回合结束后写入完整转录：`
    + `若文件修改时间早于本消息发出时间（${formatHandoffTime(issuedAt)}），说明原会话尚未落盘，请等待约 30 秒后重读，最多重试 3 次。`
}

export function buildSessionHandoffMessage(input: {
  sourceChannelId: string
  sourceDisplayName: string
  sourceModelName?: string
  target: SessionHandoffTarget
  issuedAt: number
  transcript: SessionTranscriptLocation
  recordPath?: string
  note?: string
}): string {
  const { target } = input
  const source = `CH-${input.sourceChannelId}（${input.sourceDisplayName}${input.sourceModelName ? ` · ${input.sourceModelName}` : ''}）`
  const heading = target.kind === 'self'
    ? `${SESSION_HANDOFF_MARKER}${source} 上一段会话的上下文 · ${formatHandoffTime(input.issuedAt)}`
    : `${SESSION_HANDOFF_MARKER}来自 ${source} · ${formatHandoffTime(input.issuedAt)}`
  const intro = target.kind === 'self'
    ? '你是该席位重建后的新会话。请先阅读并接续下面的上下文，再处理后续消息：'
    : '请先阅读并接续下面的上下文，再处理后续消息：'
  const lines = [
    heading,
    '',
    intro,
    '',
    '1. Cursor 会话转录（JSONL，每行一条 role/message 记录，含模型思考摘要与工具调用）：',
    `   ${input.transcript.path}`,
    `   ${transcriptStateLine(input.transcript, input.issuedAt)}`
  ]
  if (input.recordPath) {
    lines.push(
      '2. 拾光会话记录（Markdown：用户消息与 Agent 回复全文，附件原文件路径在内）：',
      `   ${input.recordPath}`
    )
  }
  const note = input.note?.trim().slice(0, SESSION_HANDOFF_NOTE_MAX_CHARS)
  if (note) lines.push('', `交接说明：${note}`)
  lines.push(
    '',
    '读完后用一两句话向用户确认已接手（说明你读到的最后一个任务与当前状态），然后继续处理后续消息。'
  )
  return lines.join('\n')
}

function entryRoleLabel(entry: ConversationEntry): string {
  if (entry.role === 'user') return entry.source === 'desktop' ? '用户' : '用户（Cursor）'
  if (entry.role === 'assistant') return 'Agent'
  if (entry.role === 'system') return '系统'
  return '错误'
}

/**
 * 拾光侧会话记录（Markdown）。它是交接时刻完整、即时的用户可见对话；Cursor 转录
 * 可能滞后（原会话未结束时只落了开头），两者互补。
 */
export function buildSessionHandoffRecord(input: {
  channelId: string
  displayName: string
  workspacePath?: string
  runId?: string
  composerId?: string
  modelName?: string
  transcriptPath?: string
  issuedAt: number
  entries: readonly ConversationEntry[]
}): string {
  const entries = input.entries.filter((entry) => !entry.silent)
  const users = entries.filter((entry) => entry.role === 'user')
  const assistants = entries.filter((entry) => entry.role === 'assistant')
  const first = entries[0]?.timestamp
  const last = entries.at(-1)?.timestamp
  const header = [
    `# 拾光会话记录 · CH-${input.channelId} ${input.displayName}`,
    '',
    ...(input.workspacePath ? [`- 工程：${input.workspacePath}`] : []),
    ...(input.runId ? [`- 运行：${input.runId}`] : []),
    ...(input.modelName ? [`- 模型：${input.modelName}`] : []),
    ...(input.composerId ? [`- Cursor composerId：${input.composerId}`] : []),
    ...(input.transcriptPath ? [`- Cursor 转录：${input.transcriptPath}`] : []),
    `- 导出时间：${formatHandoffTime(input.issuedAt)}`,
    `- 消息：${users.length} 条用户消息 / ${assistants.length} 条 Agent 回复`
      + (first !== undefined && last !== undefined ? `；时间范围 ${formatHandoffTime(first)} – ${formatHandoffTime(last)}` : ''),
    '',
    '---'
  ]
  const body = entries.map((entry) => {
    const lines = [`## ${entryRoleLabel(entry)} · ${formatClock(entry.timestamp)}`, '']
    if (entry.role === 'user' && entry.deliveredAt === undefined) lines.push('（交接时尚未投递给 Agent）', '')
    lines.push(entry.text.trim() || '（空）')
    if (entry.attachments?.length) {
      lines.push('', ...entry.attachments.map((attachment) => (
        `附件：${attachment.name}${attachment.path ? ` → ${attachment.path}` : '（内容未随消息保存）'}`
      )))
    }
    if (entry.processBlocks?.length) {
      const tools = entry.processBlocks.filter((block) => block.kind === 'tool').length
      lines.push('', `（过程：${entry.processBlocks.length} 步${tools ? ` · ${tools} 次工具` : ''}）`)
    }
    if (entry.error) lines.push('', `错误：${entry.error}`)
    return lines.join('\n')
  })
  return `${[header.join('\n'), ...body].join('\n\n').replace(/\n{3,}/g, '\n\n')}\n`
}
