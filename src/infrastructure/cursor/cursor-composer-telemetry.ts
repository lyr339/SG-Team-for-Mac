import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { AgentExecutionProfile } from '../../domain/agent-session'
import type {
  CursorModelOption,
  CursorModelParameter,
  CursorModelParameterDefinition
} from '../../domain/cursor-model'
import type { RuntimeBinding } from '../../domain/team-control'
import {
  cursorComposerBindingMarker,
  emptyCursorTelemetrySnapshot,
  type CursorChannelActivity,
  type CursorComposerActivity,
  type ComposerBindingCandidate,
  type CursorComposerTelemetry,
  type CursorTelemetrySnapshot,
  type CursorWorkDetail,
  type CursorWorkEntry,
  type CursorWorkTodo,
  type CursorWorkToolKind
} from '../../domain/cursor-telemetry'

const COMPOSER_HEADERS_KEY = 'composer.composerHeaders'
const APPLICATION_USER_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'
const MAX_HEADERS_BYTES = 32 * 1024 * 1024
const MAX_APPLICATION_USER_BYTES = 64 * 1024 * 1024
const MAX_WORKSPACE_COMPOSERS = 250
const MAX_TRANSCRIPT_HEAD_BYTES = 256 * 1024
const MAX_TRANSCRIPT_TAIL_BYTES = 768 * 1024
const MAX_TRANSCRIPT_SIGNAL_CACHE = 512
const MAX_RUNTIME_STATE_BYTES = 16 * 1024
const SAFE_COMPOSER_ID = /^[a-zA-Z0-9_-]{8,128}$/
const SAFE_WORKSPACE_STORAGE_ID = /^[a-f0-9]{32}$/
const FALLBACK_BINDING_CLOCK_SKEW_MS = 5 * 60 * 1_000
const RUNTIME_STATE_FRESH_MS = 20_000
const RECENT_TRANSCRIPT_GRACE_MS = 30_000
// 长任务宽限：最后的 Agent 活动是干活特征（tool/assistant）时，转录在单个长命令
// （构建/测试可达数分钟）执行期间暂停增长属正常——宽限期内不构成死亡证据
const WORK_ACTIVITY_GRACE_MS = 5 * 60_000
const MAX_PROJECT_DIRS = 512
const MAX_WORK_ENTRIES = 80
const MAX_WORK_TEXT_CHARS = 600
const MAX_WORK_DETAIL_CHARS = 1_400
const MAX_WORK_READ_PER_POLL = 4 * 1024 * 1024
// 僵尸轮询硬上限：传输层声称 keepalive/waiting（每秒都在轮询 check_messages，
// 每次轮询都会写转录），但通道转录沉默超过该时长——两者矛盾，判定为
// 认证失效的僵尸会话（正面矛盾证据，不是「证据缺失」）
// 注：从 6 分钟缩短到 60 秒，更快检测假在线
const CHANNEL_POLL_SILENCE_MS = 60_000
const CHANNEL_SCAN_MAX_FILES = 48

type UnknownRecord = Record<string, unknown>

interface ParsedComposer {
  telemetry: CursorComposerTelemetry
  bindingText: string
  workspaceStorageId?: string
}

interface TranscriptAction {
  kind: 'check_messages' | 'record_reply' | 'tool' | 'assistant'
  channelId?: string
  toolName?: string
}

interface TranscriptSignals {
  bindingMarkers: Set<string>
  channelIds: Set<string>
  lastAction?: TranscriptAction
  modifiedAt?: number
}

interface CachedTranscriptSignals extends TranscriptSignals {
  path: string
  size: number
  modifiedAt: number
}

interface CachedTranscriptWork {
  path: string
  offset: number
  remainder: Buffer
  /** 已处理的转录物理行数（含空行/解析失败行），作为条目稳定行号来源。 */
  line: number
  entries: CursorWorkEntry[]
  activeTurn?: string
  activeTurnEntryStart?: number
  updatedAt: number
}

interface ParsedTranscriptWorkLine {
  entries: CursorWorkEntry[]
  explicitTurn?: string
  closesTurn: boolean
}

/** 工具名 → 动作分组（图标/中文动作名由渲染层按组决定）。 */
function workToolKind(name: string): CursorWorkToolKind {
  const lower = name.toLowerCase()
  if (/shell|command|terminal|\brun\b/.test(lower)) return 'command'
  if (/read|open|view|\bcat\b/.test(lower)) return 'read'
  if (/glob|grep|search|find|query|\brg\b/.test(lower)) return 'search'
  if (/edit|replace|patch|delete|strreplace/.test(lower)) return 'edit'
  if (/write|create/.test(lower)) return 'write'
  return 'other'
}

const INTERNAL_MCP_TOOL_NAMES = new Set([
  'check_messages',
  'qingtian',
  'record_process',
  'record_reply',
  'wait_messages',
  'list_available',
  'list_mine',
  'get_task',
  'claim_task',
  'claim_review',
  'submit_for_review',
  'fail_task',
  'report_status'
])

function internalMcpCall(input: UnknownRecord | undefined, toolName: string): boolean {
  const normalized = toolName.trim()
  const server = boundedString(input?.server, 160)?.toLowerCase() ?? ''
  const namespace = boundedString(input?.namespace, 160)?.toLowerCase() ?? ''
  if (/^(qtwx|qingtian|qunshu)/.test(server) || /(^|-)qunshu$/.test(namespace) || /^(qtwx|qingtian|qunshu)/.test(namespace)) return true
  if (INTERNAL_MCP_TOOL_NAMES.has(normalized)) return true
  return normalized.startsWith('team_') || normalized.startsWith('qingtian_') || normalized.startsWith('qtwx_')
}

function boundedMultiline(value: unknown, maxLength = MAX_WORK_DETAIL_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized
}

