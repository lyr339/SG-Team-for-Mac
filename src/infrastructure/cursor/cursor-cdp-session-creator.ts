import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import WebSocket from 'ws'
import { stripRedactionMarkers } from '../../domain/model-output-sanitizer'
import type { CursorModelSelection } from '../../domain/cursor-model'

/**
 * 通过 Chrome DevTools Protocol 直连 Cursor 渲染进程创建 Agent 会话。
 *
 * 与晴天插件原生批量创建（silent_launch）同源；未指定模型走 bridge.createAgent，
 * 逐会话选模时直达 Cursor 自身 createComposer({ partialState.modelConfig })：
 *   window.__qtComposerService.createComposer({ partialState: { unifiedMode:'agent', modelConfig } })
 *   → window.__qtComposerBridge.submitByComposerId(composerId, text, { ignoreQueuing: true })
 * 纯 API 调用，无 DOM、无焦点、无辅助功能权限依赖；回执即真实 composerId。
 *
 * 唯一前提：Cursor 以 --remote-debugging-port 启动（见 cursor-cdp-restart.ts）。
 */

export const CURSOR_CDP_DEFAULT_PORT = 9333
export const CURSOR_CDP_PORT_ENV = 'QINGTIAN_CURSOR_CDP_PORT'
/** 编排器据此为计划项标记 code: 'cdp_unavailable'，UI 展示一键重启 Cursor 引导。 */
export const CURSOR_CDP_UNAVAILABLE_HINT = '未检测到 Cursor 调试端口'

const DEFAULT_OPERATION_TIMEOUT_MS = 60_000
const PROBE_TIMEOUT_MS = 2_500
const EVALUATE_TIMEOUT_MS = 45_000
const MAX_TARGETS = 32
const MAX_ERROR_CHARS = 200

export interface CursorCdpTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl: string
}

export interface CursorCdpWindowInfo {
  title: string
  bridgeReady: boolean
  workspaceScope: string
}

export interface CursorCdpProbeResult {
  available: boolean
  port: number
  windows: CursorCdpWindowInfo[]
  issue?: string
}

export interface CursorCdpCreateInput {
  channelId: string
  name: string
  prompt: string
  workspacePath?: string
  modelSelection?: CursorModelSelection
}

export interface CursorCdpCreateResult {
  ok: boolean
  message: string
  composerId?: string
  modelId?: string
}

export interface CursorStreamToolBlock {
  kind: 'tool'
  id: string
  toolName: string
  toolKind: 'command' | 'read' | 'search' | 'edit' | 'write' | 'browser' | 'mcp' | 'todo' | 'other'
  summary: string
  status: 'running' | 'done' | 'failed'
  input?: Record<string, unknown>
  output?: string
  error?: string
}

export interface CursorStreamThinkingBlock {
  kind: 'thinking'
  id: string
  text: string
  status: 'running' | 'done'
  durationMs?: number
}

export interface CursorStreamMessageBlock {
  kind: 'message'
  id: string
  text: string
  status: 'running' | 'done'
}

/**
 * CDP 侧提取的当前回合过程流（composer 数据模型实时增量）：
 * 正文之外的思考、工具调用生命周期与 todos——直接映射 Cursor 原生内存模型，
 * 覆盖未自觉走流式上报协议的 Agent。
 */
export interface CursorProcessStream {
  /** Cursor fullConversationHeadersOnly 的原始顺序；思考与工具不可分组重排。 */
  items: Array<CursorStreamThinkingBlock | CursorStreamToolBlock | CursorStreamMessageBlock>
  todos?: Array<{ content: string; status: string }>
  generatingBubbleCount: number
}

export interface CursorComposerRuntimeEvidence {
  composerId: string
  state: 'active' | 'stopped' | 'unknown'
  detail: string
  observedAt: number
  isGenerating?: boolean
  responseId?: string
  responseText?: string
  /** 当前回合全过程流（仅生成中的 composer 携带；stopped/空回合为 undefined）。 */
  process?: CursorProcessStream
}

