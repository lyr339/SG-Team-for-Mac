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

/**
 * step id 只由原生 block id 决定（不掺位置下标）：直播→封口时若前置的重复
 * message 块被滤除，位置会整体前移，含下标的 id 会让后续 Thinking 播放器
 * 误判为新来源而从头重播。重复 id（理论上不出现）才追加下标去重。
 */
function blockStep(raw: ProcessBlock, id: string): ProcessTurnStep {
  const block = normalizeProcessBlockText(raw)
  if (block.kind === 'thinking') {
    return {
      id,
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
      id,
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
      id,
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
    id,
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
  const seenIds = new Map<string, number>()
  const blockSteps = (input.blocks ?? []).map((block, index) => {
    // todos/plan 的数据 id 带内容哈希（持久化需要区分每次更新），但视图层它们是
    // 同一张卡片：以稳定 step id 就地更新，避免每次勾选一项就 React 重挂、展开态丢失。
    const stableId = block.id.startsWith('cursor:todos:')
      ? 'cursor:todos'
      : block.id.startsWith('cursor:plan:') ? 'cursor:plan' : block.id
    const count = seenIds.get(stableId) ?? 0
    seenIds.set(stableId, count + 1)
    return blockStep(block, count === 0 ? `block:${stableId}` : `block:${stableId}:${index}`)
  })
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

/** 建议区标题（明确建议语义才生成按钮）。 */
const SUGGESTION_MARKER = /^(接下来可以|下一步建议|建议操作|可以继续)/

/** Markdown 行内标记转纯展示文本：建议按钮文案与回填输入框都用纯文本，
 *  不把 `**`、反引号、链接语法原样带进 UI（RC-11）。 */
function markdownToPlainText(line: string): string {
  return line
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从回复正文提取「接下来可以」类建议操作。
 *
 * 约束（阶段 H / RC-11，图片事故回归）：
 * - 仅明确建议标题（接下来可以/下一步建议/建议操作/可以继续，容忍 Markdown
 *   加粗与标题前缀）之后的列表生成建议；无标题时不做任意编号列表兜底——
 *   回复末尾的普通编号内容（图片说明、步骤回顾）不是下一步建议；
 * - 候选先转纯文本再进入按钮（`**`、反引号、链接语法不出现在 UI 与输入框）；
 * - `**加粗**` 行不被误认作 `*` 无序列表项；
 * - 按纯文本去重与长度限制（4–100 字符），最多 4 条。
 */
export function suggestedActionsFromText(text: string): string[] {
  const lines = normalizeEscapedNewlines(text).split('\n').map((line) => line.trim())
  let markerIndex = -1
  for (let index = 0; index < lines.length; index += 1) {
    const plain = markdownToPlainText(lines[index]!).replace(/^#+\s*/, '')
    if (SUGGESTION_MARKER.test(plain)) markerIndex = index
  }
  if (markerIndex < 0) return []
  const candidates: string[] = []
  for (const line of lines.slice(markerIndex + 1)) {
    if (/^#{1,6}\s/.test(line) && candidates.length) break
    // `*` 列表项排除 `**加粗**` 形态（第二个字符是 `*` 的是强调，不是列表）。
    const match = line.match(/^(?:[-•]|\*(?!\*)|\d+[.)、])\s*(.+)$/)
    if (match?.[1]) {
      candidates.push(markdownToPlainText(match[1]))
      if (candidates.length === 4) break
    } else if (line && candidates.length) {
      break
    }
  }
  return [...new Set(candidates.filter((line) => line.length >= 4 && line.length <= 100))].slice(0, 4)
}
