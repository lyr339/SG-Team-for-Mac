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
import type {
  AgentExecutionProfile,
  ContextUsage,
  ContextUsageBreakdown
} from '../../domain/agent-session'
import { badgesFromParameters, contextTokensFromValue, readableParameterValue } from '../../shared/model-badges'
import { sanitizeModelDisplayText } from '../../domain/model-output-sanitizer'
import type {
  CursorModelOption,
  CursorModelParameter,
  CursorModelParameterDefinition,
  CursorModelVariant
} from '../../domain/cursor-model'
import type { RuntimeBinding } from '../../domain/team-control'
import {
  BINDING_MARKER_PATTERN,
  canonicalBindingMarker,
  cursorComposerBindingMarker,
  emptyCursorTelemetrySnapshot,
  type CursorChannelActivity,
  type CursorComposerActivity,
  type ComposerBindingCandidate,
  type CursorComposerTelemetry,
  type CursorTelemetrySnapshot
} from '../../domain/cursor-telemetry'
import type { ProcessBlock } from '../../domain/conversation-entry'
import { isCursorInternalToolName } from './cursor-cdp-session-creator'

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
// 僵尸轮询硬上限：传输层声称 keepalive/waiting（每秒都在轮询 check_messages，
// 每次轮询都会写转录），但通道转录沉默超过该时长——两者矛盾，判定为
// 认证失效的僵尸会话（正面矛盾证据，不是「证据缺失」）
// 注：从 6 分钟缩短到 60 秒，更快检测假在线
const CHANNEL_POLL_SILENCE_MS = 60_000
const CHANNEL_SCAN_MAX_FILES = 48
/** 通道活性属于 presence 证据，不需要跟 250ms 流式正文同频；1s 足以判断监听状态。 */
const DEFAULT_CHANNEL_ACTIVITY_POLL_MS = 1_000
/**
 * 全局项目目录结构极少变化。此前每次 getSnapshot 都遍历最多 512 个项目目录，
 * 单轮即产生大量 readdir/stat；缓存 2s 只影响“新 Composer 首次发现”延迟，
 * 已绑定 Composer 的正文流仍通过精确文件路径按 250ms 增量读取。
 */
const DEFAULT_TRANSCRIPT_INDEX_TTL_MS = 2_000

type UnknownRecord = Record<string, unknown>

interface ParsedComposer {
  telemetry: CursorComposerTelemetry
  bindingText: string
  workspaceStorageId?: string
  persistedActivity?: CursorComposerActivity
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
  lastAssistantText?: string
  lastAssistantProcess?: ProcessBlock[]
}

interface CachedTranscriptSignals extends TranscriptSignals {
  path: string
  size: number
  modifiedAt: number
}


export interface CursorComposerTelemetryPaths {
  globalStateDatabase: string
  projectsRoot: string
  workspaceStorageRoot: string
}

export interface CursorComposerTelemetryReaderOptions extends Partial<CursorComposerTelemetryPaths> {
  now?: () => number
  isProcessAlive?: (pid: number) => boolean
  channelActivityPollMs?: number
  transcriptIndexTtlMs?: number
}

export interface CursorComposerTelemetrySource {
  readWorkspace(workspacePath: string, bindings: RuntimeBinding[]): CursorTelemetrySnapshot
}