export interface CursorCdpSessionCreatorOptions {
  port?: number
  fetchTargets?: (port: number, timeoutMs: number) => Promise<CursorCdpTarget[]>
  evaluate?: (webSocketDebuggerUrl: string, expression: string, timeoutMs: number) => Promise<unknown>
  operationTimeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? '')
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_CHARS) || '未知错误'
}

function isWorkbenchTarget(value: unknown): value is CursorCdpTarget {
  if (!isRecord(value)) return false
  return value.type === 'page'
    && typeof value.id === 'string'
    && typeof value.webSocketDebuggerUrl === 'string'
    && value.webSocketDebuggerUrl.startsWith('ws')
    && typeof value.url === 'string'
    && /workbench/i.test(value.url)
}

async function defaultFetchTargets(port: number, timeoutMs: number): Promise<CursorCdpTarget[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const json: unknown = await response.json()
    if (!Array.isArray(json)) return []
    return json.filter(isWorkbenchTarget).slice(0, MAX_TARGETS)
  } finally {
    clearTimeout(timer)
  }
}

async function defaultEvaluate(webSocketDebuggerUrl: string, expression: string, timeoutMs: number): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl, { handshakeTimeout: 5_000, maxPayload: 16 * 1024 * 1024 })
    let settled = false
    const timer = setTimeout(() => {
      finish(new Error('CDP 求值超时'))
    }, timeoutMs)
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* 忽略关闭异常 */ }
      if (error) reject(error)
      else resolve(value)
    }
    socket.on('error', (error) => finish(new Error(`CDP 连接失败：${boundedError(error)}`)))
    socket.on('open', () => {
      try {
        socket.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        }))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('message', (data) => {
      let message: unknown
      try {
        message = JSON.parse(String(data))
      } catch {
        return
      }
      if (!isRecord(message) || message.id !== 1) return
      if (isRecord(message.error)) {
        finish(new Error(`CDP 调用被拒：${boundedError(message.error.message)}`))
        return
      }
      const result = isRecord(message.result) ? message.result : undefined
      const exception = isRecord(result?.exceptionDetails) ? result.exceptionDetails : undefined
      if (exception) {
        const detail = isRecord(exception.exception) ? exception.exception.description : exception.text
        finish(new Error(`页面脚本异常：${boundedError(detail)}`))
        return
      }
      const remote = isRecord(result?.result) ? result.result : undefined
      finish(undefined, remote?.value)
    })
  })
}

/** 与晴天插件 workspaceScopeId 完全一致的计算：sha256(workspacePath).hex 前 16 位。 */
export function cursorWorkspaceScopeId(workspacePath: string): string {
  return createHash('sha256').update(workspacePath).digest('hex').slice(0, 16)
}

function workspaceScopeCandidates(workspacePath: string): string[] {
  const normalized = workspacePath.trim().replace(/[/\\]+$/, '')
  if (!normalized) return []
  const variants = new Set<string>([normalized])
  try {
    variants.add(realpathSync(normalized))
  } catch {
    // 工作区可能暂时不可用；保留原始路径变体即可
  }
  // Windows 路径大小写不敏感：Cursor 侧 file URL 的盘符/目录大小写可能与
  // realpathSync 规范形式不同（遥测侧 canonicalPath 已同样 lowercase），
  // 追加小写变体保证 scope 命中；macOS 大小写敏感，不加。
  if (process.platform === 'win32') {
    for (const variant of [...variants]) variants.add(variant.toLowerCase())
  }
  return [...variants].map((variant) => cursorWorkspaceScopeId(variant))
}

const WINDOW_PROBE_EXPRESSION = `({
  bridge: !!(window.__qtComposerBridge && window.__qtComposerBridge.ready),
  scope: String(window.__qtBatchWorkspaceScopeId || ''),
  title: String(document.title || '')
})`

