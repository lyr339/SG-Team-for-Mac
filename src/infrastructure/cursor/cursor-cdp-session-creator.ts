import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import WebSocket from 'ws'

/**
 * 通过 Chrome DevTools Protocol 直连 Cursor 渲染进程创建 Agent 会话。
 *
 * 与晴天插件原生批量创建（silent_launch）同源同 API：
 *   window.__qtComposerBridge.createAgent('', name, { skipShowAndFocus: true, autoSubmit: false })
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
}

export interface CursorCdpCreateResult {
  ok: boolean
  message: string
  composerId?: string
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
  return [...variants].map((variant) => cursorWorkspaceScopeId(variant))
}

const WINDOW_PROBE_EXPRESSION = `({
  bridge: !!(window.__qtComposerBridge && window.__qtComposerBridge.ready),
  scope: String(window.__qtBatchWorkspaceScopeId || ''),
  title: String(document.title || '')
})`

function buildCreateExpression(input: { name: string; prompt: string }): string {
  const name = JSON.stringify(input.name)
  const text = JSON.stringify(input.prompt)
  return `(async () => {
  const NAME = ${name};
  const TEXT = ${text};
  const bridge = window.__qtComposerBridge;
  if (!bridge || !bridge.ready) return { ok: false, error: 'bridge_not_ready' };
  let pre = [];
  try { pre = (bridge.listComposers() || []).map((c) => String(c && c.composerId || '')).filter(Boolean); } catch (e) {}
  let created;
  try {
    created = await bridge.createAgent('', NAME, { skipShowAndFocus: true, skipFocus: true, skipSelect: true, autoSubmit: false });
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
  // 因此只短等受理回执；超时未了结时用 getStatus 的 lastHumanText 核对文本确已落入会话，
  // 命中即视为「异步受理」成功（后续本有遥测绑定 + 待命租约两级验证兜底）。
  const ACK_MS = 5000;
  let settled = false;
  let submitResult;
  let submitError = '';
  const submitPromise = bridge.submitByComposerId(composerId, TEXT, { ignoreQueuing: true })
    .then(function (r) { settled = true; submitResult = r; })
    .catch(function (e) { settled = true; submitError = String(e && e.message || e).slice(0, 180); });
  await Promise.race([submitPromise, new Promise(function (r) { setTimeout(r, ACK_MS); })]);
  if (settled) {
    if (submitError) return { ok: false, error: 'submit_exception:' + submitError, composerId };
    if (!submitResult || submitResult.ok !== true) {
      return { ok: false, error: 'submit_failed:' + String(submitResult && submitResult.error || 'unknown').slice(0, 180), composerId };
    }
    return { ok: true, composerId };
  }
  // 受理证据核验：最后一条人类消息与提交文本前缀一致（短轮询容纳写入延迟）
  const prefix = TEXT.slice(0, 50);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const st = bridge.getStatus ? await bridge.getStatus(composerId) : undefined;
      const lastText = st && typeof st.lastHumanText === 'string' ? st.lastHumanText : '';
      if (st && st.found === true && lastText && lastText.slice(0, 50) === prefix) {
        return { ok: true, composerId, submitAsync: true };
      }
    } catch (e) { /* 继续重试 */ }
    await new Promise(function (r) { setTimeout(r, 500); });
  }
  return { ok: false, error: 'submit_unconfirmed:提交未获回执且未在会话中核验到文本', composerId };
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
        return { error: `调试端口只发现了无法创建群枢会话的 Cursor 窗口（${title || only.url}）；请打开团队 IDE 工作区后重试` }
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
        buildCreateExpression({ name: input.name, prompt: input.prompt }),
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
        composerId
      }
    }
    const detail = typeof value.error === 'string' && value.error ? value.error : '未知错误'
    if (detail === 'bridge_not_ready') {
      return { ok: false, message: 'Cursor 窗口内晴天网关联接未就绪（__qtComposerBridge 不可用），请先在晴天面板执行网关注入' }
    }
    if (detail.startsWith('submit_') && composerId) {
      return { ok: false, message: `会话已创建但开场提示词提交失败（${detail}）`, composerId }
    }
    return { ok: false, message: `会话创建失败（${detail}）` }
  }
}
