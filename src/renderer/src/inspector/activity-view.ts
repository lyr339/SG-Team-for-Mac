import type { ConversationEntry, ProcessBlock } from '../../../domain/conversation-entry'
import type { LiveProcessState } from '../../../shared/desktop-api'
import { normalizeReviewPath, processBlockPath } from './review-scope'

/**
 * 活动视图：把过程流按「回合 → 类别」重组。中栏按时间顺序滚过程；右栏回答
 * 「这一轮改了哪些文件、跑了哪些命令、读了什么、调了哪些工具」。
 * 纯投影，输入是会话条目 + 实时过程，输出可直接渲染；每项带 blockId 供跳回时间线。
 */
export type ActivityBlockStatus = 'running' | 'done' | 'failed'

export interface ActivityFile {
  path: string
  /** 去掉工作区前缀后的展示路径。 */
  display: string
  count: number
  kinds: Array<'edit' | 'write'>
  status: ActivityBlockStatus
  lastAt?: number
  blockId: string
}

export interface ActivityCommand {
  blockId: string
  command: string
  status: ActivityBlockStatus
  exitCode?: number
  output?: string
  at?: number
  durationMs?: number
}

export interface ActivitySource {
  blockId: string
  kind: 'read' | 'search' | 'browser'
  label: string
  count: number
  status: ActivityBlockStatus
}

export interface ActivityToolCall {
  blockId: string
  toolName: string
  /** MCP 工具拆出的服务器名。 */
  server?: string
  count: number
  status: ActivityBlockStatus
}

export interface ActivityTurn {
  key: string
  /** 触发本回合的用户消息（截断）。 */
  prompt?: string
  at?: number
  live: boolean
  files: ActivityFile[]
  commands: ActivityCommand[]
  sources: ActivitySource[]
  tools: ActivityToolCall[]
  stepCount: number
  thinkingMs: number
}

export interface ActivityView {
  /** 最新回合在前。 */
  turns: ActivityTurn[]
  totals: { files: number; commands: number; failedCommands: number; sources: number; tools: number }
}

function statusOf(block: ProcessBlock): ActivityBlockStatus {
  return block.status === 'failed' ? 'failed' : block.status === 'running' ? 'running' : 'done'
}

function mergeStatus(current: ActivityBlockStatus, next: ActivityBlockStatus): ActivityBlockStatus {
  if (current === 'running' || next === 'running') return 'running'
  if (current === 'failed' || next === 'failed') return 'failed'
  return 'done'
}

/** `mcp-<server>-<tool>` → { server, tool }；其他工具名原样。 */
export function splitMcpToolName(toolName: string): { server?: string; tool: string } {
  const match = toolName.match(/^mcp-(.+?)-([^-]+(?:_[^-]+)*)$/)
  if (!match) return { tool: toolName }
  return { server: match[1], tool: match[2]! }
}