function buildCreateExpression(input: {
  name: string
  prompt: string
  modelSelection?: CursorModelSelection
}): string {
  const name = JSON.stringify(input.name)
  const text = JSON.stringify(input.prompt)
  const modelConfig = input.modelSelection ? JSON.stringify({
    modelName: input.modelSelection.modelId,
    maxMode: input.modelSelection.maxMode === true,
    selectedModels: [{
      modelId: input.modelSelection.modelId,
      parameters: input.modelSelection.parameters.map((parameter) => ({
        id: parameter.id,
        value: parameter.value
      }))
    }]
  }) : 'null'
  return `(async () => {
  const NAME = ${name};
  const TEXT = ${text};
  const MODEL_CONFIG = ${modelConfig};
  const bridge = window.__qtComposerBridge;
  if (!bridge || !bridge.ready) return { ok: false, error: 'bridge_not_ready' };
  let pre = [];
  try { pre = (bridge.listComposers() || []).map((c) => String(c && c.composerId || '')).filter(Boolean); } catch (e) {}
  let created;
  try {
    if (MODEL_CONFIG) {
      const service = window.__qtComposerService;
      if (!service || !service.createComposer) return { ok: false, error: 'composer_service_not_ready' };
      created = await service.createComposer({
        skipShowAndFocus: true,
        skipFocus: true,
        skipSelect: true,
        partialState: { unifiedMode: 'agent', name: NAME }
      });
    } else {
      created = await bridge.createAgent('', NAME, { skipShowAndFocus: true, skipFocus: true, skipSelect: true, autoSubmit: false });
    }
  } catch (e) {
    return { ok: false, error: 'create_exception:' + String(e && e.message || e).slice(0, 180) };
  }
  let composerId = created && created.composerId ? String(created.composerId) : '';
  if (!composerId) {
    try {
      const post = (bridge.listComposers() || []).map((c) => String(c && c.composerId || '')).filter(Boolean);
      const diff = post.filter((id) => pre.indexOf(id) < 0);
      if (diff.length) composerId = diff[diff.length - 1];
    } catch (e) {}
  }
  if (MODEL_CONFIG) {
    try {
      const service = window.__qtComposerService;
      const modelService = service && service.modelConfigService;
      if (!modelService || !modelService.setModelConfigForComposer) {
        try { await service.deleteComposer(composerId); } catch (e) {}
        return { ok: false, error: 'model_config_service_not_ready', composerId };
      }
      const handle = service && service.composerDataService && (
        service.composerDataService.getHandleIfLoaded(composerId)
        || await service.composerDataService.getComposerHandleById(composerId)
      );
      if (!handle) {
        try { await service.deleteComposer(composerId); } catch (e) {}
        return { ok: false, error: 'composer_handle_not_ready', composerId };
      }
      // createComposer.partialState 会丢弃 modelConfig；必须走 Cursor 自己的
      // setModelConfigForComposer，才能真正写入独立模型、MAX Mode 与参数。
      await Promise.resolve(modelService.setModelConfigForComposer(
        handle,
        MODEL_CONFIG,
        'composer',
        { updateGlobalConfig: false }
      ));
      if (service.composerDataService.manuallyPersistComposer) {
        await service.composerDataService.manuallyPersistComposer(handle);
      }
      await Promise.resolve();
      const actualConfig = modelService.getEffectiveModelConfigForComposer(handle) || {};
      const actualModels = actualConfig.selectedModels || [];
      const actualModel = actualModels[0] || {};
      const actual = String(actualModel.modelId || actualConfig.modelName || '');
      if (actual !== String(MODEL_CONFIG.modelName || '')) {
        try { await service.deleteComposer(composerId); } catch (e) {}
        return { ok: false, error: 'model_unconfirmed:' + actual, composerId };
      }
      if ((actualConfig.maxMode === true) !== (MODEL_CONFIG.maxMode === true)) {
        try { await service.deleteComposer(composerId); } catch (e) {}
        return { ok: false, error: 'max_mode_unconfirmed:' + String(actualConfig.maxMode), composerId };
      }
      const expectedParameters = (MODEL_CONFIG.selectedModels[0].parameters || [])
        .map(function (p) { return String(p.id) + '=' + String(p.value); }).sort().join('|');
      const actualParameters = (actualModel.parameters || [])
        .map(function (p) { return String(p.id) + '=' + String(p.value); }).sort().join('|');
      if (actualParameters !== expectedParameters) {
        try { await service.deleteComposer(composerId); } catch (e) {}
        return { ok: false, error: 'model_parameters_unconfirmed:' + actualParameters, composerId };
      }
    } catch (e) {
      return { ok: false, error: 'model_inspection_failed:' + String(e && e.message || e).slice(0, 180), composerId };
    }
  }
  if (!composerId && bridge.getRecentlyCreatedComposers) {
    try {
      const recent = bridge.getRecentlyCreatedComposers(60000) || [];
      const match = recent.find((c) => c && c.composerId && pre.indexOf(String(c.composerId)) < 0);
      if (match) composerId = String(match.composerId);
    } catch (e) {}
  }
  if (!composerId) {
    return { ok: false, error: created && created.error ? String(created.error).slice(0, 180) : 'no_composer_id' };
  }
  // 注意：chatService.submitChatMaybeAbortCurrent 的 promise 随 Agent run 存续——
  // 持续对话模式（开场白让 Agent 循环 check_messages）下 run 不结束，promise 永不了结。
  // 因此不等受理回执的固定窗口：提交后立即短轮询 getStatus 核验 lastHumanText，
  // 文本命中即视为「异步受理」成功（最快 ~0.3s 返回）；submitPromise 在窗内了结
  // 则按其结果即返回；总窗口 5s 用尽才判 submit_unconfirmed。
  // （旧实现先固定等 5s 再核验，持续对话模式下每通道必吃满 5s+，是启动延迟主因。）
  const OVERALL_MS = 5000;
  const deadline = Date.now() + OVERALL_MS;
  const prefix = TEXT.slice(0, 50);
  let settled = false;
  let submitResult;
  let submitError = '';
  const submitPromise = bridge.submitByComposerId(composerId, TEXT, { ignoreQueuing: true })
    .then(function (r) { settled = true; submitResult = r; })
    .catch(function (e) { settled = true; submitError = String(e && e.message || e).slice(0, 180); });
  while (Date.now() < deadline) {
    if (settled) {
      if (submitError) return { ok: false, error: 'submit_exception:' + submitError, composerId };
      if (submitResult && submitResult.ok === true) return { ok: true, composerId };
      if (submitResult) {
        return { ok: false, error: 'submit_failed:' + String(submitResult && submitResult.error || 'unknown').slice(0, 180), composerId };
      }
    }
    try {
      const st = bridge.getStatus ? await bridge.getStatus(composerId) : undefined;
      const lastText = st && typeof st.lastHumanText === 'string' ? st.lastHumanText : '';
      if (st && st.found === true && lastText && lastText.slice(0, 50) === prefix) {
        return { ok: true, composerId, submitAsync: true };
      }
    } catch (e) { /* 继续重试 */ }
    await new Promise(function (r) { setTimeout(r, 300); });
  }
  return { ok: false, error: 'submit_unconfirmed:提交未获回执且未在会话中核验到文本', composerId };
})()`
}

