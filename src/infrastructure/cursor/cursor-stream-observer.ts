import WebSocket from 'ws'
import type { CursorUsageEvent } from '../../domain/cursor-usage'
import { parseProcessStream, type CursorProcessStream } from './cursor-cdp-session-creator'

/**
 * Cursor 过程流写信号观察者（事件驱动层）。
 *
 * 在 Cursor workbench 渲染进程内 hook composerDataHandleManager 的写路径
 * （markDirty / markMessageDirty / updateWithoutMarkingDirty / pushComposer——
 * 每次模型写入与持久化批次必经），经 CDP Runtime binding「sgTeamStream」
 * 把写信号推回主进程：真正的事件推送，空闲期零事件（实测 0/3s）、
 * 投递延迟 p50=0ms。
 *
 * 页面内同时推送 composerId 写信号与当前 Composer 的原生有序过程快照；
 * thinking、工具参数/结果、todo 均在写后同一微任务读取，不再经过主进程
 * 二次 evaluate，也不读取 transcript 或 Agent 主动上报的过程。
 *
 * hook 经 Page.addScriptToEvaluateOnNewDocument 注册，页面重载自动重装；
 * binding 由 CDP 自动注入后续 executionContext。连接断开按退避重连。
 * 运行时轮询只承担会话存活与正文状态核验，不承担过程重建；observer 缺席时
 * 明确没有过程帧，避免用低保真来源伪装成 Cursor 原生体验。
 *
 * 用量通道（usage）：bundle 补丁（patch-cursor-usage-hook.ts）在
 * turnEnded 消费点调用 __sgTeamUsage(JSON)——本 observer 注册同名 binding
 * 接收每回合真实计费 token 并解析转发（onUsageEvent）。
 */

export const CURSOR_STREAM_BINDING_NAME = 'sgTeamStream'
export const CURSOR_USAGE_BINDING_NAME = '__sgTeamUsage'
export const CURSOR_PROCESS_BINDING_NAME = 'sgTeamProcess'
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60_000
const ATTACH_TIMEOUT_MS = 8_000

/**
 * 页面内注入的 hook 源码：幂等守卫（manager 身份 + wrapped 标记双保险）+
 * 透明包装写方法 + binding 推送 composerId + 原始函数存档（供 dispose 还原）。
 * workbench 服务异步就绪：new-document 场景下 manager 可能未加载——页面内
 * 自轮询重试（2s 间隔，上限 60 次），保证重载后 hook 自动恢复，不依赖重连。
 */