function defaultPaths(): CursorComposerTelemetryPaths {
  // 平台分离：mac = ~/Library/Application Support/Cursor；win = %APPDATA%\Cursor
  //（与 cursor-update-preferences 的解析规则一致）
  const supportRoot = process.env.QINGTIAN_CURSOR_SUPPORT_ROOT?.trim()
    || (process.platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Cursor')
      : join(homedir(), 'Library', 'Application Support', 'Cursor'))
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

function selectedOptionLabels(entry: UnknownRecord, selected: Map<string, string>): string[] {
  const kinds = new Map<string, 'boolean' | 'enum'>()
  for (const definition of recordArray(entry.parameterDefinitions)) {
    const id = boundedString(definition.id, 80)
    if (!id) continue
    const parameterType = recordOf(definition.parameterType)
    if (recordOf(parameterType?.booleanParameter)) kinds.set(id, 'boolean')
    else if (recordOf(parameterType?.enumParameter)) kinds.set(id, 'enum')
  }
  return badgesFromParameters(
    [...selected].map(([id, value]) => ({ id, value })),
    kinds
  )
}

function selectedContextTokenLimit(
  entry: UnknownRecord,
  selected: Map<string, string>,
  maxMode?: boolean
): number | undefined {
  const selectedContext = selected.get('context')
  const tokens = selectedContext ? contextTokensFromValue(selectedContext) : undefined
  if (tokens !== undefined) return tokens
  const regular = nonNegativeInteger(entry.contextTokenLimit)
  if (maxMode === true) return nonNegativeInteger(entry.contextTokenLimitForMaxMode) ?? regular
  if (maxMode === false && entry.supportsMaxMode === true && regular !== undefined) {
    return Math.min(regular, 200_000)
  }
  return regular
}

function profileFromModelConfig(
  root: UnknownRecord | undefined,
  composerConfig: UnknownRecord | undefined
): AgentExecutionProfile | undefined {
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
  const maxMode = composerConfig.maxMode === true || variant?.isMaxMode === true
  return {
    scope: 'cursor-composer-current',
    modelId,
    displayName,
    options: selectedOptionLabels(entry, parameters),
    maxMode,
    contextTokenLimit: selectedContextTokenLimit(entry, parameters, maxMode)
  }
}

/** 全局当前 Composer 配置（aiSettings.modelConfig.composer）。 */
function parseComposerProfile(value: unknown): AgentExecutionProfile | undefined {
  const root = recordOf(value)
  const aiSettings = recordOf(root?.aiSettings)
  const modelConfig = recordOf(aiSettings?.modelConfig)
  return profileFromModelConfig(root, recordOf(modelConfig?.composer))
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
      // Cursor 目录提供展示名时以它为唯一规格源；布尔项常省略展示名，
      // 仅这种情况使用稳定的英文 On/Off。未知枚举值只做可读化兜底。
      const displayName = boundedString(rawValue.displayName, 80)
        || (kind === 'boolean'
          ? (parameterValue === 'true' ? 'On' : 'Off')
          : readableParameterValue(parameterValue))
      return [{
        value: parameterValue,
        displayName,
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

function cursorModelVariants(
  entry: UnknownRecord,
  definitions: CursorModelParameterDefinition[]
): CursorModelVariant[] {
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]))
  return recordArray(entry.variants).slice(0, 512).flatMap((variant) => {
    const parameters = parametersOf(variant.parameterValues)
    if (parameters.length !== definitions.length) return []
    const unique = new Set(parameters.map((parameter) => parameter.id))
    if (unique.size !== definitions.length) return []
    const valid = parameters.every((parameter) => {
      const definition = definitionById.get(parameter.id)
      return definition?.values.some((value) => value.value === parameter.value) === true
    })
    return valid ? [{
      parameters,
      maxMode: variant.isMaxMode === true,
      isDefaultMaxConfig: variant.isDefaultMaxConfig === true || undefined,
      isDefaultNonMaxConfig: variant.isDefaultNonMaxConfig === true || undefined
    }] : []
  })
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
    const variants = cursorModelVariants(entry, parameterDefinitions)
    const defaultParameters = defaultModelParameters(entry)
    const parameters = completeModelParameters(
      parameterDefinitions,
      selected ? selectedParameters : defaultParameters,
      defaultParameters
    )
    const parameterMap = new Map(parameters.map((parameter) => [parameter.id, parameter.value]))
    const variant = matchingVariant(entry, parameterMap)
    options.set(modelId, {
      modelId,
      displayName,
      parameters,
      maxMode: selected ? composerConfig?.maxMode === true || variant?.isMaxMode === true : variant?.isMaxMode === true,
      supportsMaxMode: entry.supportsMaxMode === true,
      supportsNonMaxMode: entry.supportsNonMaxMode !== false,
      selected,
      optionLabels: selected ? selectedOptionLabels(entry, parameterMap) : [],
      parameterDefinitions,
      variants,
      contextTokenLimit: selectedContextTokenLimit(entry, parameterMap),
      contextTokenLimitForMaxMode: nonNegativeInteger(entry.contextTokenLimitForMaxMode)
    })
  }
  if (selectedModelId && ![...options.values()].some((option) => option.selected)) {
    options.set(selectedModelId, {
      modelId: selectedModelId,
      displayName: selectedModelId,
      parameters: selectedParameters,
      maxMode: composerConfig?.maxMode === true,
      supportsMaxMode: false,
      supportsNonMaxMode: true,
      selected: true,
      optionLabels: [],
      parameterDefinitions: [],
      variants: [],
      contextTokenLimit: undefined,
      contextTokenLimitForMaxMode: undefined
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
  root?: UnknownRecord
} {
  try {
    const row = database.prepare(
      'SELECT value FROM ItemTable WHERE key = ?'
    ).get(APPLICATION_USER_KEY) as { value?: unknown } | undefined
    const json = sqliteText(row?.value)
    if (!json || Buffer.byteLength(json, 'utf8') > MAX_APPLICATION_USER_BYTES) return { models: [] }
    const value = JSON.parse(json)
    const root = recordOf(value)
    return { profile: parseComposerProfile(value), models: parseCursorModels(value), root }
  } catch {
    // Composer headers remain useful even if Cursor changes or is midway
    // through writing this unrelated global preference record.
    return { models: [] }
  }
}

/**
 * 逐会话模型配置：Cursor 在每个 Composer 的 cursorDiskKV `composerData:<id>`
 * 里写入独立 modelConfig（拾光逐会话选模经 setModelConfigForComposer 写入的
 * 正是该载体）。json_extract 只抽该字段，避免解析整条会话 blob；
 * 与全局配置同一套解析，产出逐会话 profile。表缺失/结构变化时静默回退全局配置。
 */
function readComposerPersistentDetails(
  database: DatabaseSync,
  root: UnknownRecord | undefined,
  composerIds: string[]
): {
  profiles: Map<string, AgentExecutionProfile>
  contextUsage: Map<string, ContextUsage>
} {
  const profiles = new Map<string, AgentExecutionProfile>()
  const contextUsage = new Map<string, ContextUsage>()
  if (!composerIds.length) return { profiles, contextUsage }
  try {
    const statement = database.prepare(
      `SELECT
        json_extract(value, '$.modelConfig') AS model_config,
        json_extract(value, '$.contextUsagePercent') AS context_percent,
        json_extract(value, '$.contextTokensUsed') AS context_used,
        json_extract(value, '$.contextTokenLimit') AS context_limit,
        json_extract(value, '$.promptTokenBreakdown') AS token_breakdown
      FROM cursorDiskKV WHERE key = ?`
    )
    for (const composerId of composerIds) {
      const row = statement.get(`composerData:${composerId}`) as {
        model_config?: unknown
        context_percent?: unknown
        context_used?: unknown
        context_limit?: unknown
        token_breakdown?: unknown
      } | undefined
      const modelJson = sqliteText(row?.model_config)
      if (root && modelJson) {
        const profile = profileFromModelConfig(root, recordOf(JSON.parse(modelJson)))
        if (profile) profiles.set(composerId, profile)
      }
      const breakdownJson = sqliteText(row?.token_breakdown)
      const breakdown = breakdownJson ? nativeContextBreakdown(JSON.parse(breakdownJson)) : undefined
      const used = nonNegativeInteger(row?.context_used) ?? breakdown?.totalUsedTokens
      const limit = nonNegativeInteger(row?.context_limit) ?? breakdown?.maxTokens
      const percent = finiteNumber(row?.context_percent)
      const ratio = percent === undefined
        ? used !== undefined && limit ? used / limit : undefined
        : Math.min(100, Math.max(0, percent)) / 100
      if (ratio !== undefined) contextUsage.set(composerId, { used, limit, ratio, breakdown })
    }
  } catch {
    // 逐会话详情是增强信息；读取失败时会话卡回退头部指标/全局配置。
  }
  return { profiles, contextUsage }
}

/**
 * 通道活性指纹：快照内容经 channelActivities 依赖（水合候选、工作过程通道集）。
 * state 由转录年龄分档（含 now 派生），翻档时必须重算——纳入键自然触发；
 * detail 为静态文案不进键。
 */
function channelActivitiesFingerprint(activities?: Record<string, CursorChannelActivity>): string {
  if (!activities) return ''
  return Object.values(activities)
    .map((activity) => `${activity.channelId}:${activity.composerId ?? ''}:${activity.state}:${activity.observedAt ?? ''}`)
    .sort()
    .join('|')
}

/**
 * 绑定列表指纹：遥测快照内容依赖 bindings（通道/会话绑定/生成代数），
 * 任一关键字段变化都必须让整轮缓存失效；lastCheckInAt 不参与——签到刷心跳
 * 不改变遥测内容，避免无意义的全量重读。
 */
function bindingsFingerprint(bindings: RuntimeBinding[]): string {
  return bindings
    .map((binding) => [
      binding.channelId,
      binding.slotId,
      binding.composerId ?? '',
      binding.generation,
      binding.installedAt,
      binding.launchStatus
    ].join(':'))
    .sort()
    .join('|')
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

function nativeContextBreakdown(value: unknown): ContextUsageBreakdown | undefined {
  const breakdown = recordOf(value)
  if (!breakdown) return undefined
  const totalUsedTokens = nonNegativeInteger(breakdown.totalUsedTokens)
  const maxTokens = nonNegativeInteger(breakdown.maxTokens)
  if (totalUsedTokens === undefined || maxTokens === undefined || maxTokens === 0) return undefined
  const categories = recordArray(breakdown.categories).slice(0, 24).flatMap((category) => {
    const id = boundedString(category.id, 80)
    const label = boundedString(category.label, 120)
    const estimatedTokens = nonNegativeInteger(category.estimatedTokens)
    return id && label && estimatedTokens !== undefined ? [{ id, label, estimatedTokens }] : []
  })
  return { totalUsedTokens, maxTokens, categories }
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
  const persistedStatus = boundedString(value.status, 80)?.toLowerCase() || ''
  const generating = value.isGenerating === true
    || (Array.isArray(value.generatingBubbleIds) && value.generatingBubbleIds.length > 0)
  const abortReason = boundedString(value.abortReason, 200)
  const terminal = ['aborted', 'cancelled', 'canceled', 'error', 'failed', 'stopped'].includes(persistedStatus)
  const persistedActivity: CursorComposerActivity | undefined = terminal
    ? {
        state: 'stopped',
        detail: abortReason
          ? `Cursor 持久状态确认 Agent 已停止（${persistedStatus || abortReason}）`
          : `Cursor 持久状态确认 Agent 已停止（${persistedStatus}）`,
        observedAt: lastUpdatedAt
      }
    : generating
      ? {
          state: 'active',
          detail: 'Cursor 持久状态确认 Agent 正在生成',
          observedAt: lastUpdatedAt
        }
      : undefined

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
    workspaceStorageId: workspaceStorageIdOf(value),
    persistedActivity
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

/** 统一服务器（SG Team）按工具参数 channel_id 区分通道——从调用参数提取通道号。 */
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

function lastTranscriptAssistantText(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  let lastUserLine = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    try {
      if (recordOf(JSON.parse(line))?.role === 'user') {
        lastUserLine = index
        break
      }
    } catch { /* 跳过坏行 */ }
  }
  for (let index = lines.length - 1; index > lastUserLine; index -= 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    let entry: UnknownRecord | undefined
    try { entry = recordOf(JSON.parse(line)) } catch { continue }
    if (entry?.role !== 'assistant') continue
    const message = recordOf(entry.message)
    const content = Array.isArray(message?.content) ? message.content : []
    const pieces = content.flatMap((raw) => {
      const item = recordOf(raw)
      const value = item?.type === 'text' && typeof item.text === 'string'
        ? sanitizeModelDisplayText(item.text.slice(0, 100_000)).text
        : undefined
      return value ? [value] : []
    })
    if (pieces.length) return pieces.join('\n\n').slice(0, 100_000)
  }
  return undefined
}

/**
 * Cursor transcript 是 completed 回合在应用重启后的耐久事实源。提取最后一条用户
 * 消息之后、最终纯文本回复之前的 Assistant 文本与工具调用，恢复图形化过程；实时
 * 生成期仍由 CDP 原生流优先，转录只负责冷启动兜底。
 */
function lastTranscriptAssistantProcess(text: string): ProcessBlock[] | undefined {
  const entries = text.split(/\r?\n/).flatMap((line, lineIndex) => {
    try {
      const value = recordOf(JSON.parse(line))
      return value ? [{ value, lineIndex }] : []
    } catch {
      return []
    }
  })
  let lastUserIndex = -1
  let lastAssistantIndex = -1
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]?.value.role === 'user') lastUserIndex = index
    if (entries[index]?.value.role === 'assistant') lastAssistantIndex = index
  }
  if (lastAssistantIndex <= lastUserIndex) return undefined
  const blocks: ProcessBlock[] = []
  for (let index = lastUserIndex + 1; index <= lastAssistantIndex && blocks.length < 80; index += 1) {
    const entry = entries[index]
    if (!entry || entry.value.role !== 'assistant') continue
    const message = recordOf(entry.value.message)
    const content = Array.isArray(message?.content) ? message.content : []
    const hasTool = content.some((raw) => recordOf(raw)?.type === 'tool_use')
    for (let itemIndex = 0; itemIndex < content.length && blocks.length < 80; itemIndex += 1) {
      const item = recordOf(content[itemIndex])
      if (!item) continue
      const id = `transcript:${entry.lineIndex}:${itemIndex}`
      if (item.type === 'text' && typeof item.text === 'string') {
        // 最后一条无工具 Assistant 文本是最终回复，由 lastAssistantResponse 展示；
        // 带工具的文本及此前 Assistant 文本才属于 Cursor 过程。
        if (index === lastAssistantIndex && !hasTool) continue
        const value = sanitizeModelDisplayText(item.text.slice(0, 100_000)).text
        if (value) blocks.push({ kind: 'thinking', id, text: value, status: 'done', timingEstimated: true })
        continue
      }
      if (item.type !== 'tool_use') continue
      const input = recordOf(item.input)
      const dynamicToolName = boundedString(input?.toolName, 160)
      const nativeName = boundedString(item.name, 160) ?? 'tool'
      // 内部协议工具（check_messages/record_reply 等，含服务器前缀形态与旧版
      // MCP 占位名）不进过程——与 observer 主路径同一名单。判定用动态工具名
      // （GetDynamicTools(check_messages) 这类传输工具发现调用同样属内部协议）。
      if (isCursorInternalToolName(dynamicToolName ?? nativeName)) continue
      const toolName = nativeName === 'GetDynamicTools'
        ? 'get_mcp_tools'
        : dynamicToolName ?? nativeName
      const args = recordOf(input?.arguments)
      const namespace = boundedString(input?.namespace ?? input?.server, 240)
      blocks.push({
        kind: 'tool',
        id,
        toolName,
        toolKind: 'mcp',
        summary: namespace,
        input: args ?? input,
        status: 'done',
        timingEstimated: true
      })
    }
  }
  return blocks.length ? blocks : undefined
}

function extractTranscriptSignals(text: string): TranscriptSignals {
  const signals = emptyTranscriptSignals()
  for (const match of text.matchAll(BINDING_MARKER_PATTERN)) {
    // 旧品牌标记规范化为现行格式，老转录仍能命中绑定匹配。
    signals.bindingMarkers.add(canonicalBindingMarker(match[0]))
  }
  for (const match of text.matchAll(/(?:qtwx-mcp|qingtian-team-ch)-(\d{1,12})/g)) {
    signals.channelIds.add(match[1]!)
  }
  // 统一服务器（SG Team）形态：服务器名不含通道号，通道身份在工具参数 channel_id 里
  for (const match of text.matchAll(/"channel_id"\s*:\s*"(\d{1,12})"/g)) {
    signals.channelIds.add(match[1]!)
  }
  signals.lastAction = lastTranscriptAction(text)
  signals.lastAssistantText = lastTranscriptAssistantText(text)
  signals.lastAssistantProcess = lastTranscriptAssistantProcess(text)
  return signals
}

function mergeTranscriptSignals(...values: TranscriptSignals[]): TranscriptSignals {
  const merged = emptyTranscriptSignals()
  for (const value of values) {
    for (const marker of value.bindingMarkers) merged.bindingMarkers.add(marker)
    for (const channelId of value.channelIds) merged.channelIds.add(channelId)
    if (value.lastAction) merged.lastAction = value.lastAction
    if (value.modifiedAt !== undefined) merged.modifiedAt = value.modifiedAt
    if (value.lastAssistantText) merged.lastAssistantText = value.lastAssistantText
    if (value.lastAssistantProcess?.length) merged.lastAssistantProcess = value.lastAssistantProcess
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
      // 等待租约结束最常见的原因就是“刚收到消息开始干活”。如果后续长命令
      // 暂时没有转录增量，no-waiting 仍不是死亡证据；正面死亡由上方 fatal
      // 租约、Cursor terminal 状态或 composer 消失承担。
      return transcriptAge !== undefined && transcriptAge <= WORK_ACTIVITY_GRACE_MS
        ? {
            state: 'unknown',
            workInProgress: true,
            detail: '长轮询已结束，Agent 可能正在执行长任务（等待正面活动或终止证据）',
            observedAt,
            channelId: expectedChannelId ?? action.channelId
          }
        : {
            state: 'unknown',
            detail: '长轮询已结束，当前缺少 Agent 活动或终止证据',
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
  private readonly channelSignalCache = new Map<string, TranscriptSignals & { path: string }>()
  private readonly channelActivityPollMs: number
  private readonly transcriptIndexTtlMs: number
  private channelActivityRun?: {
    bindingsKey: string
    at: number
    result: Record<string, CursorChannelActivity> | undefined
  }
  private transcriptFileIndex?: {
    at: number
    files: { path: string; modifiedAt: number; composerId: string }[]
  }
  /**
   * 快照级缓存：state.vscdb+wal 指纹（mtime/size/ino）、bindings、通道活性与上轮触及的
   * 转录文件（mtime/size）任一变化即失效。主进程遥测轮询（750ms-1s）此前每轮对 20GB 库
   * 新开同步 DatabaseSync 并全量解析，空闲期占住主进程；vscdb 由 Cursor 在会话活跃时
   * 高频写回，活跃期缓存自然失效。转录依赖必须纳入判定：转录追加不经过 vscdb，
   * 漏掉会冻结工作过程/上下文信号（有既有测试钉死该语义）。
   */
  private lastSnapshotRun?: {
    fingerprint: string
    workspaceKey: string
    bindingsKey: string
    activitiesKey: string
    transcriptDeps: Array<{ path: string; mtimeMs: number; size: number }>
    result: CursorTelemetrySnapshot
  }
  /** 本轮计算触及的转录文件收集器（仅正常计算路径非空）。 */
  private transcriptDepsCollector?: Array<{ path: string; mtimeMs: number; size: number }>
  /** 复用的只读连接：WAL 模式下读事务可见其他进程新提交；inode 变更才重开。 */
  private sharedDatabase?: { handle: DatabaseSync; path: string; ino: number }

  constructor(options: CursorComposerTelemetryReaderOptions = {}) {
    const {
      now,
      isProcessAlive,
      channelActivityPollMs,
      transcriptIndexTtlMs,
      ...paths
    } = options
    this.paths = { ...defaultPaths(), ...paths }
    this.now = now ?? Date.now
    this.isProcessAlive = isProcessAlive ?? processIsAlive
    this.channelActivityPollMs = Math.max(0, channelActivityPollMs ?? DEFAULT_CHANNEL_ACTIVITY_POLL_MS)
    this.transcriptIndexTtlMs = Math.max(0, transcriptIndexTtlMs ?? DEFAULT_TRANSCRIPT_INDEX_TTL_MS)
  }

  /** 进程退出/测试收尾时关闭复用连接（未打开过则空操作）。 */
  dispose(): void {
    this.channelActivityRun = undefined
    this.transcriptFileIndex = undefined
    if (!this.sharedDatabase) return
    try {
      this.sharedDatabase.handle.close()
    } catch {
      // 关闭失败不影响进程退出语义
    }
    this.sharedDatabase = undefined
  }

  readWorkspace(workspacePath: string, bindings: RuntimeBinding[]): CursorTelemetrySnapshot {
    const at = this.now()
    const key = bindingsFingerprint(bindings)
    const cached = this.channelActivityRun
    const channelActivities = cached
      && cached.bindingsKey === key
      && at - cached.at < this.channelActivityPollMs
      ? cached.result
      : this.readChannelActivities(bindings, at)
    if (!cached || cached.bindingsKey !== key || at - cached.at >= this.channelActivityPollMs) {
      this.channelActivityRun = { bindingsKey: key, at, result: channelActivities }
    }
    const snapshot = this.readWorkspaceSnapshot(workspacePath, bindings, channelActivities)
    return channelActivities ? { ...snapshot, channelActivities } : snapshot
  }

  private transcriptFiles(now: number): { path: string; modifiedAt: number; composerId: string }[] {
    const cached = this.transcriptFileIndex
    if (cached && now - cached.at < this.transcriptIndexTtlMs) return cached.files
    const files = listTranscriptFiles(this.paths.projectsRoot)
    this.transcriptFileIndex = { at: now, files }
    return files
  }

  /** vscdb+wal 的 mtime/size/ino 指纹；库不存在返回 undefined（不缓存，走原错误路径）。 */
  private databaseFingerprint(): string | undefined {
    try {
      const database = statSync(this.paths.globalStateDatabase)
      let wal = 'none'
      try {
        const walStat = statSync(`${this.paths.globalStateDatabase}-wal`)
        wal = `${walStat.mtimeMs}:${walStat.size}:${walStat.ino}`
      } catch {
        // WAL 不存在（检查点合并后）是正常状态
      }
      return `${database.mtimeMs}:${database.size}:${database.ino}:${wal}`
    } catch {
      return undefined
    }
  }

  private acquireDatabase(): DatabaseSync {
    const path = this.paths.globalStateDatabase
    const ino = statSync(path).ino
    const existing = this.sharedDatabase
    if (existing && existing.path === path && existing.ino === ino) {
      return existing.handle
    }
    if (existing) {
      try {
        existing.handle.close()
      } catch {
        // 旧文件句柄关闭失败不阻断新连接
      }
    }
    const handle = new DatabaseSync(path, {
      readOnly: true,
      timeout: 300,
      defensive: true
    })
    handle.exec('PRAGMA query_only = ON')
    handle.exec('PRAGMA busy_timeout = 300')
    this.sharedDatabase = { handle, path, ino }
    return handle
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
    const files = this.transcriptFiles(now)
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
    for (const file of this.transcriptFiles(this.now())) {
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
    const fingerprint = this.databaseFingerprint()
    const bindingsKey = bindingsFingerprint(bindings)
    const activitiesKey = channelActivitiesFingerprint(channelActivities)
    const cached = this.lastSnapshotRun
    if (
      cached
      && fingerprint !== undefined
      && cached.fingerprint === fingerprint
      && cached.workspaceKey === normalizedWorkspace
      && cached.bindingsKey === bindingsKey
      && cached.activitiesKey === activitiesKey
      && this.transcriptDepsFresh(cached.transcriptDeps)
    ) {
      return cached.result
    }
    if (!existsSync(this.paths.globalStateDatabase)) {
      return {
        ...emptyCursorTelemetrySnapshot('unavailable', '找不到 Cursor 本机会话数据库'),
        workspacePath: normalizedWorkspace
      }
    }

    try {
      this.transcriptDepsCollector = []
      // 复用只读连接（WAL 读事务可见新提交），替代每轮对 20GB 库新开/关闭。
      const database = this.acquireDatabase()
      const modelState = readComposerModelState(database)
      const row = database.prepare(
        'SELECT value FROM ItemTable WHERE key = ?'
      ).get(COMPOSER_HEADERS_KEY) as { value?: unknown } | undefined
      const json = sqliteText(row?.value)
      if (!json) {
        return this.cacheSnapshotRun(fingerprint, normalizedWorkspace, bindingsKey, activitiesKey, {
          ...emptyCursorTelemetrySnapshot('unavailable', 'Cursor 尚未生成会话遥测'),
          workspacePath: normalizedWorkspace,
          composerProfile: modelState.profile,
          cursorModels: modelState.models
        })
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
      const persistentDetails = readComposerPersistentDetails(
        database,
        modelState.root,
        allComposers.map((composer) => composer.telemetry.composerId)
      )
      const transcriptSignals = new Map(allComposers.map((composer) => [
        composer.telemetry.composerId,
        this.readTranscriptSignals([workspacePath, normalizedWorkspace], composer)
      ]))
      const bindingByComposer = new Map(bindings.flatMap((binding) =>
        binding.composerId ? [[binding.composerId, binding] as const] : []
      ))
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
          modelProfile: persistentDetails.profiles.get(composer.telemetry.composerId),
          contextUsage: (() => {
            const headerUsage = composer.telemetry.contextUsage
            const detailUsage = persistentDetails.contextUsage.get(composer.telemetry.composerId)
            if (!headerUsage) return detailUsage
            if (!detailUsage) return headerUsage
            return {
              used: headerUsage.used ?? detailUsage.used,
              limit: headerUsage.limit ?? detailUsage.limit,
              ratio: headerUsage.ratio,
              breakdown: detailUsage.breakdown
            }
          })(),
          lastAssistantResponse: signals.lastAssistantText && signals.modifiedAt !== undefined
            ? {
                id: `transcript:${composer.telemetry.composerId}:${Math.round(signals.modifiedAt)}`,
                text: signals.lastAssistantText,
                observedAt: signals.modifiedAt
              }
            : undefined,
          lastAssistantProcess: signals.lastAssistantProcess?.length && signals.modifiedAt !== undefined
            ? { blocks: signals.lastAssistantProcess, observedAt: signals.modifiedAt }
            : undefined,
          activity: composer.persistedActivity
            ? { ...composer.persistedActivity, channelId: binding?.channelId }
            : composerActivity(signals, binding?.channelId, lease, now, composer.telemetry.lastUpdatedAt)
        }
      })
      return this.cacheSnapshotRun(fingerprint, normalizedWorkspace, bindingsKey, activitiesKey, {
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
      })
    } catch (error) {
      return {
        ...emptyCursorTelemetrySnapshot(
          'error',
          error instanceof Error ? error.message.slice(0, 300) : 'Cursor 本机遥测读取失败'
        ),
        workspacePath: normalizedWorkspace
      }
    } finally {
      this.transcriptDepsCollector = undefined
    }
  }

  /** 写入快照缓存：fingerprint 缺失（库不存在）或错误路径不缓存，下轮重试。 */
  private cacheSnapshotRun(
    fingerprint: string | undefined,
    workspaceKey: string,
    bindingsKey: string,
    activitiesKey: string,
    result: CursorTelemetrySnapshot
  ): CursorTelemetrySnapshot {
    if (fingerprint !== undefined) {
      this.lastSnapshotRun = {
        fingerprint,
        workspaceKey,
        bindingsKey,
        activitiesKey,
        transcriptDeps: this.transcriptDepsCollector ?? [],
        result
      }
    }
    return result
  }

  /** 上轮触及的转录文件全部未变（mtime+size）才允许复用缓存。 */
  private transcriptDepsFresh(deps: Array<{ path: string; mtimeMs: number; size: number }>): boolean {
    for (const dep of deps) {
      try {
        const stat = statSync(dep.path)
        if (stat.mtimeMs !== dep.mtimeMs || stat.size !== dep.size) return false
      } catch {
        return false
      }
    }
    return true
  }

  /** 记录本轮计算实际读取的转录文件（供下轮缓存判定；与调用处已有的 statSync 共享结果）。 */
  private noteTranscriptDep(path: string, stat: { mtimeMs: number; size: number }): void {
    this.transcriptDepsCollector?.push({ path, mtimeMs: stat.mtimeMs, size: stat.size })
  }

  private readTranscriptSignals(workspacePaths: string[], composer: ParsedComposer): TranscriptSignals {
    const path = transcriptPath(this.paths, workspacePaths, composer)
    if (!path) return emptyTranscriptSignals()
    try {
      const stat = statSync(path)
      this.noteTranscriptDep(path, stat)
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


}