function buildRuntimeInspectionExpression(composerIds: string[]): string {
  const ids = JSON.stringify(composerIds)
  return `(async () => {
    const bridge = window.__qtComposerBridge;
    if (!bridge || !bridge.ready || !bridge.getStatus) return { ok: false, error: 'bridge_not_ready' };
    const summaries = new Map();
    try {
      for (const item of bridge.listComposers ? (bridge.listComposers() || []) : []) {
        if (item && item.composerId) summaries.set(String(item.composerId), item);
      }
    } catch (e) {}
    const rows = [];
    for (const composerId of ${ids}) {
      try {
        const status = await bridge.getStatus(composerId);
        const summary = summaries.get(composerId);
        const found = !!(status && status.found === true);
        const rawStatus = String(status && status.status || summary && summary.status || '').toLowerCase();
        const isGenerating = !!(summary && summary.isGenerating === true);
        const hasError = !!(status && status.hasError === true);
        let state = 'unknown';
        let detail = '';
        if (!found) {
          state = 'stopped';
          detail = 'Cursor 实时状态中已找不到该 Agent 会话';
        } else if (hasError || ['aborted', 'cancelled', 'canceled', 'error', 'failed', 'stopped'].includes(rawStatus)) {
          state = 'stopped';
          detail = hasError ? 'Cursor Agent 已因错误终止' : 'Cursor Agent 已停止（' + rawStatus + '）';
        } else if (isGenerating || ['running', 'generating', 'streaming', 'processing'].includes(rawStatus)) {
          state = 'active';
          detail = 'Cursor 实时状态确认 Agent 正在执行';
        }
        const responseText = String(status && status.lastAiText || '');
        const responseId = String(status && (status.lastAiBubbleId || status.chatGenerationUUID) || '');
        // 过程块由 sgTeamProcess 写后事件直接推送；这里仅保留状态/正文兜底，
        // 避免 150ms inspect 与原生事件双写、重排或覆盖工具结果。
        rows.push({ composerId, state, detail, observedAt: Date.now(), isGenerating, responseId, responseText });
      } catch (e) {
        rows.push({ composerId, state: 'unknown', detail: 'Cursor 实时状态读取失败', observedAt: Date.now() });
      }
    }
    return { ok: true, rows };
  })()`
}