export const CURSOR_STREAM_HOOK_EXPRESSION = `(() => {
  const HOOK_VERSION = 11
  let attempts = 0
  const pendingSnapshots = new Set()
  let snapshotQueued = false
  function classifyTool(name) {
    const n = String(name || '').toLowerCase()
    if (n.includes('todo')) return 'todo'
    if (n.includes('browser') || n.includes('computer') || n.includes('screenshot') || n.includes('navigate') || n.includes('click')) return 'browser'
    if (n.startsWith('mcp-') || n.startsWith('get_mcp_tools') || n.includes('_mcp_')) return 'mcp'
    if (n.includes('read')) return 'read'
    if (n.includes('glob') || n.includes('grep') || n.includes('search') || n.includes('find')) return 'search'
    if (n.includes('edit') || n.includes('apply')) return 'edit'
    if (n.includes('write') || n.includes('create_file')) return 'write'
    if (n.includes('terminal') || n.includes('command') || n.includes('run_') || n.includes('exec')) return 'command'
    return 'other'
  }
  function safePlain(value, depth) {
    if (value === null || value === undefined) return value
    if (depth > 3) return '[nested]'
    if (typeof value === 'string') return value.slice(0, 8000)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'bigint') return String(value)
    if (Array.isArray(value)) return value.slice(0, 30).map(item => safePlain(item, depth + 1))
    if (typeof value === 'object') {
      const out = {}
      for (const key of Object.getOwnPropertyNames(value).slice(0, 60)) {
        try {
          if (typeof value[key] === 'function') continue
          const lower = key.toLowerCase()
          out[key] = (lower === 'data' || lower.includes('base64') || lower.includes('imagedata'))
            && typeof value[key] === 'string' && value[key].length > 200
            ? '[binary/image payload omitted]'
            : safePlain(value[key], depth + 1)
        } catch (e) {}
      }
      return out
    }
    return String(value).slice(0, 1000)
  }
  function outputText(result) {
    try {
      if (!result) return ''
      if (typeof result === 'string') {
        const text = result.trim()
        if ((text.startsWith('{') || text.startsWith('[')) && text.length < 2000000) {
          try { return outputText(JSON.parse(text)) } catch (e) {}
        }
        return text.length > 12000 && /^[A-Za-z0-9+/=\s]+$/.test(text)
          ? '[binary/image payload omitted]'
          : text.slice(0, 8000)
      }
      if (Array.isArray(result)) {
        return result.slice(0, 30).flatMap(item => {
          if (item?.type === 'image') return ['[image result]']
          const text = outputText(item)
          return text ? [text] : []
        }).join('\\n').slice(0, 8000)
      }
      if (Array.isArray(result.content)) return outputText(result.content)
      for (const key of ['output', 'contents', 'content', 'text', 'stdout', 'result']) {
        if (result[key]) {
          const text = outputText(result[key])
          if (text) return text
        }
      }
      const json = JSON.stringify(safePlain(result, 0), null, 2)
      return json && json !== '{}' ? json.slice(0, 8000) : ''
    } catch (e) { return '' }
  }
  function toolSummary(td, parsedArgs) {
    const candidates = [td?.params, parsedArgs?.args, parsedArgs]
    try {
      const firstToolParams = td?.params?.tools?.[0]?.parameters
      if (typeof firstToolParams === 'string') candidates.unshift(JSON.parse(firstToolParams))
    } catch (e) {}
    for (const value of candidates) {
      const a = value && typeof value === 'object' ? value : {}
      for (const k of ['path','file_path','targetFile','target_file','command','query','pattern','url','filename','name','server']) {
        if (typeof a[k] === 'string' && a[k]) return a[k].slice(0, 160)
      }
    }
    return ''
  }
  function processSnapshot(data) {
    if (!data) return undefined
    const headers = data.fullConversationHeadersOnly || []
    const map = data.conversationMap || {}
    let lastUserIdx = -1
    for (let i = headers.length - 1; i >= 0; i--) {
      if (headers[i] && headers[i].type === 1) { lastUserIdx = i; break }
    }
    const turnBubbles = headers.slice(lastUserIdx + 1)
    const generatingIds = data.generatingBubbleIds
    const generatingBubbleCount = Array.isArray(generatingIds)
      ? generatingIds.length
      : typeof generatingIds?.size === 'number'
        ? generatingIds.size
        : generatingIds && typeof generatingIds === 'object' ? Object.keys(generatingIds).length : 0
    const isGenerating = data.isGenerating === true || generatingBubbleCount > 0
    const items = []
    let todos
    const hasWork = turnBubbles.map(h => {
      const message = map[h && h.bubbleId] || {}
      return !!message.toolFormerData?.name || (typeof message.thinking === 'string' && message.thinking.length > 1)
    })
    const hasLaterWork = new Array(hasWork.length).fill(false)
    let workSeen = false
    for (let i = hasWork.length - 1; i >= 0; i--) {
      hasLaterWork[i] = workSeen
      workSeen = workSeen || hasWork[i]
    }
    for (let i = 0; i < turnBubbles.length; i++) {
      const h = turnBubbles[i]
      const m = map[h && h.bubbleId] || {}
      const td = m.toolFormerData
      const thinking = typeof m.thinking === 'string' ? m.thinking : ''
      if (thinking && thinking.length > 1) {
        items.push({
          kind: 'thinking', id: 'cursor-th:' + h.bubbleId, text: thinking.slice(0, 4000),
          status: (i === turnBubbles.length - 1 && isGenerating && !td?.name) ? 'running' : 'done',
          durationMs: typeof m.thinkingDurationMs === 'number' ? m.thinkingDurationMs : undefined
        })
      }
      // Cursor 原生 assistant-message 只在其后仍有 thinking/tool 时属于过程；
      // 回合最后一段正文由 liveAgentResponse / record_reply 展示，避免重复。
      const messageText = typeof m.text === 'string' ? m.text.trim() : ''
      const laterWork = hasLaterWork[i] || !!td?.name
      if (messageText && laterWork) {
        items.push({
          kind: 'message', id: 'cursor-msg:' + h.bubbleId,
          text: messageText.slice(0, 8000), status: 'done'
        })
      }
      if (td && td.name) {
        let parsedArgs = {}
        try { parsedArgs = JSON.parse(String(td.rawArgs || '{}')) } catch (e) {}
        items.push({
          kind: 'tool', id: 'cursor:' + h.bubbleId,
          toolName: String(td.name).slice(0, 80), toolKind: classifyTool(td.name),
          summary: toolSummary(td, parsedArgs),
          status: td.status === 'completed' || td.status === 'success' ? 'done' : (td.status === 'error' || td.status === 'failed' ? 'failed' : 'running'),
          input: safePlain(td.params || parsedArgs, 0), output: outputText(td.result),
          error: typeof td.error === 'string' ? td.error.slice(0, 4000) : outputText(td.error)
        })
      }
      if (Array.isArray(m.todos) && m.todos.length) {
        todos = m.todos.slice(0, 100).flatMap(t => t && typeof t.content === 'string'
          ? [{ content: t.content.slice(0, 500), status: String(t.status || 'pending').slice(0, 40) }]
          : [])
      }
    }
    return {
      isGenerating,
      process: items.length || todos?.length ? { items: items.slice(-36), todos, generatingBubbleCount } : undefined
    }
  }
  function scheduleProcessSnapshot(composerId) {
    if (!composerId) return
    pendingSnapshots.add(composerId)
    if (snapshotQueued) return
    snapshotQueued = true
    queueMicrotask(() => {
      snapshotQueued = false
      const service = globalThis.__qtComposerService?.composerDataService
      for (const id of pendingSnapshots) {
        try {
          const data = service?.getComposerDataIfLoaded?.(id)
          const snapshot = processSnapshot(data)
          if (snapshot && globalThis.${CURSOR_PROCESS_BINDING_NAME}) {
            globalThis.${CURSOR_PROCESS_BINDING_NAME}(JSON.stringify({ composerId: id, observedAt: Date.now(), ...snapshot }))
          }
        } catch (e) {}
      }
      pendingSnapshots.clear()
    })
  }
  globalThis.__sgTeamProcessSchedule = scheduleProcessSnapshot
  function install() {
    try {
      const svc = globalThis.__qtComposerService
      const manager = svc && svc.composerDataService && svc.composerDataService.composerDataHandleManager
      if (!manager) {
        if (++attempts <= 60) setTimeout(install, 2000)
        return 'no-manager'
      }
      const proto = Object.getPrototypeOf(manager)
      if (globalThis.__sgTeamStreamHook && globalThis.__sgTeamStreamHookManager === manager) {
        if (globalThis.__sgTeamStreamHookVersion === HOOK_VERSION) return 'already'
        // 拾光被强退时 dispose 无机会还原；新版必须主动替换旧 wrapper，不能因
        // boolean 幂等标记永远沿用旧语义（例如旧版“写前通知”）。
        const stale = globalThis.__sgTeamStreamOriginals || {}
        for (const name of Object.keys(stale)) {
          try { proto[name] = stale[name] } catch (e) {}
        }
      }
      const originals = {}
      let installed = 0
      for (const name of ['markDirty', 'markMessageDirty', 'updateWithoutMarkingDirty', 'pushComposer']) {
        const original = proto[name]
        if (typeof original !== 'function') continue
        if (original.__sgTeamStreamWrapped) { installed += 1; continue }
        originals[name] = original
        const wrapped = function (...args) {
          const signalAfterWrite = () => {
            try {
              const first = args[0]
              let composerId = ''
              if (typeof first === 'string') composerId = first
              else if (first && typeof first === 'object') composerId = String(first.composerId ?? first.id ?? '')
              if (composerId) globalThis.${CURSOR_STREAM_BINDING_NAME}(composerId)
              if (composerId) scheduleProcessSnapshot(composerId)
            } catch (e) {}
          }
          const result = original.apply(this, args)
          // 关键顺序：先让 Cursor 完成数据模型写入，再通知拾光读取；旧实现写前通知，
          // inspector 可能读到上一帧，最终状态甚至要等下一次写或轮询才能出现。
          if (result && typeof result.then === 'function') {
            Promise.resolve(result).then(signalAfterWrite, signalAfterWrite)
          } else {
            signalAfterWrite()
          }
          return result
        }
        wrapped.__sgTeamStreamWrapped = true
        proto[name] = wrapped
        installed += 1
      }
      globalThis.__sgTeamStreamOriginals = originals
      globalThis.__sgTeamStreamHookManager = manager
      globalThis.__sgTeamStreamHook = installed > 0
      globalThis.__sgTeamStreamHookVersion = HOOK_VERSION
      // 重连/拾光重启后立即补发当前已加载 Composer，不等待下一次模型写入。
      try {
        const ids = new Set()
        const loaded = svc.composerDataService.getLoadedComposers?.() || []
        for (const item of loaded) ids.add(String(item?.composerId ?? item?.id ?? item ?? ''))
        for (const id of manager.loadedComposers?.ids || []) ids.add(String(id || ''))
        const handles = manager.composerDataHandles || manager.handles
        if (handles && typeof handles.keys === 'function') for (const id of handles.keys()) ids.add(String(id || ''))
        for (const id of ids) if (id) scheduleProcessSnapshot(id)
      } catch (e) {}
      return installed
    } catch (e) {
      if (++attempts <= 60) setTimeout(install, 2000)
      return 'error'
    }
  }
  return install()
})()`

