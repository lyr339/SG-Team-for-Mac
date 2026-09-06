import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import WebSocket from 'ws'
import { sanitizeModelDisplayText } from '../../domain/model-output-sanitizer'
import { CHANNEL_USER_DELIVERY_MARKER } from '../../domain/channel-delivery-policy'
import type { CursorModelSelection } from '../../domain/cursor-model'
import type { CursorWorkspaceDetection } from '../../domain/cursor-workspace'
import { workspaceIdentityOf } from './workspace-identity'
import { nativeUsagePayload } from './cursor-native-usage'

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
  /** Cursor bubble 原生创建时间；虚拟回合分段优先使用。 */
  startedAt?: number
}

export interface CursorStreamThinkingBlock {
  kind: 'thinking'
  id: string
  text: string
  status: 'running' | 'done'
  durationMs?: number
  startedAt?: number
}

export interface CursorStreamMessageBlock {
  kind: 'message'
  id: string
  text: string
  status: 'running' | 'done'
  startedAt?: number
}

/**
 * CDP 侧提取的当前回合过程流（composer 数据模型实时增量）：
 * 正文之外的思考、工具调用生命周期与 todos——直接映射 Cursor 原生内存模型，
 * 覆盖未自觉走流式上报协议的 Agent。
 */
export interface CursorProcessStream {
  /** 当前原生用户 bubble id；作为准确回合边界，避免快速连续对话串流。 */
  turnId?: string
  /** Cursor fullConversationHeadersOnly 的原始顺序；思考与工具不可分组重排。 */
  items: Array<CursorStreamThinkingBlock | CursorStreamToolBlock | CursorStreamMessageBlock>
  todos?: Array<{ content: string; status: string }>
  generatingBubbleCount: number
  /** 超长回合超过传输上限时显式披露数量，避免伪装成“全部”。 */
  truncatedItemCount?: number
  /**
   * 本帧是当前回合可见窗口的权威完整快照（observer 写后快照）：
   * - true 时缺席块应撤下（截断帧只保护窗口外历史）；
   * - false/缺省（runtime inspect 等不携带过程的来源、旧版 hook 帧）不具权威性，
   *   服务层维持「本帧无过程载荷 → 保留旧块」的追加合并语义。
   */
  snapshotComplete?: boolean
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
  /**
   * Composer 内存里的本回合真实计费 token（turnTokenUsage）与上下文实时读数。
   * 与 turnEnded 事件同源（2026-09-01 运行态实证：两处值逐位一致）；生成中
   * 随流式写入更新，回合结束后定格——按「当前回合累计」语义消费。
   */
  usage?: CursorRuntimeTurnUsage
}