function parseWindowInfo(value: unknown): CursorCdpWindowInfo | undefined {
  if (!isRecord(value)) return undefined
  return {
    title: typeof value.title === 'string' ? value.title.slice(0, 300) : '',
    bridgeReady: value.bridge === true,
    workspaceScope: typeof value.scope === 'string' ? value.scope : ''
  }
}

const STREAM_TOOL_KINDS = new Set(['command', 'read', 'search', 'edit', 'write', 'browser', 'mcp', 'todo', 'other'])

/**
 * 内部协议工具名单与匹配规则——对齐 cursor-composer-telemetry 的 internalMcpCall：
 * 拾光内部同步通道（check_messages / record_reply / team_* 等）是协议噪音，
 * 不是用户要看的工作过程；转录侧一直过滤它们，CDP 过程流必须同样过滤，
 * 否则持续对话模式下过程卡会被每秒一次的 check_messages 刷屏。
 * toolFormerData.name 形如 'mcp-SG Team-record_reply'。
 */
const INTERNAL_STREAM_TOOL_NAMES = new Set([
  'check_messages',
  'record_reply',
  'wait_messages',
  'qingtian',
  'list_available',
  'list_mine',
  'get_task',
  'claim_task',
  'claim_review',
  'submit_for_review',
  'fail_task',
  'report_status'
])

function isInternalStreamTool(toolName: string): boolean {
  const lower = toolName.trim().toLowerCase()
  if (/^mcp-(qtwx|qingtian|qunshu|sg[_ -]?team)/.test(lower)) return true
  const bare = lower.replace(/^mcp-[^-]*-/, '')
  if (INTERNAL_STREAM_TOOL_NAMES.has(bare)) return true
  return bare.startsWith('team_') || bare.startsWith('qingtian_') || bare.startsWith('qtwx_')
}