/** 还原页面内 hook：恢复原型原始方法并清除全局标志（dispose 时尽力执行）。 */
const STREAM_HOOK_RESTORE_EXPRESSION = `(() => {
  const originals = globalThis.__sgTeamStreamOriginals
  if (originals) {
    try {
      const svc = globalThis.__qtComposerService
      const manager = svc && svc.composerDataService && svc.composerDataService.composerDataHandleManager
      const proto = manager && Object.getPrototypeOf(manager)
      if (proto) {
        for (const name of Object.keys(originals)) {
          try { proto[name] = originals[name] } catch (e) {}
        }
      }
    } catch (e) {}
  }
  delete globalThis.__sgTeamStreamOriginals
  delete globalThis.__sgTeamStreamHookManager
  delete globalThis.__sgTeamStreamHook
  delete globalThis.__sgTeamStreamHookVersion
  delete globalThis.__sgTeamProcessSchedule
  return 'restored'
})()`

/** 测试可注入的最小 socket 面（对齐 ws 事件子集）。 */
export interface StreamObserverSocket {
  send(text: string): void
  close(): void
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: unknown) => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

export interface CursorStreamObserverOptions {
  port?: number
  fetchPageSocketUrl?: (port: number, timeoutMs: number) => Promise<string | undefined>
  openSocket?: (webSocketDebuggerUrl: string) => StreamObserverSocket
  /** 写信号回调：Cursor 每次模型写入（含持久化批次）即触发。 */
  onWriteSignal?: (composerId: string, at: number) => void
  /** 用量事件回调：bundle 补丁在每个回合 turnEnded 推送真实计费 token。 */
  onUsageEvent?: (event: CursorUsageEvent) => void
  /** Cursor 内存模型写后直接推送的原生顺序过程快照。 */
  onProcessEvent?: (event: CursorNativeProcessEvent) => void
}