function shortPrompt(text: string): string | undefined {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return undefined
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

function emptyTurn(key: string, live: boolean, prompt?: string, at?: number): ActivityTurn {
  return { key, prompt, at, live, files: [], commands: [], sources: [], tools: [], stepCount: 0, thinkingMs: 0 }
}

function addBlocks(turn: ActivityTurn, blocks: readonly ProcessBlock[], workspacePath?: string): void {
  for (const block of blocks) {
    turn.stepCount += 1
    if (block.kind === 'thinking') {
      turn.thinkingMs += block.durationMs ?? (block.startedAt !== undefined && block.completedAt !== undefined ? block.completedAt - block.startedAt : 0)
      continue
    }
    if (block.kind === 'message') continue
    if (block.kind === 'command') {
      turn.commands.push({
        blockId: block.id,
        command: block.command.trim(),
        status: statusOf(block),
        exitCode: block.exitCode,
        output: block.output || undefined,
        at: block.startedAt,
        durationMs: block.startedAt !== undefined && block.completedAt !== undefined ? block.completedAt - block.startedAt : undefined
      })
      continue
    }
    const status = statusOf(block)
    const kind = block.toolKind ?? 'other'
    if (kind === 'edit' || kind === 'write') {
      const raw = processBlockPath(block)
      if (!raw) continue
      const path = normalizeReviewPath(raw, workspacePath)
      const existing = turn.files.find((file) => file.path === path)
      if (existing) {
        existing.count += 1
        if (!existing.kinds.includes(kind)) existing.kinds.push(kind)
        existing.status = mergeStatus(existing.status, status)
        existing.lastAt = block.startedAt ?? existing.lastAt
        existing.blockId = block.id
      } else {
        turn.files.push({ path, display: path, count: 1, kinds: [kind], status, lastAt: block.startedAt, blockId: block.id })
      }
      continue
    }
    if (kind === 'command') {
      const command = (block.summary ?? '').trim() || block.toolName
      turn.commands.push({
        blockId: block.id,
        command,
        status,
        output: block.output || block.error || undefined,
        at: block.startedAt,
        durationMs: block.startedAt !== undefined && block.completedAt !== undefined ? block.completedAt - block.startedAt : undefined
      })
      continue
    }
    if (kind === 'read' || kind === 'search' || kind === 'browser') {
      const rawLabel = (block.summary ?? '').trim() || block.toolName
      const label = kind === 'read' ? normalizeReviewPath(rawLabel, workspacePath) : rawLabel
      const existing = turn.sources.find((source) => source.kind === kind && source.label === label)
      if (existing) {
        existing.count += 1
        existing.status = mergeStatus(existing.status, status)
        existing.blockId = block.id
      } else {
        turn.sources.push({ blockId: block.id, kind, label, count: 1, status })
      }
      continue
    }
    if (kind === 'todo') continue
    const { server, tool } = splitMcpToolName(block.toolName)
    const existing = turn.tools.find((call) => call.toolName === tool && call.server === server)
    if (existing) {
      existing.count += 1
      existing.status = mergeStatus(existing.status, status)
      existing.blockId = block.id
    } else {
      turn.tools.push({ blockId: block.id, toolName: tool, server, count: 1, status })
    }
  }
}

export function projectActivity(
  entries: readonly ConversationEntry[],
  liveProcess: LiveProcessState | undefined,
  workspacePath?: string
): ActivityView {
  const turns: ActivityTurn[] = []
  let current: ActivityTurn | undefined
  for (const entry of entries) {
    if (entry.silent) continue
    if (entry.role === 'user') {
      current = emptyTurn(`turn:${entry.id}`, false, shortPrompt(entry.text) ?? (entry.attachments?.length ? `（${entry.attachments.length} 个附件）` : undefined), entry.deliveredAt ?? entry.timestamp)
      turns.push(current)
      continue
    }
    if (entry.role !== 'assistant' || !entry.processBlocks?.length) continue
    if (!current) {
      current = emptyTurn(`turn:${entry.id}`, false, undefined, entry.timestamp)
      turns.push(current)
    }
    addBlocks(current, entry.processBlocks, workspacePath)
  }
  if (liveProcess?.blocks.length) {
    const target = current ?? (() => {
      const turn = emptyTurn(`turn:live:${liveProcess.turn}`, true, undefined, liveProcess.startedAt)
      turns.push(turn)
      return turn
    })()
    target.live = true
    addBlocks(target, liveProcess.blocks, workspacePath)
  }
  const populated = turns.filter((turn) => turn.stepCount > 0 || turn.live)
  populated.reverse()
  return {
    turns: populated,
    totals: {
      files: new Set(populated.flatMap((turn) => turn.files.map((file) => file.path))).size,
      commands: populated.reduce((total, turn) => total + turn.commands.length, 0),
      failedCommands: populated.reduce((total, turn) => total + turn.commands.filter((command) => command.status === 'failed' || (command.exitCode ?? 0) !== 0).length, 0),
      sources: populated.reduce((total, turn) => total + turn.sources.length, 0),
      tools: populated.reduce((total, turn) => total + turn.tools.length, 0)
    }
  }
}