/** 解析页面侧提取的过程流（宽容解析：单块坏数据不影响其余块；内部协议调用过滤）。 */
export function parseProcessStream(value: unknown): CursorProcessStream | undefined {
  if (!isRecord(value)) return undefined
  const items: Array<CursorStreamThinkingBlock | CursorStreamToolBlock | CursorStreamMessageBlock> = []
  if (Array.isArray(value.items)) {
    for (const item of value.items) {
      if (!isRecord(item) || typeof item.id !== 'string' || !item.id) continue
      if (item.kind === 'thinking') {
        const text = typeof item.text === 'string' ? stripRedactionMarkers(item.text.slice(0, 4_000)) : ''
        if (!text) continue
        items.push({
          kind: 'thinking',
          id: item.id.slice(0, 120),
          text,
          status: item.status === 'running' ? 'running' : 'done',
          durationMs: typeof item.durationMs === 'number' && item.durationMs >= 0
            ? Math.min(item.durationMs, 24 * 60 * 60_000)
            : undefined
        })
        continue
      }
      if (item.kind === 'message') {
        const text = typeof item.text === 'string' ? stripRedactionMarkers(item.text.slice(0, 8_000)) : ''
        if (!text) continue
        items.push({
          kind: 'message',
          id: item.id.slice(0, 120),
          text,
          status: item.status === 'running' ? 'running' : 'done'
        })
        continue
      }
      if (item.kind !== 'tool') continue
      const toolName = typeof item.toolName === 'string' ? item.toolName.slice(0, 80) : ''
      if (!toolName) continue
      if (isInternalStreamTool(toolName)) continue
      const toolKind = typeof item.toolKind === 'string' && STREAM_TOOL_KINDS.has(item.toolKind)
        ? item.toolKind as CursorStreamToolBlock['toolKind']
        : 'other'
      const status = item.status === 'done' || item.status === 'failed' ? item.status : 'running'
      const input = isRecord(item.input) ? item.input : undefined
      items.push({
        kind: 'tool',
        id: item.id.slice(0, 120),
        toolName,
        toolKind,
        summary: typeof item.summary === 'string' ? item.summary.slice(0, 160) : '',
        status,
        input,
        output: typeof item.output === 'string' && item.output ? item.output.slice(0, 8_000) : undefined,
        error: typeof item.error === 'string' && item.error ? item.error.slice(0, 4_000) : undefined
      })
    }
  }
  const todos = Array.isArray(value.todos)
    ? value.todos.flatMap((todo) => isRecord(todo) && typeof todo.content === 'string' && todo.content.trim()
      ? [{
          content: todo.content.trim().slice(0, 500),
          status: typeof todo.status === 'string' ? todo.status.slice(0, 40) : 'pending'
        }]
      : []).slice(0, 100)
    : undefined
  if (!items.length && !todos?.length) return undefined
  return {
    items: items.slice(-36),
    todos: todos?.length ? todos : undefined,
    generatingBubbleCount: typeof value.generatingBubbleCount === 'number' && value.generatingBubbleCount > 0
      ? Math.min(Math.floor(value.generatingBubbleCount), 32)
      : 0
  }
}

export class CursorCdpSessionCreator {
  private readonly port: number
  private readonly fetchTargets: NonNullable<CursorCdpSessionCreatorOptions['fetchTargets']>
  private readonly evaluate: NonNullable<CursorCdpSessionCreatorOptions['evaluate']>
  private readonly operationTimeoutMs: number

  constructor(options: CursorCdpSessionCreatorOptions = {}) {
    const envPort = Number(process.env[CURSOR_CDP_PORT_ENV])
    this.port = options.port ?? (Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : CURSOR_CDP_DEFAULT_PORT)
    this.fetchTargets = options.fetchTargets ?? defaultFetchTargets
    this.evaluate = options.evaluate ?? defaultEvaluate
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
  }

  get debugPort(): number {
    return this.port
  }

  /** 探测调试端口与候选窗口，供 UI 引导与创建前检查。 */
  async probe(): Promise<CursorCdpProbeResult> {
    let targets: CursorCdpTarget[]
    try {
      targets = await this.fetchTargets(this.port, PROBE_TIMEOUT_MS)
    } catch {
      return {
        available: false,
        port: this.port,
        windows: [],
        issue: `${CURSOR_CDP_UNAVAILABLE_HINT}（127.0.0.1:${this.port}）`
      }
    }
    const windows: CursorCdpWindowInfo[] = []
    for (const target of targets) {
      try {
        const info = parseWindowInfo(await this.evaluate(target.webSocketDebuggerUrl, WINDOW_PROBE_EXPRESSION, PROBE_TIMEOUT_MS + 2_500))
        if (info) windows.push(info)
      } catch {
        windows.push({ title: target.title || target.url, bridgeReady: false, workspaceScope: '' })
      }
    }
    return { available: true, port: this.port, windows }
  }