export interface CursorNativeProcessEvent {
  composerId: string
  observedAt: number
  isGenerating: boolean
  process?: CursorProcessStream
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class CursorStreamObserver {
  private readonly port: number
  private readonly fetchPageSocketUrl: NonNullable<CursorStreamObserverOptions['fetchPageSocketUrl']>
  private readonly openSocket: NonNullable<CursorStreamObserverOptions['openSocket']>
  private readonly onWriteSignal: NonNullable<CursorStreamObserverOptions['onWriteSignal']>
  private readonly onUsageEvent: NonNullable<CursorStreamObserverOptions['onUsageEvent']>
  private readonly onProcessEvent: NonNullable<CursorStreamObserverOptions['onProcessEvent']>
  private socket?: StreamObserverSocket
  private seq = 0
  private readonly pending = new Map<number, PendingCall>()
  private stopped = false
  private retryAttempts = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private attaching = false
  /** 已注册的 new-document 脚本标识：重连前移除旧的，防止 target 上脚本累积。 */
  private newDocumentScriptId?: string

  constructor(options: CursorStreamObserverOptions = {}) {
    const envPort = Number(process.env.QINGTIAN_CURSOR_CDP_PORT)
    this.port = options.port
      ?? (Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : 9333)
    this.fetchPageSocketUrl = options.fetchPageSocketUrl ?? defaultFetchPageSocketUrl
    this.openSocket = options.openSocket ?? defaultOpenSocket
    this.onWriteSignal = options.onWriteSignal ?? (() => {})
    this.onUsageEvent = options.onUsageEvent ?? (() => {})
    this.onProcessEvent = options.onProcessEvent ?? (() => {})
  }

  get connected(): boolean {
    return this.socket !== undefined
  }

  /** 幂等附加：解析 workbench 窗口 → 持久连接 → binding + hook 注入。失败退避重试。 */
  async attach(): Promise<boolean> {
    if (this.stopped || this.socket || this.attaching) return this.socket !== undefined
    this.attaching = true
    try {
      const webSocketDebuggerUrl = await this.fetchPageSocketUrl(this.port, ATTACH_TIMEOUT_MS)
      if (this.stopped) return false
      if (!webSocketDebuggerUrl) throw new Error('未找到 Cursor workbench 窗口')
      const socket = this.openSocket(webSocketDebuggerUrl)
      this.socket = socket
      this.retryAttempts = 0
      socket.on('message', (data) => this.handleMessage(data))
      socket.on('close', () => this.handleDisconnect())
      socket.on('error', () => undefined)
      // 等待连接建立：ws 在 open 前 send 会抛错；握手失败（error）立即失败而非等满超时
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('observer socket 未在时限内建立')), ATTACH_TIMEOUT_MS)
        socket.on('open', () => { clearTimeout(timer); resolve(undefined) })
        socket.on('error', () => { clearTimeout(timer); reject(new Error('observer socket 连接失败')) })
      })
      if (this.stopped) throw new Error('observer disposed during attach')
      await this.call('Runtime.enable', {})
      await this.call('Runtime.addBinding', { name: CURSOR_STREAM_BINDING_NAME })
      await this.call('Runtime.addBinding', { name: CURSOR_USAGE_BINDING_NAME })
      await this.call('Runtime.addBinding', { name: CURSOR_PROCESS_BINDING_NAME })
      // 上一次连接注册的 new-document 脚本在 target 上持久存在——先移除再注册，
      // 防止重连累积（脚本幂等但重复注册浪费且语义模糊）。
      if (this.newDocumentScriptId) {
        try {
          await this.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.newDocumentScriptId })
        } catch { /* 尽力而为 */ }
        this.newDocumentScriptId = undefined
      }
      const added = await this.call('Page.addScriptToEvaluateOnNewDocument', { source: CURSOR_STREAM_HOOK_EXPRESSION })
      const identifier = (added as { identifier?: unknown } | undefined)?.identifier
      this.newDocumentScriptId = typeof identifier === 'string' && identifier ? identifier : undefined
      // 已加载文档立即安装；后续导航经 addScriptToEvaluateOnNewDocument 重装
      //（binding 由 CDP 自动注入后续 executionContext）。
      await this.call('Runtime.evaluate', { expression: CURSOR_STREAM_HOOK_EXPRESSION, returnByValue: true })
      return true
    } catch {
      // 半途失败必须关闭已建立的 socket，否则泄漏连接且 retry 另建新连接。
      const socket = this.socket
      this.socket = undefined
      try { socket?.close() } catch { /* 尽力而为 */ }
      this.scheduleRetry()
      return false
    } finally {
      this.attaching = false
    }
  }

  dispose(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const socket = this.socket
    this.socket = undefined
    for (const pending of this.pending.values()) pending.reject(new Error('observer disposed'))
    this.pending.clear()
    // 离场不留痕（尽力而为，fire-and-forget）：还原页面内原型包装 + 移除注入脚本。
    // 不还原的话，退出后 Cursor 每次模型写入都会调用死 binding，直到窗口重载。
    if (socket) {
      try {
        socket.send(JSON.stringify({
          id: ++this.seq,
          method: 'Runtime.evaluate',
          params: { expression: STREAM_HOOK_RESTORE_EXPRESSION, returnByValue: true }
        }))
      } catch { /* 尽力而为 */ }
      if (this.newDocumentScriptId) {
        try {
          socket.send(JSON.stringify({
            id: ++this.seq,
            method: 'Page.removeScriptToEvaluateOnNewDocument',
            params: { identifier: this.newDocumentScriptId }
          }))
        } catch { /* 尽力而为 */ }
      }
    }
    this.newDocumentScriptId = undefined
    try { socket?.close() } catch { /* 尽力而为 */ }
  }

  private handleMessage(data: unknown): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(String(data)) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.bindingCalled') {
      const params = message.params as { name?: unknown; payload?: unknown } | undefined
      if (params?.name === CURSOR_STREAM_BINDING_NAME && typeof params.payload === 'string' && params.payload) {
        this.onWriteSignal(params.payload.slice(0, 120), Date.now())
      }
      if (params?.name === CURSOR_PROCESS_BINDING_NAME && typeof params.payload === 'string' && params.payload) {
        try {
          const raw = JSON.parse(params.payload) as Record<string, unknown>
          const composerId = typeof raw.composerId === 'string' ? raw.composerId.trim().slice(0, 120) : ''
          if (composerId) {
            this.onProcessEvent({
              composerId,
              observedAt: typeof raw.observedAt === 'number' ? raw.observedAt : Date.now(),
              isGenerating: raw.isGenerating === true,
              process: parseProcessStream(raw.process)
            })
          }
        } catch {
          // 单个坏帧不影响后续原生过程事件。
        }
      }
      if (params?.name === CURSOR_USAGE_BINDING_NAME && typeof params.payload === 'string' && params.payload) {
        this.dispatchUsagePayload(params.payload)
      }
    }
  }

  /** 解析 bundle 补丁推送的 {c,i,o,r,w,t} JSON 并转发；坏载荷静默丢弃。 */
  private dispatchUsagePayload(payload: string): void {
    try {
      const raw = JSON.parse(payload) as Record<string, unknown>
      const composerId = typeof raw.c === 'string' ? raw.c.trim() : ''
      if (!composerId) return
      const toCount = (value: unknown): number => {
        const num = Number(value ?? 0)
        return Number.isFinite(num) && num > 0 ? num : 0
      }
      this.onUsageEvent({
        composerId,
        inputTokens: toCount(raw.i),
        outputTokens: toCount(raw.o),
        cacheReadTokens: toCount(raw.r),
        cacheWriteTokens: toCount(raw.w),
        occurredAt: toCount(raw.t) || Date.now()
      })
    } catch {
      // 非法 JSON / 结构漂移：丢弃，不影响写信号通道
    }
  }

  private handleDisconnect(): void {
    if (this.socket) this.socket = undefined
    for (const pending of this.pending.values()) pending.reject(new Error('observer disconnected'))
    this.pending.clear()
    if (!this.stopped) this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retryAttempts, RETRY_MAX_MS)
    this.retryAttempts += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.attach()
    }, delay)
    this.retryTimer.unref?.()
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('observer not attached'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`observer call timeout: ${method}`))
      }, ATTACH_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

async function defaultFetchPageSocketUrl(port: number, timeoutMs: number): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal })
    if (!response.ok) return undefined
    const targets = await response.json() as Array<Record<string, unknown>>
    const page = targets.find((target) => (
      target.type === 'page'
      && typeof target.webSocketDebuggerUrl === 'string'
      && target.webSocketDebuggerUrl.startsWith('ws')
      && typeof target.url === 'string'
      && /workbench/i.test(target.url)
    ))
    return page ? page.webSocketDebuggerUrl as string : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function defaultOpenSocket(webSocketDebuggerUrl: string): StreamObserverSocket {
  const socket = new WebSocket(webSocketDebuggerUrl, {
    handshakeTimeout: 5_000,
    maxPayload: 4 * 1024 * 1024
  })
  return {
    send: (text) => socket.send(text),
    close: () => socket.close(),
    // ws 的 on 签名兼容（多事件重载按需绑定）
    on: (event, listener) => {
      if (event === 'open') socket.on('open', listener as () => void)
      else if (event === 'message') socket.on('message', listener as (data: unknown) => void)
      else if (event === 'close') socket.on('close', listener as () => void)
      else socket.on('error', listener as (error: Error) => void)
    }
  }
}