function isRedactedOnlyText(value: string): boolean {
  const normalized = value.trim()
  if (!/\[REDACTED\]/i.test(normalized)) return false
  const withoutRedactedMarkers = normalized.replace(/\[REDACTED\]/gi, '')
  return withoutRedactedMarkers.replace(/[\s`'"“”‘’.,;:!?|()[\]{}<>_\-—–/\\*#•·，。！？、；：]+/g, '') === ''
}

function pushDetail(
  details: CursorWorkDetail[],
  label: string,
  value: unknown,
  kind: CursorWorkDetail['kind'] = 'text'
): void {
  const normalized = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value
  const text = kind === 'code'
    ? boundedMultiline(normalized)
    : boundedString(normalized, MAX_WORK_DETAIL_CHARS)
  if (text && !isRedactedOnlyText(text)) details.push({ label, value: text, kind })
}

function patchTouchedFiles(patch: string): string {
  const files = new Set<string>()
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
    const file = match[1]?.trim()
    if (file) files.add(file)
  }
  return [...files].slice(0, 6).join(', ')
}

function countLines(value: string): number {
  if (!value) return 0
  return value.split('\n').length
}

function workToolDetails(name: string, input: UnknownRecord | undefined, rawInput: unknown): CursorWorkDetail[] | undefined {
  const details: CursorWorkDetail[] = []
  const lower = name.toLowerCase()
  if (name === 'ApplyPatch') {
    const patch = boundedMultiline(rawInput, MAX_WORK_DETAIL_CHARS)
    if (patch) {
      pushDetail(details, '文件', patchTouchedFiles(patch), 'path')
      pushDetail(details, 'Patch', patch, 'code')
    }
    return details.length ? details : undefined
  }
  if (!input) return undefined

  if (lower === 'shell') {
    pushDetail(details, '命令', input.command, 'code')
    pushDetail(details, '工作目录', input.working_directory, 'path')
    pushDetail(details, '说明', input.description)
    return details.length ? details : undefined
  }
  if (lower === 'awaitshell') {
    pushDetail(details, 'Shell ID', input.shell_id)
    pushDetail(details, '等待模式', input.pattern)
    pushDetail(details, '最长等待', input.block_until_ms)
    return details.length ? details : undefined
  }
  if (lower === 'strreplace') {
    const oldText = boundedMultiline(input.old_string)
    const newText = boundedMultiline(input.new_string)
    pushDetail(details, '文件', input.path, 'path')
    if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
      details.push({
        label: '变更规模',
        value: `+${countLines(String(input.new_string ?? ''))} / -${countLines(String(input.old_string ?? ''))}`
      })
    }
    pushDetail(details, '替换前', oldText, 'code')
    pushDetail(details, '替换后', newText, 'code')
    pushDetail(details, '全部替换', input.replace_all)
    return details.length ? details : undefined
  }
  if (lower === 'write') {
    pushDetail(details, '文件', input.path, 'path')
    pushDetail(details, '写入内容', input.contents, 'code')
    return details.length ? details : undefined
  }

  pushDetail(details, '文件', input.path ?? input.file_path ?? input.target_file, 'path')
  pushDetail(details, '目录', input.target_directory ?? input.working_directory, 'path')
  pushDetail(details, '模式', input.glob_pattern ?? input.glob)
  pushDetail(details, '关键词', input.pattern ?? input.query)
  pushDetail(details, '命令', input.command ?? input.cmd, 'code')
  pushDetail(details, 'URL', input.url)
  pushDetail(details, '输出模式', input.output_mode)
  pushDetail(details, '限制', input.limit ?? input.head_limit)
  pushDetail(details, '偏移', input.offset)
  pushDetail(details, '上下文', input['-C'] ?? input['-A'] ?? input['-B'])
  return details.length ? details : undefined
}

/**
 * 工具调用的过程摘要。返回 undefined 表示该调用是噪音，不应出现在过程视图：
 * GetDynamicTools 只是工具发现；qtwx/qingtian/team MCP 是群枢内部同步通道。
 * TodoWrite 不进摘要走 toolKind=todo，由渲染层展示结构化任务卡片。
 */
function workToolSummary(
  name: string,
  input: UnknownRecord | undefined,
  rawInput: unknown
): { text: string; toolName?: string; toolKind: CursorWorkToolKind; todos?: CursorWorkTodo[]; details?: CursorWorkDetail[] } | undefined {
  if (name === 'GetDynamicTools') return undefined
  if (name === 'TodoWrite') {
    const raw = Array.isArray(input?.todos) ? input.todos : []
    const todos = raw.flatMap((item): CursorWorkTodo[] => {
      const record = recordOf(item)
      const content = boundedString(record?.content, 200)
      if (!content) return []
      return [{ content, status: boundedString(record?.status, 40) || 'pending' }]
    })
    if (!todos.length) return undefined
    return { text: '任务清单', toolName: name, toolKind: 'todo', todos }
  }
  if (name === 'CallMcpTool' || name === 'CallDynamicTool') {
    const toolName = boundedString(input?.toolName, 160)
    if (!toolName || internalMcpCall(input, toolName)) return undefined
    const details: CursorWorkDetail[] = []
    pushDetail(details, '命名空间', input?.namespace)
    pushDetail(details, '服务', input?.server)
    pushDetail(details, '参数', JSON.stringify(input?.arguments ?? {}), 'code')
    return { text: `调用 ${toolName}`, toolName, toolKind: 'mcp', details: details.length ? details : undefined }
  }
  // 模式/命令类参数信息量高于路径类：Glob 的模式、Grep 的关键词、Shell 的命令
  const hint = [
    input?.glob_pattern, input?.pattern, input?.query, input?.command, input?.cmd,
    input?.path, input?.file_path, input?.target_file, input?.target_directory, input?.url
  ].map((value) => boundedString(value, 120)).find(Boolean)
  return {
    text: hint ? `${name} ${hint}` : name,
    toolName: name,
    toolKind: workToolKind(name),
    details: workToolDetails(name, input, rawInput)
  }
}

function toolInputOf(block: UnknownRecord): UnknownRecord | undefined {
  return recordOf(block.input)
}

function protocolToolName(block: UnknownRecord): string | undefined {
  if (block.name !== 'CallMcpTool' && block.name !== 'CallDynamicTool') return undefined
  return boundedString(toolInputOf(block)?.toolName, 160)
}

function protocolTurn(block: UnknownRecord): string | undefined {
  const toolName = protocolToolName(block)
  if (toolName !== 'record_process' && toolName !== 'record_reply') return undefined
  const args = recordOf(toolInputOf(block)?.arguments)
  return boundedString(args?.turn, 120)
}

function visibleToolSummary(block: UnknownRecord):
  | { text: string; toolName?: string; toolKind: CursorWorkToolKind; todos?: CursorWorkTodo[]; details?: CursorWorkDetail[] }
  | undefined {
  if (block.type !== 'tool_use') return undefined
  const name = boundedString(block.name, 120)
  if (!name) return undefined
  return workToolSummary(name, toolInputOf(block), block.input)
}

function parseTranscriptWorkLine(line: string, lineNumber: number, at: number): ParsedTranscriptWorkLine {
  let entry: UnknownRecord | undefined
  try { entry = recordOf(JSON.parse(line)) } catch { return { entries: [], closesTurn: false } }
  if (!entry || entry.role !== 'assistant') return { entries: [], closesTurn: false }
  const message = recordOf(entry.message)
  const content = Array.isArray(message?.content) ? recordArray(message.content) : []
  const entries: CursorWorkEntry[] = []
  let explicitTurn: string | undefined
  let closesTurn = false
  let protocolOnly = false
  let hasRecordProcess = false
  let hasVisibleTool = false

  for (const block of content) {
    if (block.type !== 'tool_use') continue
    const toolName = protocolToolName(block)
    const turn = protocolTurn(block)
    if (turn) explicitTurn = turn
    if (toolName === 'record_reply') closesTurn = true
    if (toolName === 'record_process') hasRecordProcess = true
    const visibleSummary = visibleToolSummary(block)
    if (visibleSummary) hasVisibleTool = true
    else if (toolName || block.name === 'GetDynamicTools') protocolOnly = true
  }

  // 只有内部协议工具的行（等待/同步/团队回执）常伴随“继续轮询”等旁白；
  // 这些不是用户要看的 Cursor 工作过程。record_process 例外：它通常携带本轮过程说明。
  const suppressText = protocolOnly && !hasVisibleTool && !hasRecordProcess

  for (const block of content) {
    if (block.type === 'text') {
      if (suppressText || typeof block.text !== 'string') continue
      // 叙述保留换行（多段叙述/推理），只截断不压缩
      const text = block.text.trim()
      if (!text || isRedactedOnlyText(text)) continue
      entries.push({
        kind: 'text',
        text: text.length > MAX_WORK_TEXT_CHARS ? `${text.slice(0, MAX_WORK_TEXT_CHARS)}…` : text,
        line: lineNumber,
        at
      })
      continue
    }
    const summary = visibleToolSummary(block)
    if (!summary) continue
    entries.push({
      kind: 'tool',
      text: summary.text,
      toolName: summary.toolName,
      toolKind: summary.toolKind,
      todos: summary.todos,
      details: summary.details,
      status: 'running',
      line: lineNumber,
      at
    })
  }
  return { entries, explicitTurn, closesTurn }
}

/**
 * 从单行转录解析助手侧过程条目（可见叙述 / 工具调用摘要）。
 * 只处理 role=assistant 行；user 行是启动提示词或工具结果，不属于 Agent 的工作动作。
 * 工具条目标记 running，由增量读取层在后续新条目出现时翻转为 done。
 */
export function workEntriesFromTranscriptLine(line: string, lineNumber: number, at: number): CursorWorkEntry[] {
  return parseTranscriptWorkLine(line, lineNumber, at).entries
}

export interface CursorComposerTelemetryPaths {
  globalStateDatabase: string
  projectsRoot: string
  workspaceStorageRoot: string
}

export interface CursorComposerTelemetryReaderOptions extends Partial<CursorComposerTelemetryPaths> {
  now?: () => number
  isProcessAlive?: (pid: number) => boolean
}

export interface CursorComposerTelemetrySource {
  readWorkspace(workspacePath: string, bindings: RuntimeBinding[]): CursorTelemetrySnapshot
}

function defaultPaths(): CursorComposerTelemetryPaths {
  const supportRoot = process.env.QINGTIAN_CURSOR_SUPPORT_ROOT?.trim()
    || join(homedir(), 'Library', 'Application Support', 'Cursor')
  return {
    globalStateDatabase: process.env.QINGTIAN_CURSOR_GLOBAL_STATE?.trim()
      || join(supportRoot, 'User', 'globalStorage', 'state.vscdb'),
    projectsRoot: process.env.QINGTIAN_CURSOR_PROJECTS_ROOT?.trim()
      || join(homedir(), '.cursor', 'projects'),
    workspaceStorageRoot: process.env.QINGTIAN_CURSOR_WORKSPACE_STORAGE?.trim()
      || join(supportRoot, 'User', 'workspaceStorage')
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function recordOf(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number === undefined || number < 0 ? undefined : Math.round(number)
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, maxLength) : undefined
}

function sqliteText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return undefined
}

function recordArray(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return []
  return value.map(recordOf).filter((entry): entry is UnknownRecord => Boolean(entry))
}

function stringArray(value: unknown, maxItems = 100): string[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, maxItems)
    .map((entry) => boundedString(entry, 160))
    .filter((entry): entry is string => Boolean(entry))
}

function catalogEntryMatchesModel(entry: UnknownRecord, modelId: string): boolean {
  return boundedString(entry.name, 160) === modelId
    || boundedString(entry.serverModelName, 160) === modelId
    || stringArray(entry.idAliases).includes(modelId)
    || stringArray(entry.legacySlugs).includes(modelId)
}

function selectedParameterMap(selection: UnknownRecord): Map<string, string> {
  const parameters = new Map<string, string>()
  for (const parameter of recordArray(selection.parameters).slice(0, 32)) {
    const id = boundedString(parameter.id, 80)
    const value = boundedString(parameter.value, 160)
    if (id && value !== undefined) parameters.set(id, value)
  }
  return parameters
}

function matchingVariant(entry: UnknownRecord, selected: Map<string, string>): UnknownRecord | undefined {
  return recordArray(entry.variants).find((variant) => {
    const values = recordArray(variant.parameterValues)
    if (values.length !== selected.size) return false
    return values.every((value) => {
      const id = boundedString(value.id, 80)
      const selectedValue = id ? selected.get(id) : undefined
      return selectedValue !== undefined && selectedValue === boundedString(value.value, 160)
    })
  })
}

function readableParameterValue(value: string): string {
  const normalized = value.trim()
  if (/^\d+(?:\.\d+)?[km]$/i.test(normalized)) return normalized.toUpperCase()
  const labels: Record<string, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Max'
  }
  return labels[normalized.toLowerCase()] ?? normalized
}

function selectedOptionLabels(entry: UnknownRecord, selected: Map<string, string>): string[] {
  const definitions = new Map(recordArray(entry.parameterDefinitions).flatMap((definition) => {
    const id = boundedString(definition.id, 80)
    return id ? [[id, definition] as const] : []
  }))
  const labels: string[] = []
  for (const [id, value] of selected) {
    const definition = definitions.get(id)
    if (!definition) continue
    const parameterType = recordOf(definition.parameterType)
    const booleanParameter = recordOf(parameterType?.booleanParameter)
    const enumParameter = recordOf(parameterType?.enumParameter)
    if (booleanParameter && value !== 'true') continue
    const valueDefinition = recordArray(booleanParameter?.values ?? enumParameter?.values).find(
      (candidate) => boundedString(candidate.value, 160) === value
    )
    const label = boundedString(valueDefinition?.displayName, 80)
      || (booleanParameter ? boundedString(definition.name, 80) : readableParameterValue(value))
    if (label && !labels.includes(label)) labels.push(label)
  }
  return labels
}

function selectedContextTokenLimit(entry: UnknownRecord, selected: Map<string, string>): number | undefined {
  const selectedContext = selected.get('context')?.trim().toLowerCase()
  const match = selectedContext?.match(/^(\d+(?:\.\d+)?)([km])$/)
  if (match) {
    const amount = Number(match[1])
    if (Number.isFinite(amount)) return Math.round(amount * (match[2] === 'm' ? 1_000_000 : 1_000))
  }
  return nonNegativeInteger(entry.contextTokenLimit)
}

function parseComposerProfile(value: unknown): AgentExecutionProfile | undefined {
  const root = recordOf(value)
  const aiSettings = recordOf(root?.aiSettings)
  const modelConfig = recordOf(aiSettings?.modelConfig)
  const composerConfig = recordOf(modelConfig?.composer)
  if (!root || !composerConfig) return undefined

  const selectedModel = recordArray(composerConfig.selectedModels)[0]
  const modelId = boundedString(selectedModel?.modelId, 160)
    || boundedString(composerConfig.modelName, 160)
  if (!modelId) return undefined

  const entry = recordArray(root.availableDefaultModels2).find(
    (candidate) => catalogEntryMatchesModel(candidate, modelId)
  )
  if (!entry) return undefined

  const displayName = boundedString(entry.inputboxShortModelName, 160)
    || boundedString(entry.clientDisplayName, 160)
    || boundedString(entry.name, 160)
  if (!displayName) return undefined

  const parameters = selectedModel ? selectedParameterMap(selectedModel) : new Map<string, string>()
  const variant = matchingVariant(entry, parameters)
  return {
    scope: 'cursor-composer-current',
    modelId,
    displayName,
    options: selectedOptionLabels(entry, parameters),
    maxMode: variant?.isMaxMode === true,
    contextTokenLimit: selectedContextTokenLimit(entry, parameters)
  }
}

function cursorParameterDefinitions(entry: UnknownRecord): CursorModelParameterDefinition[] {
  return recordArray(entry.parameterDefinitions).slice(0, 12).flatMap((definition) => {
    const id = boundedString(definition.id, 80)
    const displayName = boundedString(definition.name, 80) || id
    const parameterType = recordOf(definition.parameterType)
    const booleanParameter = recordOf(parameterType?.booleanParameter)
    const enumParameter = recordOf(parameterType?.enumParameter)
    const kind = booleanParameter ? 'boolean' as const : enumParameter ? 'enum' as const : undefined
    const rawValues = recordArray(booleanParameter?.values ?? enumParameter?.values).slice(0, 24)
    if (!id || !displayName || !kind || !rawValues.length) return []
    const values = rawValues.flatMap((rawValue) => {
      const parameterValue = boundedString(rawValue.value, 160)
      if (parameterValue === undefined) return []
      const fallback = kind === 'boolean'
        ? parameterValue === 'true' ? 'On' : 'Off'
        : readableParameterValue(parameterValue)
      return [{
        value: parameterValue,
        displayName: boundedString(rawValue.displayName, 80) || fallback,
        increasesCost: rawValue.increasesModelCost === true
      }]
    })
    return values.length ? [{
      id,
      displayName,
      kind,
      values,
      tooltip: boundedString(definition.markdownTooltip, 500)
    }] : []
  })
}

function parametersOf(value: unknown): CursorModelParameter[] {
  return recordArray(value).slice(0, 32).flatMap((parameter) => {
    const id = boundedString(parameter.id, 80)
    const parameterValue = boundedString(parameter.value, 160)
    return id && parameterValue !== undefined ? [{ id, value: parameterValue }] : []
  })
}

function defaultModelParameters(entry: UnknownRecord): CursorModelParameter[] {
  const variants = recordArray(entry.variants).slice(0, 256)
  const preferred = variants.find((variant) => variant.isDefaultNonMaxConfig === true)
    ?? variants.find((variant) => variant.isDefaultMaxConfig === true)
    ?? variants[0]
  return parametersOf(preferred?.parameterValues)
}

function completeModelParameters(
  definitions: CursorModelParameterDefinition[],
  primary: CursorModelParameter[],
  fallback: CursorModelParameter[]
): CursorModelParameter[] {
  const primaryById = new Map(primary.map((parameter) => [parameter.id, parameter.value]))
  const fallbackById = new Map(fallback.map((parameter) => [parameter.id, parameter.value]))
  return definitions.flatMap((definition) => {
    const candidate = primaryById.get(definition.id) ?? fallbackById.get(definition.id)
    const value = definition.values.some((option) => option.value === candidate)
      ? candidate
      : definition.values[0]?.value
    return value === undefined ? [] : [{ id: definition.id, value }]
  })
}

function parseCursorModels(value: unknown): CursorModelOption[] {
  const root = recordOf(value)
  const aiSettings = recordOf(root?.aiSettings)
  const modelConfig = recordOf(aiSettings?.modelConfig)
  const composerConfig = recordOf(modelConfig?.composer)
  const selectedModel = recordArray(composerConfig?.selectedModels)[0]
  const selectedModelId = boundedString(selectedModel?.modelId, 160)
    || boundedString(composerConfig?.modelName, 160)
  const selectedParameters = parametersOf(selectedModel?.parameters)
  const options = new Map<string, CursorModelOption>()
  for (const entry of recordArray(root?.availableDefaultModels2).slice(0, 160)) {
    if (entry.hidden === true || entry.isHidden === true || entry.isEnabled === false) continue
    const modelId = boundedString(entry.name, 160) || boundedString(entry.serverModelName, 160)
    if (!modelId || options.has(modelId)) continue
    const displayName = boundedString(entry.inputboxShortModelName, 160)
      || boundedString(entry.clientDisplayName, 160)
      || modelId
    const selected = modelId === selectedModelId || catalogEntryMatchesModel(entry, selectedModelId ?? '')
    const parameterDefinitions = cursorParameterDefinitions(entry)
    const defaultParameters = defaultModelParameters(entry)
    const parameters = completeModelParameters(
      parameterDefinitions,
      selected ? selectedParameters : defaultParameters,
      defaultParameters
    )
    const parameterMap = new Map(parameters.map((parameter) => [parameter.id, parameter.value]))
    options.set(modelId, {
      modelId,
      displayName,
      parameters,
      selected,
      optionLabels: selected ? selectedOptionLabels(entry, parameterMap) : [],
      parameterDefinitions,
      contextTokenLimit: selectedContextTokenLimit(entry, parameterMap)
    })
  }
  if (selectedModelId && ![...options.values()].some((option) => option.selected)) {
    options.set(selectedModelId, {
      modelId: selectedModelId,
      displayName: selectedModelId,
      parameters: selectedParameters,
      selected: true,
      optionLabels: [],
      parameterDefinitions: [],
      contextTokenLimit: undefined
    })
  }
  return [...options.values()]
    .sort((left, right) => Number(right.selected) - Number(left.selected)
      || left.displayName.localeCompare(right.displayName))
    .slice(0, 80)
}

function readComposerModelState(database: DatabaseSync): {
  profile?: AgentExecutionProfile
  models: CursorModelOption[]
} {
  try {
    const row = database.prepare(
      'SELECT value FROM ItemTable WHERE key = ?'
    ).get(APPLICATION_USER_KEY) as { value?: unknown } | undefined
    const json = sqliteText(row?.value)
    if (!json || Buffer.byteLength(json, 'utf8') > MAX_APPLICATION_USER_BYTES) return { models: [] }
    const value = JSON.parse(json)
    return { profile: parseComposerProfile(value), models: parseCursorModels(value) }
  } catch {
    // Composer headers remain useful even if Cursor changes or is midway
    // through writing this unrelated global preference record.
    return { models: [] }
  }
}

function canonicalPath(value: string): string {
  let path = value.trim()
  if (!path) return ''
  if (path.startsWith('file://')) {
    try {
      path = fileURLToPath(path)
    } catch {
      return ''
    }
  }
  const resolved = normalize(resolve(path))
  let canonical = resolved
  try {
    canonical = realpathSync.native(resolved)
  } catch {
    // The workspace may have been moved or temporarily unavailable. The
    // normalized absolute path still provides a safe exact-match fallback.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function workspacePathOf(header: UnknownRecord): string {
  const identifier = recordOf(header.workspaceIdentifier)
  if (!identifier) return ''
  const uri = recordOf(identifier.uri)
  return boundedString(uri?.fsPath, 8_192)
    || boundedString(uri?.external, 8_192)
    || ''
}

function workspaceStorageIdOf(header: UnknownRecord): string | undefined {
  const identifier = recordOf(header.workspaceIdentifier)
  const id = boundedString(identifier?.id, 64)?.toLowerCase()
  return id && SAFE_WORKSPACE_STORAGE_ID.test(id) ? id : undefined
}

function optionalModelName(header: UnknownRecord): string | undefined {
  const modelConfig = recordOf(header.modelConfig)
  return boundedString(header.modelName, 160)
    || boundedString(header.model, 160)
    || boundedString(modelConfig?.modelName, 160)
}

function parseComposer(header: unknown, expectedWorkspace: string): ParsedComposer | undefined {
  const value = recordOf(header)
  if (!value) return undefined
  const composerId = boundedString(value.composerId, 128)
  if (!composerId || !SAFE_COMPOSER_ID.test(composerId)) return undefined
  // expectedWorkspace 为空串时跳过工作区过滤（全局水合：按 composerId 精确定位）
  if (expectedWorkspace && canonicalPath(workspacePathOf(value)) !== expectedWorkspace) return undefined

  const createdAt = finiteNumber(value.createdAt)
  const lastUpdatedAt = finiteNumber(value.lastUpdatedAt)
  const contextPercent = finiteNumber(value.contextUsagePercent)
  const contextTokensUsed = nonNegativeInteger(value.contextTokensUsed)
  const contextTokenLimit = nonNegativeInteger(value.contextTokenLimit)
    ?? nonNegativeInteger(value.contextWindowSize)
  const additions = nonNegativeInteger(value.totalLinesAdded)
  const deletions = nonNegativeInteger(value.totalLinesRemoved)
  const files = nonNegativeInteger(value.filesChangedCount)
  const title = boundedString(value.name, 240) || `Cursor 会话 ${composerId.slice(0, 8)}`
  const subtitle = boundedString(value.subtitle, 1_200) || ''

  const normalizedPercent = contextPercent === undefined
    ? undefined
    : Math.min(100, Math.max(0, contextPercent))
  const hasChanges = additions !== undefined || deletions !== undefined || files !== undefined

  return {
    telemetry: {
      composerId,
      title,
      createdAt,
      lastUpdatedAt,
      modelName: optionalModelName(value),
      contextUsage: normalizedPercent === undefined ? undefined : {
        used: contextTokensUsed,
        limit: contextTokenLimit,
        ratio: normalizedPercent / 100
      },
      changes: hasChanges ? {
        additions: additions ?? 0,
        deletions: deletions ?? 0,
        files
      } : undefined
    },
    bindingText: `${title}\n${subtitle}`,
    workspaceStorageId: workspaceStorageIdOf(value)
  }
}

function cursorProjectDirectoryNames(workspacePath: string): string[] {
  const withoutRoot = normalize(workspacePath).replace(/^[/\\]+/, '')
  const separatorSlug = withoutRoot.replace(/[:/\\]+/g, '-')
  const strictSlug = withoutRoot.replace(/[^\p{L}\p{N}._-]+/gu, '-')
  return [...new Set([separatorSlug, strictSlug].filter(Boolean))]
}

function emptyTranscriptSignals(): TranscriptSignals {
  return { bindingMarkers: new Set(), channelIds: new Set() }
}

function channelIdFromServer(server: unknown): string | undefined {
  const value = boundedString(server, 512)
  return value?.match(/(?:^|-)qtwx-mcp-(\d{1,12})(?:$|-)/)?.[1]
}

/** 统一服务器（qunshu）按工具参数 channel_id 区分通道——从调用参数提取通道号。 */
function channelIdFromArguments(args: UnknownRecord | undefined): string | undefined {
  const value = boundedString(args?.channel_id, 12)
  return value && /^\d{1,12}$/.test(value) ? value : undefined
}

function channelIdFromToolInput(input: UnknownRecord | undefined): string | undefined {
  return channelIdFromServer(input?.server)
    ?? channelIdFromServer(input?.namespace)
    ?? channelIdFromArguments(recordOf(input?.arguments))
}

function lastTranscriptAction(text: string): TranscriptAction | undefined {
  const lines = text.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    let entry: UnknownRecord | undefined
    try {
      entry = recordOf(JSON.parse(line))
    } catch {
      continue
    }
    if (entry?.role !== 'assistant') continue
    const message = recordOf(entry.message)
    const content = Array.isArray(message?.content) ? message.content : []
    for (let itemIndex = content.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = recordOf(content[itemIndex])
      if (!item) continue
      if (item.type === 'tool_use') {
        const input = recordOf(item.input)
        // Cursor 既有旧版 CallMcpTool，也有新版 CallDynamicTool。GetDynamicTools
        // 只是发现工具，不代表 Agent 真的执行了任何动作，必须继续向前找。
        if (item.name === 'GetDynamicTools') continue
        if (item.name !== 'CallMcpTool' && item.name !== 'CallDynamicTool') return { kind: 'tool' }
        const toolName = boundedString(input?.toolName, 160)
        const channelId = channelIdFromToolInput(input)
        if (toolName === 'check_messages') return { kind: 'check_messages', toolName, channelId }
        if (toolName === 'record_reply') return { kind: 'record_reply', toolName, channelId }
        return { kind: 'tool', toolName, channelId }
      }
      if (item.type === 'text' && boundedString(item.text, 2)) return { kind: 'assistant' }
    }
  }
  return undefined
}

function extractTranscriptSignals(text: string): TranscriptSignals {
  const signals = emptyTranscriptSignals()
  for (const match of text.matchAll(
    /\[\[QINGTIAN_TEAM_BIND:[a-zA-Z0-9_-]{1,128}:CH-\d{1,12}\]\]/g
  )) {
    signals.bindingMarkers.add(match[0])
  }
  for (const match of text.matchAll(/(?:qtwx-mcp|qingtian-team-ch)-(\d{1,12})/g)) {
    signals.channelIds.add(match[1]!)
  }
  // 统一服务器（qunshu）形态：服务器名不含通道号，通道身份在工具参数 channel_id 里
  for (const match of text.matchAll(/"channel_id"\s*:\s*"(\d{1,12})"/g)) {
    signals.channelIds.add(match[1]!)
  }
  signals.lastAction = lastTranscriptAction(text)
  return signals
}

function mergeTranscriptSignals(...values: TranscriptSignals[]): TranscriptSignals {
  const merged = emptyTranscriptSignals()
  for (const value of values) {
    for (const marker of value.bindingMarkers) merged.bindingMarkers.add(marker)
    for (const channelId of value.channelIds) merged.channelIds.add(channelId)
    if (value.lastAction) merged.lastAction = value.lastAction
    if (value.modifiedAt !== undefined) merged.modifiedAt = value.modifiedAt
  }
  return merged
}

function transcriptMarkerWindow(path: string): string {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size <= 0) return ''
    const maxWindowBytes = MAX_TRANSCRIPT_HEAD_BYTES + MAX_TRANSCRIPT_TAIL_BYTES
    if (stat.size <= maxWindowBytes) {
      return readFileSync(path, 'utf8')
    }
    const head = Buffer.allocUnsafe(MAX_TRANSCRIPT_HEAD_BYTES)
    const tail = Buffer.allocUnsafe(MAX_TRANSCRIPT_TAIL_BYTES)
    const descriptor = openSync(path, 'r')
    try {
      readSync(descriptor, head, 0, head.length, 0)
      readSync(descriptor, tail, 0, tail.length, stat.size - tail.length)
      return `${head.toString('utf8')}\n${tail.toString('utf8')}`
    } finally {
      closeSync(descriptor)
    }
  } catch {
    return ''
  }
}

/** 项目目录清单缓存：目录 mtime 在增删条目时变化，以此作缓存键（无 TTL 陈旧问题）。 */
let projectsDirCache: { root: string; mtimeMs: number; names: string[] } | undefined

function projectDirectoryNames(projectsRoot: string): string[] {
  try {
    const stat = statSync(projectsRoot)
    if (
      projectsDirCache &&
      projectsDirCache.root === projectsRoot &&
      projectsDirCache.mtimeMs === stat.mtimeMs
    ) return projectsDirCache.names
    const names = readdirSync(projectsRoot)
      .filter((name) => !name.startsWith('.'))
      .slice(0, MAX_PROJECT_DIRS)
    projectsDirCache = { root: projectsRoot, mtimeMs: stat.mtimeMs, names }
    return names
  } catch {
    return []
  }
}

/**
 * 全局回退扫描：新版 Cursor 对部分工作区改用数字时间戳项目目录（窗口会话级），
 * 「工作区路径 → 目录名」推导必然失配；同一 composer 也可能落在与观测工作区
 * 不同的项目目录（如临时/e2e 工作区）。composerId 是全局唯一 UUID，
 * 按它跨目录定位转录是安全的；取最新 mtime 命中，兼容同 composer 重开窗口。
 */
function transcriptPathGlobalFallback(
  paths: CursorComposerTelemetryPaths,
  composerId: string,
  tried: Set<string>
): string | undefined {
  if (!SAFE_COMPOSER_ID.test(composerId)) return undefined
  let newest: { path: string; modifiedAt: number } | undefined
  for (const directoryName of projectDirectoryNames(paths.projectsRoot)) {
    if (tried.has(directoryName)) continue
    const candidate = join(
      paths.projectsRoot,
      directoryName,
      'agent-transcripts',
      composerId,
      `${composerId}.jsonl`
    )
    try {
      const stat = statSync(candidate)
      if (!stat.isFile()) continue
      if (!newest || stat.mtimeMs > newest.modifiedAt) {
        newest = { path: candidate, modifiedAt: stat.mtimeMs }
      }
    } catch {
      // 候选不存在——继续下一个项目目录
    }
  }
  return newest?.path
}

function transcriptPath(
  paths: CursorComposerTelemetryPaths,
  workspacePaths: string[],
  composer: ParsedComposer
): string | undefined {
  const tried = new Set<string>()
  for (const workspacePath of [...new Set(workspacePaths)]) {
    for (const directoryName of cursorProjectDirectoryNames(workspacePath)) {
      tried.add(directoryName)
      const candidate = join(
        paths.projectsRoot,
        directoryName,
        'agent-transcripts',
        composer.telemetry.composerId,
        `${composer.telemetry.composerId}.jsonl`
      )
      if (existsSync(candidate)) return candidate
    }
  }
  return transcriptPathGlobalFallback(paths, composer.telemetry.composerId, tried)
}

interface RuntimeLeaseState {
  observed: boolean
  connected: boolean
  waiting: boolean
  detail: string
  /**
   * 正面死亡/矛盾证据：心跳进程死亡、明确断开记录、连接属于旧运行时（所有权冲突）。
   * false 表示仅时间陈旧——Agent 干活时不碰 MCP，租约自然过期（~20s），不构成死亡证据。
   */
  fatal: boolean
}

function readSmallJson(path: string): UnknownRecord | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RUNTIME_STATE_BYTES) return undefined
    return recordOf(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

function runtimeTimestamp(value: UnknownRecord | undefined, primary: string): number | undefined {
  return finiteNumber(value?.[primary]) ?? finiteNumber(value?.updatedAt)
}

function runtimePid(value: UnknownRecord | undefined): number | undefined {
  const pid = nonNegativeInteger(value?.pid)
  return pid && pid > 0 ? pid : undefined
}

function runtimeStamp(value: UnknownRecord | undefined): string | undefined {
  return boundedString(value?.runtimeStamp, 160)
}

function runtimeIdentityMatches(left: UnknownRecord | undefined, right: UnknownRecord | undefined): boolean {
  const leftPid = runtimePid(left)
  const rightPid = runtimePid(right)
  const leftStamp = runtimeStamp(left)
  const rightStamp = runtimeStamp(right)
  return Boolean(
    leftPid && rightPid && leftPid === rightPid
    && leftStamp && rightStamp && leftStamp === rightStamp
  )
}

function timestampIsFresh(value: number | undefined, now: number): boolean {
  if (value === undefined) return false
  return value <= now + 5_000 && value >= now - RUNTIME_STATE_FRESH_MS
}

function readRuntimeLease(
  paths: CursorComposerTelemetryPaths,
  workspaceStorageId: string | undefined,
  channelId: string,
  now: number,
  isProcessAlive: (pid: number) => boolean
): RuntimeLeaseState {
  if (!workspaceStorageId || !/^\d{1,12}$/.test(channelId)) {
    return { observed: false, connected: false, waiting: false, fatal: false, detail: '未找到当前工作区运行态' }
  }
  const channelRoot = join(
    paths.workspaceStorageRoot,
    workspaceStorageId,
    'QingTian.qingtian-v2',
    'runtime',
    'messages',
    's',
    channelId
  )
  if (!existsSync(channelRoot)) {
    return { observed: false, connected: false, waiting: false, fatal: false, detail: '当前工作区没有通道运行态' }
  }

  const heartbeat = readSmallJson(join(channelRoot, 'heartbeat.json'))
  const connection = readSmallJson(join(channelRoot, 'connection.json'))
  const waiting = readSmallJson(join(channelRoot, 'waiting.json'))
  const heartbeatPid = runtimePid(heartbeat)
  const heartbeatDead = !heartbeatPid || !isProcessAlive(heartbeatPid)
  if (heartbeatDead || !timestampIsFresh(runtimeTimestamp(heartbeat, 'lastSeen'), now)) {
    // 进程死亡是正面死亡证据；仅时间陈旧（进程仍在）不是——可能只是写入节奏暂停
    return {
      observed: true,
      connected: false,
      waiting: false,
      fatal: heartbeatDead,
      detail: heartbeatDead ? 'MCP 运行时心跳已失效' : 'MCP 运行时心跳陈旧（进程仍在）'
    }
  }
  const waitingActive = waiting?.active === true
    && timestampIsFresh(runtimeTimestamp(waiting, 'updatedAt'), now)
    && runtimeIdentityMatches(heartbeat, waiting)
  const connectionDisconnected = Boolean(connection) && connection?.active !== true
  const connectionIdentityConflict = Boolean(connection) && !runtimeIdentityMatches(heartbeat, connection)
  if (
    connectionDisconnected
    || connectionIdentityConflict
    || !timestampIsFresh(runtimeTimestamp(connection, 'updatedAt'), now)
  ) {
    // 明确断开记录或所有权冲突 = 正面矛盾证据（fatal）；
    // 仅 updatedAt 超时 = Agent 干活中未碰 MCP 的正常现象（非 fatal）
    const fatal = connectionDisconnected || connectionIdentityConflict
    return {
      observed: true,
      connected: false,
      waiting: waitingActive,
      fatal,
      detail: fatal
        ? 'MCP 进程仍在，但 Agent 连接属于旧运行时或已结束'
        : 'MCP 进程仍在，Agent 连接租约随工作刷新暂停（时间陈旧）'
    }
  }
  return {
    observed: true,
    connected: true,
    waiting: waitingActive,
    fatal: false,
    detail: waitingActive ? '当前 Cursor Agent 正在长轮询待命' : '当前 Cursor Agent 正在执行'
  }
}

function composerActivity(
  signals: TranscriptSignals,
  expectedChannelId: string | undefined,
  lease: RuntimeLeaseState,
  now: number,
  composerLastUpdatedAt?: number
): CursorComposerActivity {
  const action = signals.lastAction
  // 干活时在线：转录 mtime 与 Cursor composer 行更新时间取新者——
  // 长命令执行期间转录暂停增长，但 Cursor 仍会刷新 composer 状态行。
  const observedAt = Math.max(
    signals.modifiedAt ?? 0,
    composerLastUpdatedAt ?? 0
  ) || signals.modifiedAt
  if (!action) {
    return { state: 'unknown', detail: 'Cursor 会话尚未留下可验证的 Agent 活动', observedAt }
  }
  if (expectedChannelId && action.channelId && action.channelId !== expectedChannelId) {
    return {
      state: 'stopped',
      detail: `会话最后连接的是 CH-${action.channelId}，不是当前 CH-${expectedChannelId}`,
      observedAt,
      channelId: action.channelId
    }
  }
  if (action.kind === 'record_reply') {
    // 转录异步落盘：record_reply 行与紧随其后的 check_messages 行之间存在 flush
    // 窗口，且协议强制 record_reply 后必须立即回到 check_messages。活动仍新鲜时
    // 读到「最后动作 = record_reply」是落盘时序差，不是停止监听。
    const recent = observedAt !== undefined && now - observedAt <= RECENT_TRANSCRIPT_GRACE_MS
    if (recent) {
      return {
        state: 'active',
        detail: '刚同步回复，正在进入下一轮监听（转录落盘窗口）',
        observedAt,
        channelId: expectedChannelId ?? action.channelId
      }
    }
    return {
      state: 'stopped',
      detail: '已同步最后回复，但未再次进入 check_messages；Agent 已停止监听',
      observedAt,
      channelId: expectedChannelId ?? action.channelId
    }
  }
  // 正面死亡/矛盾证据（心跳进程死亡、明确断开、连接属于旧运行时）才允许直接判 stopped；
  // 仅时间陈旧不构成死亡证据——Agent 干活时不碰 MCP，租约自然过期（~20s）
  if (lease.observed && !lease.connected && lease.fatal) {
    return {
      state: 'stopped',
      detail: lease.detail,
      observedAt,
      channelId: expectedChannelId ?? action.channelId
    }
  }
  const transcriptAge = observedAt === undefined ? undefined : Math.max(0, now - observedAt)
  const transcriptRecent = transcriptAge !== undefined && transcriptAge <= RECENT_TRANSCRIPT_GRACE_MS
  if (action.kind === 'check_messages') {
    if (lease.observed && !lease.waiting) {
      // 长轮询刚结束 = 接到活开始干：思考/生成阶段不会产生新 action，但转录文件仍在增长
      if (transcriptRecent) {
        return {
          state: 'active',
          detail: '长轮询已结束，Agent 正在处理（转录活动新鲜）',
          observedAt,
          channelId: expectedChannelId ?? action.channelId
        }
      }
      return {
        state: 'stopped',
        detail: 'Cursor 曾调用 check_messages，但当前等待租约已经结束',
        observedAt,
        channelId: expectedChannelId ?? action.channelId
      }
    }
    return {
      state: 'waiting',
      detail: 'Cursor 会话与当前 MCP 等待租约均有效',
      observedAt,
      channelId: expectedChannelId ?? action.channelId
    }
  }
  // 干活特征（tool/assistant）：转录增长是硬生存证据，优先级高于租约时间陈旧
  if (transcriptRecent || lease.connected) {
    return {
      state: 'active',
      detail: lease.connected ? lease.detail : 'Cursor 会话刚刚产生新的 Agent 活动',
      observedAt,
      channelId: expectedChannelId ?? action.channelId
    }
  }
  // 长任务执行中（构建/测试等），转录暂停增长属正常——宽限期内按「干活中、活性未验证」处理
  if (transcriptAge !== undefined && transcriptAge <= WORK_ACTIVITY_GRACE_MS) {
    return {
      state: 'unknown',
      workInProgress: true,
      detail: 'Agent 疑似在执行长任务（转录暂停增长），无死亡证据',
      observedAt,
      channelId: expectedChannelId ?? action.channelId
    }
  }
  return {
    state: 'unknown',
    detail: '无法确认 Cursor Agent 是否仍在执行',
    observedAt,
    channelId: expectedChannelId ?? action.channelId
  }
}

/** 跨全部项目目录枚举转录文件（新→旧，截断上限），供通道级证据扫描。 */
function listTranscriptFiles(projectsRoot: string): { path: string; modifiedAt: number; composerId: string }[] {
  const files: { path: string; modifiedAt: number; composerId: string }[] = []
  for (const directoryName of projectDirectoryNames(projectsRoot)) {
    const transcriptsRoot = join(projectsRoot, directoryName, 'agent-transcripts')
    let composerDirs: string[]
    try {
      composerDirs = readdirSync(transcriptsRoot)
    } catch {
      continue
    }
    for (const composerDir of composerDirs) {
      if (!SAFE_COMPOSER_ID.test(composerDir)) continue
      const candidate = join(transcriptsRoot, composerDir, `${composerDir}.jsonl`)
      try {
        const stat = statSync(candidate)
        if (stat.isFile()) files.push({ path: candidate, modifiedAt: stat.mtimeMs, composerId: composerDir })
      } catch {
        // 转录在扫描期间被清理——跳过
      }
    }
  }
  return files
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, CHANNEL_SCAN_MAX_FILES)
}

/**
 * 通道级产出活性判定。正面停止证据才允许判 stopped：
 * - record_reply 收尾 = Agent 明确退出「回复 → 再监听」循环（与 composerActivity 同规则）；
 * - 转录沉默超僵尸上限 = 与传输层轮询保活声称直接矛盾（真实轮询每次都会写转录）。
 * 其余（无动作、沉默未达上限）一律 unknown——证据缺失不构成死亡证据。
 */
function channelActivityFromSignals(
  channelId: string,
  signals: TranscriptSignals,
  now: number
): CursorChannelActivity {
  const action = signals.lastAction
  const observedAt = signals.modifiedAt
  if (!action || observedAt === undefined) {
    return { channelId, state: 'unknown', detail: '通道会话转录中缺少可验证的 Agent 活动', observedAt }
  }
  const age = Math.max(0, now - observedAt)
  if (age <= RECENT_TRANSCRIPT_GRACE_MS) {
    return { channelId, state: 'active', detail: '通道会话转录仍在增长', observedAt }
  }
  if (action.kind === 'record_reply') {
    return { channelId, state: 'stopped', detail: '通道会话已同步最后回复并停止监听（转录不再增长）', observedAt }
  }
  if (age >= CHANNEL_POLL_SILENCE_MS) {
    return {
      channelId,
      state: 'stopped',
      detail: '通道转录长时间无产出，与传输层轮询保活矛盾（疑似认证失效的僵尸会话）',
      observedAt
    }
  }
  return { channelId, state: 'unknown', detail: '通道会话产出暂停，未达僵尸判定上限', observedAt }
}

function uniqueCandidates(
  matches: Map<string, Set<string>>,
  bindings: RuntimeBinding[],
  occupiedComposerIds: Set<string>,
  method: ComposerBindingCandidate['method']
): ComposerBindingCandidate[] {
  const result: ComposerBindingCandidate[] = []
  const eligibleByChannel = new Map<string, string[]>()
  const composerMatchCounts = new Map<string, number>()
  for (const binding of bindings) {
    if (binding.composerId) continue
    const composerIds = [...(matches.get(binding.channelId) ?? [])]
      .filter((composerId) => !occupiedComposerIds.has(composerId))
    eligibleByChannel.set(binding.channelId, composerIds)
    for (const composerId of composerIds) {
      composerMatchCounts.set(composerId, (composerMatchCounts.get(composerId) ?? 0) + 1)
    }
  }
  for (const binding of bindings) {
    if (binding.composerId) continue
    const composerIds = eligibleByChannel.get(binding.channelId) ?? []
    if (composerIds.length !== 1) continue
    const composerId = composerIds[0]!
    if (composerMatchCounts.get(composerId) !== 1) continue
    result.push({
      channelId: binding.channelId,
      composerId,
      generation: binding.generation,
      bindingKey: binding.composerBindingKey,
      method
    })
  }
  return result
}

function bindingCandidates(
  composers: ParsedComposer[],
  bindings: RuntimeBinding[],
  signalsForComposer: (composer: ParsedComposer) => TranscriptSignals
): ComposerBindingCandidate[] {
  const unbound = bindings.filter((binding) => !binding.composerId)
  if (!unbound.length || !composers.length) return []

  const signalsByComposer = new Map(
    composers.map((composer) => [
      composer.telemetry.composerId,
      mergeTranscriptSignals(
        extractTranscriptSignals(composer.bindingText),
        signalsForComposer(composer)
      )
    ])
  )
  const occupied = new Set(bindings.flatMap((binding) => binding.composerId ? [binding.composerId] : []))
  const exactMatches = new Map<string, Set<string>>()
  for (const binding of unbound) {
    const marker = cursorComposerBindingMarker({
      bindingKey: binding.composerBindingKey,
      channelId: binding.channelId
    })
    for (const [composerId, signals] of signalsByComposer) {
      if (!signals.bindingMarkers.has(marker)) continue
      const channelMatches = exactMatches.get(binding.channelId) ?? new Set<string>()
      channelMatches.add(composerId)
      exactMatches.set(binding.channelId, channelMatches)
    }
  }
  const exact = uniqueCandidates(exactMatches, unbound, occupied, 'launch_marker')
  const exactlyBoundChannels = new Set(exact.map((candidate) => candidate.channelId))
  const exactlyBoundComposers = new Set(exact.map((candidate) => candidate.composerId))

  const channelMatches = new Map<string, Set<string>>()
  const unboundByChannel = new Map(unbound.map((binding) => [binding.channelId, binding]))
  const composerById = new Map(composers.map((composer) => [composer.telemetry.composerId, composer]))
  for (const [composerId, signals] of signalsByComposer) {
    if (occupied.has(composerId) || exactlyBoundComposers.has(composerId)) continue
    // Once a transcript contains a deterministic Team marker, never downgrade
    // it to the less precise legacy channel heuristic. An ambiguous or stale
    // exact marker must remain unbound instead of being guessed.
    if (signals.bindingMarkers.size > 0) continue
    if (signals.channelIds.size !== 1) continue
    const channelId = [...signals.channelIds][0]!
    if (exactlyBoundChannels.has(channelId)) continue
    const fallbackBinding = unboundByChannel.get(channelId)
    const lastUpdatedAt = composerById.get(composerId)?.telemetry.lastUpdatedAt
    if (
      !fallbackBinding ||
      lastUpdatedAt === undefined ||
      lastUpdatedAt < fallbackBinding.installedAt - FALLBACK_BINDING_CLOCK_SKEW_MS
    ) continue
    const matches = channelMatches.get(channelId) ?? new Set<string>()
    matches.add(composerId)
    channelMatches.set(channelId, matches)
  }
  const fallbackBindings = unbound.filter((binding) => !exactlyBoundChannels.has(binding.channelId))
  const fallback = uniqueCandidates(
    channelMatches,
    fallbackBindings,
    new Set([...occupied, ...exactlyBoundComposers]),
    'channel_marker'
  )
  return [...exact, ...fallback]
}

export class CursorComposerTelemetryReader implements CursorComposerTelemetrySource {
  private readonly paths: CursorComposerTelemetryPaths
  private readonly now: () => number
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly transcriptSignalCache = new Map<string, CachedTranscriptSignals>()
  private readonly transcriptWorkCache = new Map<string, CachedTranscriptWork>()
  private readonly channelSignalCache = new Map<string, TranscriptSignals & { path: string }>()

  constructor(options: CursorComposerTelemetryReaderOptions = {}) {
    const { now, isProcessAlive, ...paths } = options
    this.paths = { ...defaultPaths(), ...paths }
    this.now = now ?? Date.now
    this.isProcessAlive = isProcessAlive ?? processIsAlive
  }

  readWorkspace(workspacePath: string, bindings: RuntimeBinding[]): CursorTelemetrySnapshot {
    const channelActivities = this.readChannelActivities(bindings, this.now())
    const snapshot = this.readWorkspaceSnapshot(workspacePath, bindings, channelActivities)
    return channelActivities ? { ...snapshot, channelActivities } : snapshot
  }

  /**
   * 通道级产出活性证据：与 composer 绑定、工作区遥测可用性解耦。
   * 只扫描提到该通道的最新转录，找不到证据的通道不出现在结果里。
   */
  private readChannelActivities(
    bindings: RuntimeBinding[],
    now: number
  ): Record<string, CursorChannelActivity> | undefined {
    const channelIds = [...new Set(
      bindings.map((binding) => binding.channelId).filter((id) => /^\d{1,12}$/.test(id))
    )]
    if (!channelIds.length) return undefined
    const files = listTranscriptFiles(this.paths.projectsRoot)
    if (!files.length) return undefined
    const result: Record<string, CursorChannelActivity> = {}
    for (const channelId of channelIds) {
      for (const file of files) {
        const signals = this.channelTranscriptSignals(file.path, file.modifiedAt)
        if (!signals.channelIds.has(channelId)) continue
        result[channelId] = {
          ...channelActivityFromSignals(channelId, signals, now),
          composerId: file.composerId
        }
        break
      }
    }
    return Object.keys(result).length ? result : undefined
  }

  private channelTranscriptSignals(path: string, modifiedAt: number): TranscriptSignals {
    const cached = this.channelSignalCache.get(path)
    if (cached && cached.modifiedAt === modifiedAt) return cached
    const signals = extractTranscriptSignals(transcriptMarkerWindow(path))
    signals.modifiedAt = modifiedAt
    if (this.channelSignalCache.size >= MAX_TRANSCRIPT_SIGNAL_CACHE) this.channelSignalCache.clear()
    this.channelSignalCache.set(path, { ...signals, path })
    return signals
  }

  /**
   * 全局 launch-marker 扫描：唯一会话标记可能写进任意项目目录的转录
   *（数字时间戳窗口容器、跨工作区窗口），按标记定位 composerId——
   * 这是恢复 composer 绑定（进而恢复上下文/token 显示）的关键链路。
   */
  private globalLaunchMarkerCandidates(bindings: RuntimeBinding[]): ComposerBindingCandidate[] {
    const wanted = new Map<string, RuntimeBinding>()
    for (const binding of bindings) {
      if (binding.composerId) continue
      wanted.set(
        cursorComposerBindingMarker({
          bindingKey: binding.composerBindingKey,
          channelId: binding.channelId
        }),
        binding
      )
    }
    if (!wanted.size) return []
    // 与本地候选同一套「歧义拒绝」不变量：
    // 一个标记出现在多份转录 / 一份转录含多个通道标记——都拒绝猜测，保持未绑定
    const markerToComposers = new Map<string, Set<string>>()
    const composerToMarkers = new Map<string, Set<string>>()
    for (const file of listTranscriptFiles(this.paths.projectsRoot)) {
      const signals = this.channelTranscriptSignals(file.path, file.modifiedAt)
      for (const marker of signals.bindingMarkers) {
        if (!wanted.has(marker)) continue
        const composers = markerToComposers.get(marker) ?? new Set<string>()
        composers.add(file.composerId)
        markerToComposers.set(marker, composers)
        const markers = composerToMarkers.get(file.composerId) ?? new Set<string>()
        markers.add(marker)
        composerToMarkers.set(file.composerId, markers)
      }
    }
    const found: ComposerBindingCandidate[] = []
    for (const [marker, binding] of wanted) {
      const composers = markerToComposers.get(marker)
      if (!composers || composers.size !== 1) continue
      const composerId = [...composers][0]!
      if ((composerToMarkers.get(composerId)?.size ?? 0) !== 1) continue
      found.push({
        channelId: binding.channelId,
        composerId,
        generation: binding.generation,
        bindingKey: binding.composerBindingKey,
        method: 'launch_marker'
      })
    }
    return found
  }

  private readWorkspaceSnapshot(
    workspacePath: string,
    bindings: RuntimeBinding[],
    channelActivities?: Record<string, CursorChannelActivity>
  ): CursorTelemetrySnapshot {
    const normalizedWorkspace = canonicalPath(workspacePath)
    if (!normalizedWorkspace) {
      return emptyCursorTelemetrySnapshot('unavailable', '尚未绑定 Cursor 工作区')
    }
    if (!existsSync(this.paths.globalStateDatabase)) {
      return {
        ...emptyCursorTelemetrySnapshot('unavailable', '找不到 Cursor 本机会话数据库'),
        workspacePath: normalizedWorkspace
      }
    }

    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(this.paths.globalStateDatabase, {
        readOnly: true,
        timeout: 300,
        defensive: true
      })
      database.exec('PRAGMA query_only = ON')
      database.exec('PRAGMA busy_timeout = 300')
      const modelState = readComposerModelState(database)
      const row = database.prepare(
        'SELECT value FROM ItemTable WHERE key = ?'
      ).get(COMPOSER_HEADERS_KEY) as { value?: unknown } | undefined
      const json = sqliteText(row?.value)
      if (!json) {
        return {
          ...emptyCursorTelemetrySnapshot('unavailable', 'Cursor 尚未生成会话遥测'),
          workspacePath: normalizedWorkspace,
          composerProfile: modelState.profile,
          cursorModels: modelState.models
        }
      }
      if (Buffer.byteLength(json, 'utf8') > MAX_HEADERS_BYTES) {
        throw new Error('Cursor 会话索引异常过大，已停止读取')
      }
      const root = recordOf(JSON.parse(json))
      const composerProfile = modelState.profile
      const rawComposers = Array.isArray(root?.allComposers) ? root.allComposers : []
      const parsed = rawComposers
        .map((header) => parseComposer(header, normalizedWorkspace))
        .filter((composer): composer is ParsedComposer => Boolean(composer))
        .sort((left, right) => (right.telemetry.lastUpdatedAt ?? 0) - (left.telemetry.lastUpdatedAt ?? 0))
        .slice(0, MAX_WORKSPACE_COMPOSERS)
      // 全局水合：已绑定或通道转录定位到的 composer 可能属于其他工作区
      //（临时/e2e 工作区、数字时间戳窗口容器），其头部被工作区过滤掉会导致
      // 上下文用量与绑定候选双双断链。composerId 为全局 UUID，按 id 精确水合安全。
      const wantedIds = new Set<string>()
      for (const binding of bindings) {
        if (binding.composerId) wantedIds.add(binding.composerId)
      }
      for (const activity of Object.values(channelActivities ?? {})) {
        if (activity.composerId) wantedIds.add(activity.composerId)
      }
      // 唯一会话标记的全局扫描：标记写在哪，composer 就定位到哪
      const globalMarkerCandidates = this.globalLaunchMarkerCandidates(bindings)
      for (const candidate of globalMarkerCandidates) {
        wantedIds.add(candidate.composerId)
      }
      const hydrated: ParsedComposer[] = []
      if (wantedIds.size) {
        const knownIds = new Set(parsed.map((composer) => composer.telemetry.composerId))
        for (const header of rawComposers) {
          const id = recordOf(header)?.composerId
          if (typeof id !== 'string' || !wantedIds.has(id) || knownIds.has(id)) continue
          const composer = parseComposer(header, '')
          if (!composer) continue
          hydrated.push(composer)
          knownIds.add(id)
        }
      }
      const allComposers = [...parsed, ...hydrated]
      const transcriptSignals = new Map(allComposers.map((composer) => [
        composer.telemetry.composerId,
        this.readTranscriptSignals([workspacePath, normalizedWorkspace], composer)
      ]))
      const bindingByComposer = new Map(bindings.flatMap((binding) =>
        binding.composerId ? [[binding.composerId, binding] as const] : []
      ))
      // 通道转录定位到的 composer（跨工作区/数字目录）同样解析工作过程，
      // 与上下文用量的 displayComposer 回退语义保持一致
      const workChannelComposerIds = new Set(
        Object.values(channelActivities ?? {})
          .map((activity) => activity.composerId)
          .filter((id): id is string => Boolean(id))
      )
      const now = this.now()
      const composers = allComposers.map((composer): CursorComposerTelemetry => {
        const binding = bindingByComposer.get(composer.telemetry.composerId)
        const signals = transcriptSignals.get(composer.telemetry.composerId) ?? emptyTranscriptSignals()
        const lease = binding
          ? readRuntimeLease(
              this.paths,
              composer.workspaceStorageId,
              binding.channelId,
              now,
              this.isProcessAlive
            )
          : { observed: false, connected: false, waiting: false, fatal: false, detail: '会话尚未绑定通道' }
        return {
          ...composer.telemetry,
          activity: composerActivity(signals, binding?.channelId, lease, now, composer.telemetry.lastUpdatedAt),
          workEntries: binding || workChannelComposerIds.has(composer.telemetry.composerId)
            ? this.readTranscriptWorkEntries([workspacePath, normalizedWorkspace], composer)
            : undefined
        }
      })
      return {
        availability: 'available',
        workspacePath: normalizedWorkspace,
        composerProfile,
        cursorModels: modelState.models,
        composers,
        bindingCandidates: (() => {
          const local = bindingCandidates(
            allComposers,
            bindings,
            (composer) => transcriptSignals.get(composer.telemetry.composerId) ?? emptyTranscriptSignals()
          )
          const covered = new Set(local.map((candidate) => candidate.channelId))
          return [...local, ...globalMarkerCandidates.filter((candidate) => !covered.has(candidate.channelId))]
        })(),
        updatedAt: now
      }
    } catch (error) {
      return {
        ...emptyCursorTelemetrySnapshot(
          'error',
          error instanceof Error ? error.message.slice(0, 300) : 'Cursor 本机遥测读取失败'
        ),
        workspacePath: normalizedWorkspace
      }
    } finally {
      database?.close()
    }
  }

  private readTranscriptSignals(workspacePaths: string[], composer: ParsedComposer): TranscriptSignals {
    const path = transcriptPath(this.paths, workspacePaths, composer)
    if (!path) return emptyTranscriptSignals()
    try {
      const stat = statSync(path)
      const cached = this.transcriptSignalCache.get(composer.telemetry.composerId)
      if (
        cached &&
        cached.path === path &&
        cached.size === stat.size &&
        cached.modifiedAt === stat.mtimeMs
      ) return cached

      const signals = extractTranscriptSignals(transcriptMarkerWindow(path))
      signals.modifiedAt = stat.mtimeMs
      if (this.transcriptSignalCache.size >= MAX_TRANSCRIPT_SIGNAL_CACHE) {
        this.transcriptSignalCache.clear()
      }
      this.transcriptSignalCache.set(composer.telemetry.composerId, {
        ...signals,
        path,
        size: stat.size,
        modifiedAt: stat.mtimeMs
      })
      return signals
    } catch {
      return emptyTranscriptSignals()
    }
  }

  /**
   * 增量解析转录中的助手工作过程（可见叙述 / 工具调用），供会话视图回显。
   * 首轮直接从尾部窗口起读；过程回显关心最新条目，无需为历史过程全量解析大转录。
   */
  private readTranscriptWorkEntries(
    workspacePaths: string[],
    composer: ParsedComposer
  ): CursorWorkEntry[] | undefined {
    const path = transcriptPath(this.paths, workspacePaths, composer)
    if (!path) return undefined
    try {
      const stat = statSync(path)
      let cached = this.transcriptWorkCache.get(composer.telemetry.composerId)
      if (!cached || cached.path !== path || stat.size < cached.offset) {
        cached = {
          path,
          offset: Math.max(0, stat.size - MAX_WORK_READ_PER_POLL),
          remainder: Buffer.alloc(0),
          line: 0,
          entries: [],
          updatedAt: stat.mtimeMs
        }
      }
      let budget = MAX_WORK_READ_PER_POLL
      if (cached.offset < stat.size && budget > 0) {
        const descriptor = openSync(path, 'r')
        try {
          while (cached.offset < stat.size && budget > 0) {
            const length = Math.min(1024 * 1024, stat.size - cached.offset, budget)
            const chunk = Buffer.allocUnsafe(length)
            const bytesRead = readSync(descriptor, chunk, 0, length, cached.offset)
            if (bytesRead <= 0) break
            cached.offset += bytesRead
            budget -= bytesRead
            const combined = Buffer.concat([cached.remainder, chunk.subarray(0, bytesRead)])
            const lastNewline = combined.lastIndexOf(0x0a)
            if (lastNewline < 0) {
              cached.remainder = combined.length > 2 * 1024 * 1024 ? Buffer.alloc(0) : combined
              continue
            }
            const complete = combined.subarray(0, lastNewline).toString('utf8')
            cached.remainder = combined.subarray(lastNewline + 1)
            const observedAt = this.now()
            for (const line of complete.split('\n')) {
              cached.line += 1
              const parsedLine = parseTranscriptWorkLine(line, cached.line, observedAt)
              if (parsedLine.explicitTurn) {
                if (cached.activeTurn?.startsWith('implicit:')) {
                  const start = cached.activeTurnEntryStart ?? cached.entries.length
                  for (let index = start; index < cached.entries.length; index += 1) {
                    cached.entries[index]!.turn = parsedLine.explicitTurn
                  }
                }
                const turnChanged = cached.activeTurn !== parsedLine.explicitTurn
                cached.activeTurn = parsedLine.explicitTurn
                cached.activeTurnEntryStart = turnChanged
                  ? cached.entries.length
                  : cached.activeTurnEntryStart ?? cached.entries.length
              }
              if (!cached.activeTurn && parsedLine.entries.length) {
                cached.activeTurn = `implicit:${cached.line}`
                cached.activeTurnEntryStart = cached.entries.length
              }
              const parsed = parsedLine.entries.map((entry) => ({
                ...entry,
                turn: parsedLine.explicitTurn ?? cached.activeTurn
              }))
              if (parsed.length) {
                // 新条目出现说明此前的工具调用均已拿到结果（Cursor 顺序执行：
                // 结果返回后助手才会续写），翻转为完成态
                for (const entry of cached.entries) {
                  if (entry.status === 'running') entry.status = 'done'
                }
                cached.entries.push(...parsed)
              }
              if (parsedLine.closesTurn) {
                for (const entry of cached.entries) {
                  if (entry.status === 'running') entry.status = 'done'
                }
                cached.activeTurn = undefined
                cached.activeTurnEntryStart = undefined
              }
            }
          }
        } finally {
          closeSync(descriptor)
        }
        if (cached.entries.length > MAX_WORK_ENTRIES) {
          cached.entries = cached.entries.slice(-MAX_WORK_ENTRIES)
        }
      }
      cached.updatedAt = stat.mtimeMs
      if (this.transcriptWorkCache.size >= MAX_TRANSCRIPT_SIGNAL_CACHE) this.transcriptWorkCache.clear()
      this.transcriptWorkCache.set(composer.telemetry.composerId, cached)
      return cached.entries.length ? [...cached.entries] : undefined
    } catch {
      // 转录尚未生成/暂不可读时过程区留空，不影响其余遥测
      return undefined
    }
  }
}