  /** 读取绑定 Composer 的实时执行终态；用于让明确终止证据即时压过静默宽限。 */
  async inspectComposerRuntime(
    workspacePath: string | undefined,
    composerIds: string[]
  ): Promise<Record<string, CursorComposerRuntimeEvidence>> {
    const unique = [...new Set(composerIds.map((id) => id.trim()).filter(Boolean))].slice(0, 16)
    if (!unique.length) return {}
    const { target } = await this.resolveTarget(workspacePath)
    if (!target) return {}
    let value: unknown
    try {
      value = await this.evaluate(
        target.webSocketDebuggerUrl,
        buildRuntimeInspectionExpression(unique),
        PROBE_TIMEOUT_MS + 2_500
      )
    } catch {
      return {}
    }
    if (!isRecord(value) || value.ok !== true || !Array.isArray(value.rows)) return {}
    const result: Record<string, CursorComposerRuntimeEvidence> = {}
    for (const row of value.rows) {
      if (!isRecord(row)) continue
      const composerId = typeof row.composerId === 'string' ? row.composerId : ''
      const state = row.state === 'active' || row.state === 'stopped' || row.state === 'unknown'
        ? row.state
        : 'unknown'
      if (!composerId || !unique.includes(composerId)) continue
      result[composerId] = {
        composerId,
        state,
        detail: typeof row.detail === 'string' ? row.detail.slice(0, 300) : '',
        observedAt: typeof row.observedAt === 'number' ? row.observedAt : Date.now(),
        isGenerating: row.isGenerating === true,
        responseId: typeof row.responseId === 'string' && row.responseId ? row.responseId.slice(0, 200) : undefined,
        responseText: typeof row.responseText === 'string' && row.responseText
          ? row.responseText.slice(0, 100_000)
          : undefined,
        process: parseProcessStream(row.process)
      }
    }
    return result
  }