/** CDP 运行时探针捎带的用量快照（turnTokenUsage + 上下文窗口）。 */
export interface CursorRuntimeTurnUsage {
  generationId?: string
  modelId?: string
  stopped?: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 上下文窗口实时占用（Cursor 自家 UI「Context: X%」同源数据）。 */
  contextTokensUsed?: number
  contextTokenLimit?: number
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

// Electron preload 暴露的窗口配置：读取真实工作区身份，不使用标题/最近记录推测。
export const CURRENT_WORKSPACE_EXPRESSION = `(() => {
  const config = window.vscode?.context?.configuration?.();
  if (!config) return { state: 'loading' };
  if (config.remoteAuthority) return { state: 'remote' };
  const workspace = config.workspace;
  if (!workspace) return { state: 'empty' };
  const uri = workspace.uri;
  if (!uri) return { state: 'workspace-file' };
  if (uri.scheme !== 'file') return { state: 'remote' };
  return { state: 'folder', path: uri.path, authority: uri.authority || '', id: workspace.id };
})()`

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

export function buildRuntimeInspectionExpression(composerIds: string[]): string {
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
    const TRANSPORT_TOOLS = ['check_messages', 'record_reply', 'wait_messages', 'qingtian'];
    function isTransportTool(name) {
      const lower = String(name || '').toLowerCase();
      return TRANSPORT_TOOLS.some(item => (
        lower === item || lower.endsWith('-' + item) || lower.endsWith('_' + item)
      ));
    }
    function extractToolName(later) {
      const td = later && later.toolFormerData;
      const modernArgs = td && td.toolCall && td.toolCall.tool && td.toolCall.tool.value && td.toolCall.tool.value.args;
      return String(td && td.name || modernArgs && (modernArgs.toolName || modernArgs.name) || '');
    }
    // 与 observer processSnapshot 同语义：check_messages 结果含真实用户消息投递标题 →
    // 其后的 thinking 是新回合业务工作，不按尾部轮询余波归组。
    const USER_DELIVERY_MARKER = ${JSON.stringify(CHANNEL_USER_DELIVERY_MARKER)};
    function collectResultTexts(value, depth, out) {
      if (value === null || value === undefined || depth > 6 || out.length > 30) return;
      if (typeof value === 'string') {
        const text = value.trim();
        if ((text.startsWith('{') || text.startsWith('[')) && text.length < 2000000) {
          try { collectResultTexts(JSON.parse(text), depth + 1, out); return; } catch (e) {}
        }
        out.push(value);
        return;
      }
      if (Array.isArray(value)) { for (const item of value.slice(0, 30)) collectResultTexts(item, depth + 1, out); return; }
      if (typeof value === 'object') {
        if (typeof value.text === 'string') out.push(value.text);
        for (const key of ['result', 'output', 'content', 'contents']) {
          if (value[key] !== undefined) collectResultTexts(value[key], depth + 1, out);
        }
      }
    }
    // 结果到齐后不再变化：按 bubbleId 记忆在 window 上，150ms 一次的 inspect 不重复解析
    // 带图片投递的大结果串（数百 KB）。
    const deliveryMemo = window.__sgTeamDeliveryByBubble instanceof Map
      ? window.__sgTeamDeliveryByBubble
      : (window.__sgTeamDeliveryByBubble = new Map());
    function isUserDelivery(bubbleId, later) {
      const td = later && later.toolFormerData;
      if (!td) return false;
      const lower = extractToolName(later).toLowerCase();
      if (!(lower === 'check_messages' || lower.endsWith('-check_messages') || lower.endsWith('_check_messages'))) return false;
      const key = String(bubbleId || '');
      if (key && deliveryMemo.has(key)) return deliveryMemo.get(key);
      const modern = td.toolCall && td.toolCall.tool && td.toolCall.tool.value;
      const result = modern && modern.result !== undefined ? modern.result : td.result;
      if (result === undefined || result === null) return false;
      let delivered = false;
      try {
        const texts = [];
        collectResultTexts(result, 0, texts);
        delivered = texts.some(text => text.includes(USER_DELIVERY_MARKER));
      } catch (e) { delivered = false; }
      const status = String(td.status || '').toLowerCase();
      if (key && status && status !== 'running' && status !== 'pending') {
        if (deliveryMemo.size > 2000) deliveryMemo.clear();
        deliveryMemo.set(key, delivered);
      }
      return delivered;
    }
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
        let responseText = '';
        let responseId = '';
        let dataInspected = false;
        try {
          const data = bridge.getComposerData ? bridge.getComposerData(composerId) : undefined;
          const headers = data && data.fullConversationHeadersOnly || [];
          const map = data && data.conversationMap || {};
          dataInspected = headers.length > 0 || Object.keys(map).length > 0;
          let lastUser = -1;
          for (let i = headers.length - 1; i >= 0; i--) if (headers[i] && headers[i].type === 1) { lastUser = i; break; }
          // 阶段 D（RC-6）：最终正文定位前先做内部协议相位分组（与 observer
          // processSnapshot 同语义）——传输工具 + 其关联 thinking/capability/
          // serviceStatus 不构成「后续工作」，正文之后只剩内部协议噪声时仍是
          // 最终正文。旧实现把 keepalive thinking、capability:30 当工作，导致
          // 真正的最终回答被误判为中间过程。
          const toolPhase = new Array(headers.length).fill(null);
          for (let k = lastUser + 1; k < headers.length; k++) {
            const later = map[headers[k] && headers[k].bubbleId] || {};
            if (!later.toolFormerData) continue;
            const toolName = extractToolName(later);
            toolPhase[k] = toolName ? (isTransportTool(toolName) ? 'transport' : 'business') : 'pending';
          }
          const transportAssociated = new Array(headers.length).fill(false);
          let nextToolPhase = null;
          for (let k = headers.length - 1; k > lastUser; k--) {
            if (toolPhase[k]) { nextToolPhase = toolPhase[k]; continue; }
            const bubble = map[headers[k] && headers[k].bubbleId] || {};
            // 带正文的 message 重置相位（与 observer 同语义）：正文之后的
            // record_reply/check_messages 脚手架不回溯吞掉正文之前的业务思考。
            if (typeof bubble.text === 'string' && bubble.text.trim()) { nextToolPhase = null; continue; }
            // pending（未水合 MCP）按传输倾向处理——与 observer 工作判定同语义：
            // 误判传输可自愈，误判业务会让最终正文进 cursor-msg（双渲染）。
            if (nextToolPhase === 'transport' || nextToolPhase === 'pending') transportAssociated[k] = true;
          }
          // 后缀预扫描（O(n)）：长回合下逐气泡内层扫描是 O(n²) 页面热点。
          const messageAhead = new Array(headers.length).fill(false);
          for (let k = headers.length - 2; k >= 0; k--) {
            const later = map[headers[k + 1] && headers[k + 1].bubbleId] || {};
            messageAhead[k] = messageAhead[k + 1]
              || (typeof later.text === 'string' && Boolean(later.text.trim()));
          }
          let prevToolPhase = null;
          let prevToolIndex = -1;
          for (let k = lastUser + 1; k < headers.length; k++) {
            if (toolPhase[k]) { prevToolPhase = toolPhase[k]; prevToolIndex = k; continue; }
            if (transportAssociated[k]) continue;
            // 尾部兜底的例外：前一工具是投递了真实用户消息的 check_messages（与 observer 同语义）。
            const prevBubbleId = headers[prevToolIndex] && headers[prevToolIndex].bubbleId;
            if (!messageAhead[k] && prevToolPhase === 'transport'
              && !isUserDelivery(prevBubbleId, map[prevBubbleId])) {
              transportAssociated[k] = true;
            }
          }
          for (let i = headers.length - 1; i > lastUser; i--) {
            const header = headers[i];
            const message = map[header && header.bubbleId] || {};
            const text = typeof message.text === 'string' ? message.text : '';
            if (!text.trim()) continue;
            let laterWork = false;
            for (let j = i + 1; j < headers.length; j++) {
              const later = map[headers[j] && headers[j].bubbleId] || {};
              const thinking = typeof later.thinking === 'string' ? later.thinking : later.thinking && later.thinking.text;
              const td = later.toolFormerData;
              const toolName = extractToolName(later);
              if (td && toolName && !isTransportTool(toolName)) { laterWork = true; break; }
              if (typeof thinking === 'string' && thinking.trim() && !transportAssociated[j]) { laterWork = true; break; }
              if (!td && later.planUpdate) { laterWork = true; break; }
            }
            if (!laterWork) {
              responseText = text;
              responseId = String(header.bubbleId || '');
            }
            break;
          }
        } catch (e) {}
        if (!dataInspected && !responseId && !responseText) {
          responseText = String(status && status.lastAiText || '');
          responseId = String(status && (status.lastAiBubbleId || status.chatGenerationUUID) || '');
        }
        // 直接读原生 composer，而非 bridge 的精简摘要；与写后 hook 共用载荷口径。
        let usage = null;
        try {
          const data = window.__qtComposerService?.composerDataService?.getComposerDataIfLoaded?.(composerId);
          const raw = (${nativeUsagePayload.toString()})(data, composerId);
          if (raw) usage = { generationId: raw.g, modelId: raw.m,
            inputTokens: raw.i || 0, outputTokens: raw.o || 0, cacheReadTokens: raw.r || 0, cacheWriteTokens: raw.w || 0,
            contextTokensUsed: raw.used, stopped: raw.stopped };
        } catch (e) {}
        // 过程块由 sgTeamProcess 写后事件直接推送；这里仅保留状态/正文兜底，
        // 避免 150ms inspect 与原生事件双写、重排或覆盖工具结果。
        rows.push({ composerId, state, detail, observedAt: Date.now(), isGenerating, responseId, responseText, usage });
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
 * 内部协议工具名单与匹配规则——只收敛纯传输噪音：
 * check_messages / record_reply / wait_messages / qingtian（含旧服务器前缀形态）。
 * team_task / team_run 等会改变用户可见工作状态的工具必须进过程流
 * （Cursor 原生会话里同样可见）；它们调用频率低，不构成刷屏源。
 * toolFormerData.name 形如 'mcp-SG Team-record_reply'——后缀匹配同时覆盖裸名形态。
 */
const INTERNAL_STREAM_TOOL_NAMES = new Set([
  'check_messages',
  'record_reply',
  'wait_messages',
  'qingtian'
])

function isInternalStreamTool(toolName: string): boolean {
  const lower = toolName.trim().toLowerCase()
  return [...INTERNAL_STREAM_TOOL_NAMES].some((name) => (
    lower === name || lower.endsWith(`-${name}`) || lower.endsWith(`_${name}`)
  ))
}

/**
 * 内部协议工具判定（check_messages / record_reply / wait_messages / qingtian，
 * 含服务器前缀形态）。供转录兜底等旁路解析与主过滤共用同一名单。
 */
export function isCursorInternalToolName(toolName: string): boolean {
  return isInternalStreamTool(toolName) || toolName.trim().toLowerCase() === 'mcptoolcall'
}

/** 解析页面侧提取的过程流（宽容解析：单块坏数据不影响其余块；内部协议调用过滤）。 */
export function parseProcessStream(value: unknown): CursorProcessStream | undefined {
  if (!isRecord(value)) return undefined
  const items: Array<CursorStreamThinkingBlock | CursorStreamToolBlock | CursorStreamMessageBlock> = []
  if (Array.isArray(value.items)) {
    for (const item of value.items) {
      if (!isRecord(item) || typeof item.id !== 'string' || !item.id) continue
      if (item.kind === 'thinking') {
        const text = typeof item.text === 'string' ? sanitizeModelDisplayText(item.text.slice(0, 24_200)).text : ''
        if (!text) continue
        items.push({
          kind: 'thinking',
          id: item.id.slice(0, 120),
          text,
          status: item.status === 'running' ? 'running' : 'done',
          startedAt: typeof item.startedAt === 'number' && Number.isFinite(item.startedAt) && item.startedAt > 0
            ? Math.floor(item.startedAt)
            : undefined,
          durationMs: typeof item.durationMs === 'number' && item.durationMs >= 0
            ? Math.min(item.durationMs, 24 * 60 * 60_000)
            : undefined
        })
        continue
      }
      if (item.kind === 'message') {
        const text = typeof item.text === 'string' ? sanitizeModelDisplayText(item.text.slice(0, 12_200)).text : ''
        if (!text) continue
        items.push({
          kind: 'message',
          id: item.id.slice(0, 120),
          text,
          status: item.status === 'running' ? 'running' : 'done',
          startedAt: typeof item.startedAt === 'number' && Number.isFinite(item.startedAt) && item.startedAt > 0
            ? Math.floor(item.startedAt)
            : undefined
        })
        continue
      }
      if (item.kind !== 'tool') continue
      const toolName = typeof item.toolName === 'string' ? item.toolName.slice(0, 80) : ''
      if (!toolName) continue
      if (isInternalStreamTool(toolName)) continue
      // 旧版 hook（v14 及以前）的 MCP 首帧占位名：真实工具名未水合，暂缓展示
      // （RC-5.1）；水合后的下一帧以真实名称到达，届时按 transport/business 分类。
      if (toolName.toLowerCase() === 'mcptoolcall') continue
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
        output: typeof item.output === 'string' && item.output ? item.output.slice(0, 12_200) : undefined,
        error: typeof item.error === 'string' && item.error ? item.error.slice(0, 8_200) : undefined,
        startedAt: typeof item.startedAt === 'number' && Number.isFinite(item.startedAt) && item.startedAt > 0
          ? Math.floor(item.startedAt)
          : undefined
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
  // 权威空快照（snapshotComplete=true）必须存活：内部协议工具全部被过滤后
  // 「可见过程为空」是有效状态（撤下旧块的依据）；只有非权威帧（runtime
  // inspect 兜底 / 旧版 hook）才在空集时返回 undefined。
  if (!items.length && !todos?.length && value.snapshotComplete !== true) return undefined
  return {
    turnId: typeof value.turnId === 'string' && value.turnId ? value.turnId.slice(0, 120) : undefined,
    items: items.slice(-256),
    todos: todos?.length ? todos : undefined,
    generatingBubbleCount: typeof value.generatingBubbleCount === 'number' && value.generatingBubbleCount > 0
      ? Math.min(Math.floor(value.generatingBubbleCount), 32)
      : 0,
    truncatedItemCount: typeof value.truncatedItemCount === 'number' && value.truncatedItemCount > 0
      ? Math.min(Math.floor(value.truncatedItemCount), 100_000)
      : undefined,
    snapshotComplete: value.snapshotComplete === true ? true : undefined
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

  /** 每次重新枚举窗口，覆盖 Cursor 在同一进程内更换工作区/重载页面的情况。 */
  async detectCurrentWorkspace(): Promise<CursorWorkspaceDetection> {
    const unavailable = (detail: string): CursorWorkspaceDetection => ({
      state: 'unavailable', candidates: [], detail, observedAt: Date.now()
    })
    try {
      const targets = await this.fetchTargets(this.port, PROBE_TIMEOUT_MS)
      if (!targets.length) return unavailable('未发现 Cursor IDE 窗口')
      if (targets.length !== 1) return {
        ...unavailable('检测到多个 Cursor IDE 窗口，请保留一个工作区窗口'), state: 'ambiguous'
      }
      const value = await this.evaluate(targets[0]!.webSocketDebuggerUrl, CURRENT_WORKSPACE_EXPRESSION, PROBE_TIMEOUT_MS)
      if (!isRecord(value)) return unavailable('正在识别 Cursor 工作区')
      if (value.state === 'empty') return unavailable('Cursor 未打开工作区')
      if (value.state === 'remote') return unavailable('当前为远程工作区，暂仅识别本地文件夹')
      if (value.state === 'workspace-file') return unavailable('当前为多根工作区，暂仅识别本地文件夹')
      if (value.state !== 'folder' || typeof value.path !== 'string' || !value.path.startsWith('/')) {
        return unavailable('正在识别 Cursor 工作区')
      }
      let folder = value.path
      if (process.platform === 'win32') {
        folder = value.authority ? `//${String(value.authority)}${folder}` : folder.replace(/^\/([a-zA-Z]:)/, '$1')
      } else if (value.authority) return unavailable('当前文件夹路径不属于本机')
      const workspace = {
        ...workspaceIdentityOf(folder),
        ...(typeof value.id === 'string' ? { cursorWorkspaceId: value.id } : {})
      }
      return { state: 'detected', workspace, candidates: [workspace], detail: '由 Cursor 当前 IDE 窗口确认', observedAt: Date.now() }
    } catch {
      return unavailable('Cursor 检测连接未就绪，请确认 Cursor 已启动且调试连接可用')
    }
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
      const usageRaw = isRecord(row.usage) ? row.usage : undefined
      const usageToken = (value: unknown): number => {
        const num = Number(value)
        return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0
      }
      const usage = usageRaw && (usageToken(usageRaw.inputTokens) || usageToken(usageRaw.outputTokens)
        || usageToken(usageRaw.cacheReadTokens) || usageToken(usageRaw.cacheWriteTokens) || usageToken(usageRaw.contextTokensUsed))
        ? {
            ...(typeof usageRaw.generationId === 'string' ? { generationId: usageRaw.generationId } : {}),
            ...(typeof usageRaw.modelId === 'string' ? { modelId: usageRaw.modelId } : {}),
            ...(usageRaw.stopped === true ? { stopped: true } : {}),
            inputTokens: usageToken(usageRaw.inputTokens),
            outputTokens: usageToken(usageRaw.outputTokens),
            cacheReadTokens: usageToken(usageRaw.cacheReadTokens),
            cacheWriteTokens: usageToken(usageRaw.cacheWriteTokens),
            contextTokensUsed: usageToken(usageRaw.contextTokensUsed) || undefined,
            contextTokenLimit: usageToken(usageRaw.contextTokenLimit) || undefined
          }
        : undefined
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
        process: parseProcessStream(row.process),
        usage
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

  /** 与会话创建共用同一目标解析，供过程观察器连接团队工作区窗口。 */
  async resolveWorkbenchSocket(workspacePath?: string): Promise<string | undefined> {
    const { target } = await this.resolveTarget(workspacePath)
    return target?.webSocketDebuggerUrl
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
