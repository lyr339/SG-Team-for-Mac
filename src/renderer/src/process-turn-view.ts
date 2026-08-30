import type { ProcessBlock } from '../../domain/conversation-entry'
import { normalizeEscapedNewlines, normalizeProcessBlockText } from '../../domain/conversation-entry'

export type ProcessStepKind = 'thinking' | 'message' | 'read' | 'search' | 'edit' | 'write' | 'command' | 'browser' | 'mcp' | 'todo' | 'other'

export interface ProcessStepDetail {
  label: string
  value: string
  kind?: 'text' | 'code' | 'path'
}

export interface ProcessTurnStep {
  id: string
  kind: ProcessStepKind
  action: string
  target?: string
  body?: string
  status: 'running' | 'done' | 'failed'
  startedAt?: number
  completedAt?: number
  timingEstimated?: boolean
  durationMs?: number
  details: ProcessStepDetail[]
  todos?: Array<{ content: string; status: string }>
}

export interface ProcessTurnViewModel {
  id: string
  steps: ProcessTurnStep[]
  status: 'running' | 'done' | 'failed'
  startedAt?: number
  completedAt?: number
  elapsedMs?: number
  thinkingCount: number
  toolCount: number
  timingEstimated: boolean
}

const ACTIONS: Record<ProcessStepKind, string> = {
  thinking: '思考',
  message: 'Agent',
  read: '读取文件',
  search: '搜索',
  edit: '修改代码',
  write: '写入文件',
  command: '运行验证',
  browser: '浏览器操作',
  mcp: '调用工具',
  todo: '任务清单',
  other: '执行工具'
}

function kindOf(toolKind?: string): ProcessStepKind {
  return toolKind === 'read' || toolKind === 'search' || toolKind === 'edit'
    || toolKind === 'write' || toolKind === 'command' || toolKind === 'mcp'
    || toolKind === 'todo' || toolKind === 'browser'
    ? toolKind
    : 'other'
}

function clean(value?: string): string | undefined {
  const text = value ? normalizeEscapedNewlines(value).trim() : ''
  return text || undefined
}

function blockStep(raw: ProcessBlock, index: number): ProcessTurnStep {
  const block = normalizeProcessBlockText(raw)
  if (block.kind === 'thinking') {
    return {
      id: `block:${block.id}:${index}`,
      kind: 'thinking',
      action: ACTIONS.thinking,
      body: clean(block.text),
      status: block.status,
      startedAt: block.startedAt,
      completedAt: block.completedAt,
      timingEstimated: block.timingEstimated,
      durationMs: block.durationMs,
      details: []
    }
  }
  if (block.kind === 'message') {
    return {
      id: `block:${block.id}:${index}`,
      kind: 'message',
      action: ACTIONS.message,
      body: clean(block.text),
      status: block.status,
      startedAt: block.startedAt,
      completedAt: block.completedAt,
      timingEstimated: block.timingEstimated,
      details: []
    }
  }
  if (block.kind === 'command') {
    return {
      id: `block:${block.id}:${index}`,
      kind: 'command',
      action: ACTIONS.command,
      target: clean(block.command),
      status: block.status,
      startedAt: block.startedAt,
      completedAt: block.completedAt,
      timingEstimated: block.timingEstimated,
      details: block.output ? [{ label: '输出', value: block.output, kind: 'code' }] : []
    }
  }
  const kind = kindOf(block.toolKind)
  const details: ProcessStepDetail[] = []
  if (block.input && Object.keys(block.input).length) {
    details.push({ label: '输入', value: JSON.stringify(block.input, null, 2), kind: 'code' })
  }
  if (block.output) details.push({ label: '输出', value: block.output, kind: 'code' })
  if (block.error) details.push({ label: '错误', value: block.error, kind: 'code' })
  return {
    id: `block:${block.id}:${index}`,
    kind,
    action: kind === 'mcp' || kind === 'other' ? block.toolName || ACTIONS[kind] : ACTIONS[kind],
    target: clean(block.summary),
    status: block.status,
    startedAt: block.startedAt,
    completedAt: block.completedAt,
    timingEstimated: block.timingEstimated,
    details,
    todos: block.todos
  }
}

export function buildProcessTurnView(input: {
  id: string
  blocks?: ProcessBlock[]
  startedAt?: number
  updatedAt?: number
}): ProcessTurnViewModel {
  const blockSteps = (input.blocks ?? []).map(blockStep)
  // Cursor 的 conversationMap 数组顺序就是原生时间线顺序；不可再按首次观测时间
  // 排序，否则同一帧出现的 thinking/tool 会被 id 字典序打乱。
  const steps = blockSteps
  const failed = steps.some((step) => step.status === 'failed')
  const running = steps.some((step) => step.status === 'running')
  const startedCandidates = [input.startedAt, ...steps.map((step) => step.startedAt)]
    .filter((value): value is number => typeof value === 'number')
  const completedCandidates = steps.map((step) => step.completedAt)
    .filter((value): value is number => typeof value === 'number')
  const startedAt = startedCandidates.length ? Math.min(...startedCandidates) : undefined
  const completedAt = running ? undefined : completedCandidates.length
    ? Math.max(...completedCandidates)
    : input.updatedAt
  return {
    id: input.id,
    steps,
    status: failed ? 'failed' : running ? 'running' : 'done',
    startedAt,
    completedAt,
    elapsedMs: startedAt !== undefined && (completedAt ?? input.updatedAt) !== undefined
      ? Math.max(0, (completedAt ?? input.updatedAt)! - startedAt)
      : undefined,
    thinkingCount: steps.filter((step) => step.kind === 'thinking').length,
    toolCount: steps.filter((step) => step.kind !== 'thinking' && step.kind !== 'message').length,
    timingEstimated: steps.some((step) => step.timingEstimated === true)
  }
}

export function suggestedActionsFromText(text: string): string[] {
  const lines = normalizeEscapedNewlines(text).split('\n').map((line) => line.trim())
  const markerIndexes = lines.flatMap((line, index) => (
    /^(接下来可以|下一步建议|建议操作|可以继续)/.test(line.replace(/^#+\s*/, '')) ? [index] : []
  ))
  const candidates: string[] = []
  if (markerIndexes.length) {
    const markerIndex = markerIndexes.at(-1)!
    for (const line of lines.slice(markerIndex + 1)) {
      if (/^#{1,6}\s/.test(line) && candidates.length) break
      const match = line.match(/^(?:[-*•]|\d+[.)、])\s*(.+)$/)
      if (match?.[1]) {
        candidates.push(match[1].trim())
        if (candidates.length === 4) break
      } else if (line && candidates.length) {
        break
      }
    }
  } else {
    for (const line of lines.slice(-8)) {
      const match = line.match(/^\d+[.)、]\s*(.+)$/)
      if (match?.[1]) candidates.push(match[1].trim())
    }
  }
  const filtered = candidates.filter((line) => line.length >= 4 && line.length <= 100)
  return [...new Set(filtered)].slice(0, 4)
}