  private async resolveTarget(workspacePath: string | undefined): Promise<{ target?: CursorCdpTarget; error?: string }> {
    let targets: CursorCdpTarget[]
    try {
      targets = await this.fetchTargets(this.port, PROBE_TIMEOUT_MS)
    } catch {
      return {
        error: `${CURSOR_CDP_UNAVAILABLE_HINT}（127.0.0.1:${this.port}）：请使用「重启 Cursor 并启用会话创建」，或手动以 --remote-debugging-port=${this.port} 启动 Cursor`
      }
    }
    if (!targets.length) {
      return { error: `调试端口已连通，但没有发现任何 Cursor 工作区窗口（请确认 Cursor 已打开团队工作区）` }
    }

    if (targets.length === 1) {
      const only = targets[0]!
      if (!workspacePath?.trim()) return { target: only }
      try {
        const info = parseWindowInfo(await this.evaluate(only.webSocketDebuggerUrl, WINDOW_PROBE_EXPRESSION, PROBE_TIMEOUT_MS + 2_500))
        if (!info) return { target: only }
        const scopes = workspaceScopeCandidates(workspacePath)
        if (info.workspaceScope) {
          return scopes.includes(info.workspaceScope)
            ? { target: only }
            : { error: `调试端口只发现了非当前团队工作区的 Cursor 窗口（${info.title || only.title || only.url}）；请打开团队工作区后重试` }
        }
        const baseName = workspacePath.trim().replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''
        const title = info.title || only.title || ''
        if (baseName && title.includes(baseName)) return { target: only }
        if (info.bridgeReady) return { target: only }
        return { error: `调试端口只发现了无法创建拾光会话的 Cursor 窗口（${title || only.url}）；请打开团队 IDE 工作区后重试` }
      } catch {
        return { target: only }
      }
    }

    const probes = new Map<string, CursorCdpWindowInfo>()
    for (const target of targets) {
      try {
        const info = parseWindowInfo(await this.evaluate(target.webSocketDebuggerUrl, WINDOW_PROBE_EXPRESSION, PROBE_TIMEOUT_MS + 2_500))
        if (info) probes.set(target.id, info)
      } catch {
        // 单个窗口探测失败不阻断其余窗口
      }
    }

    if (workspacePath?.trim()) {
      const scopes = workspaceScopeCandidates(workspacePath)
      const scopeMatches = targets.filter((target) => {
        const info = probes.get(target.id)
        return info?.workspaceScope && scopes.includes(info.workspaceScope)
      })
      if (scopeMatches.length === 1) return { target: scopeMatches[0] }

      const baseName = workspacePath.trim().replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''
      if (baseName) {
        const titleMatches = targets.filter((target) => {
          const info = probes.get(target.id)
          const title = info?.title || target.title || ''
          return title.includes(baseName)
        })
        if (titleMatches.length === 1) return { target: titleMatches[0] }
      }
    }

    const readyTargets = targets.filter((target) => probes.get(target.id)?.bridgeReady)
    if (readyTargets.length === 1) return { target: readyTargets[0] }

    const titles = targets.map((target) => `「${probes.get(target.id)?.title || target.title || target.url}」`).join('、')
    return { error: `检测到 ${targets.length} 个 Cursor 窗口（${titles}），无法确定团队工作区所在窗口；请只保留团队工作区窗口后重试` }
  }

  /**
   * 在团队工作区所在 Cursor 窗口创建新 Agent 会话并提交开场提示词。
   * 成功返回真实 composerId（硬回执）；失败返回明确的分层错误。
   */
  async createAgentSession(input: CursorCdpCreateInput): Promise<CursorCdpCreateResult> {
    const channelId = String(input.channelId ?? '').trim()
    if (!/^\d{1,3}$/.test(channelId)) return { ok: false, message: '通道号无效' }
    if (!input.prompt.trim()) return { ok: false, message: '开场提示词为空，已中止创建' }

    const { target, error } = await this.resolveTarget(input.workspacePath)
    if (!target) return { ok: false, message: error ?? '未找到可用的 Cursor 窗口' }

    let value: unknown
    try {
      value = await this.evaluate(
        target.webSocketDebuggerUrl,
        buildCreateExpression({ name: input.name, prompt: input.prompt, modelSelection: input.modelSelection }),
        this.operationTimeoutMs || EVALUATE_TIMEOUT_MS
      )
    } catch (reason) {
      return { ok: false, message: `CDP 创建调用失败：${boundedError(reason)}` }
    }

    if (!isRecord(value)) return { ok: false, message: 'CDP 创建未返回有效结果' }
    const composerId = typeof value.composerId === 'string' && value.composerId.trim() ? value.composerId.trim() : undefined
    if (value.ok === true && composerId) {
      return {
        ok: true,
        message: value.submitAsync === true ? '会话已创建，开场提示词已异步受理' : '会话已创建并提交开场提示词',
        composerId,
        ...(input.modelSelection ? { modelId: input.modelSelection.modelId } : {})
      }
    }
    const detail = typeof value.error === 'string' && value.error ? value.error : '未知错误'
    if (detail === 'bridge_not_ready') {
      return { ok: false, message: 'Cursor 窗口内拾光网关联接未就绪（__qtComposerBridge 不可用），请先在拾光面板执行网关注入' }
    }
    if (detail.startsWith('submit_') && composerId) {
      return { ok: false, message: `会话已创建但开场提示词提交失败（${detail}）`, composerId }
    }
    return { ok: false, message: `会话创建失败（${detail}）` }
  }
}
