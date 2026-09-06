import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import {
  CURSOR_STREAM_HOOK_EXPRESSION,
  CURSOR_STREAM_HOOK_PROBE_EXPRESSION,
  CURSOR_STREAM_HOOK_VERSION,
  CursorStreamObserver,
  type CursorNativeProcessEvent,
  type StreamObserverSocket
} from '../src/infrastructure/cursor/cursor-stream-observer'
import { CHANNEL_USER_DELIVERY_MARKER } from '../src/domain/channel-delivery-policy'

interface SentCall {
  id: number
  method: string
  params: Record<string, unknown>
}

class FakeSocket implements StreamObserverSocket {
  readonly sent: SentCall[] = []
  closed = false
  /** 模拟页面文档里的 hook：install 表达式一执行即就位；测试把它清零模拟文档重载/被清除。 */
  hookAlive = false
  /** 模拟 Cursor 工作台尚未暴露 composer 服务：install 只挂上自轮询链（'no-manager'），hook 不就位。 */
  installPending = false
  /** 自定义 evaluate 应答（返回 undefined 走默认模型）。 */
  evaluateResponder?: (expression: string) => { value?: unknown; exceptionDetails?: Record<string, unknown> } | undefined
  private listeners = new Map<string, Array<(arg: unknown) => void>>()

  send(text: string): void {
    const call = JSON.parse(text) as SentCall
    this.sent.push(call)
    // CDP 调用自动应答（Runtime.enable / addBinding 等无需真实结果）
    const result = call.method === 'Page.addScriptToEvaluateOnNewDocument'
      ? { identifier: `script-${call.id}` }
      : call.method === 'Runtime.evaluate'
        ? this.evaluateResult(String(call.params.expression))
        : {}
    queueMicrotask(() => this.emit('message', JSON.stringify({ id: call.id, result })))
  }

  /** 按表达式模拟页面 V8 的 Runtime.evaluate 结果（含页面脚本异常形态）。 */
  private evaluateResult(expression: string): Record<string, unknown> {
    const custom = this.evaluateResponder?.(expression)
    if (custom?.exceptionDetails) return { result: { type: 'object', subtype: 'error' }, exceptionDetails: custom.exceptionDetails }
    if (custom) return { result: { type: typeof custom.value, value: custom.value } }
    if (expression === CURSOR_STREAM_HOOK_PROBE_EXPRESSION) {
      return { result: { type: 'object', value: {
        hook: this.hookAlive,
        version: this.hookAlive ? CURSOR_STREAM_HOOK_VERSION : undefined,
        scheduler: this.hookAlive || this.installPending ? 'function' : 'undefined'
      } } }
    }
    if (expression === CURSOR_STREAM_HOOK_EXPRESSION) {
      if (this.installPending) return { result: { type: 'string', value: 'no-manager' } }
      this.hookAlive = true
      return { result: { type: 'number', value: 4 } }
    }
    return { result: { type: 'string', value: 'restored' } }
  }

  installCalls(): SentCall[] {
    return this.sent.filter((call) => call.method === 'Runtime.evaluate' && call.params.expression === CURSOR_STREAM_HOOK_EXPRESSION)
  }
  close(): void { this.closed = true }
  on(event: never, listener: never): void
  on(event: string, listener: (arg: unknown) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    // 模拟真实 ws：注册 open 监听即视为连接就绪
    if (event === 'open') queueMicrotask(() => listener(undefined))
  }
  emit(event: 'message' | 'close' | 'error', arg: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg)
  }
  findCall(method: string): SentCall | undefined {
    return this.sent.find((call) => call.method === method)
  }
}

function buildObserver(overrides: {
  onWriteSignal?: (composerId: string, at: number) => void
  onProcessEvent?: (event: CursorNativeProcessEvent) => void
  onStatus?: (status: { state: 'connected' | 'reconnecting' | 'unavailable'; detail: string; updatedAt: number }) => void
} = {}) {
  const socket = new FakeSocket()
  const observer = new CursorStreamObserver({
    fetchPageSocketUrl: async () => 'ws://127.0.0.1:9333/devtools/page/abc',
    openSocket: () => socket,
    onWriteSignal: overrides.onWriteSignal ?? (() => {}),
    onProcessEvent: overrides.onProcessEvent,
    onStatus: overrides.onStatus
  })
  return { socket, observer }
}

describe('CursorStreamObserver', () => {
  it('reports connected, reconnecting and unavailable process-stream health', async () => {
    const states: string[] = []
    const { socket, observer } = buildObserver({ onStatus: (status) => states.push(status.state) })
    expect(await observer.attach()).toBe(true)
    socket.emit('close', undefined)
    observer.dispose()
    expect(states).toEqual(['connected', 'reconnecting', 'unavailable'])
  })

  it('emits write signals after Cursor model mutation, never one frame before', async () => {
    class Manager {
      value = 0
      markDirty(input: { composerId: string }): number {
        this.value += 1
        return this.value
      }
      async updateWithoutMarkingDirty(input: { composerId: string }): Promise<number> {
        await Promise.resolve()
        this.value += 10
        return this.value
      }
    }
    const manager = new Manager()
    const observed: number[] = []
    const context = {
      Promise,
      queueMicrotask,
      setTimeout,
      globalThis: {
        __qtComposerService: { composerDataService: { composerDataHandleManager: manager } },
        sgTeamStream: () => observed.push(manager.value)
      }
    }
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    expect((context.globalThis as Record<string, unknown>).__sgTeamStreamHookVersion).toBe(CURSOR_STREAM_HOOK_VERSION)
    expect(manager.markDirty({ composerId: 'composer-1' })).toBe(1)
    expect(observed).toEqual([1])
    await manager.updateWithoutMarkingDirty({ composerId: 'composer-1' })
    await Promise.resolve()
    expect(observed).toEqual([1, 11])
  })

  it('extracts loaded Composer browser operations as native browser steps on install', async () => {
    class Manager {
      loadedComposers = { ids: ['composer-browser'] }
      markDirty(): void {}
    }
    const manager = new Manager()
    const frames: Array<Record<string, unknown>> = []
    const context = {
      Promise,
      queueMicrotask,
      setTimeout,
      globalThis: {
        __qtComposerService: {
          composerDataService: {
            composerDataHandleManager: manager,
            getComposerDataIfLoaded: () => ({
              fullConversationHeadersOnly: [
                { type: 1, bubbleId: 'user-1' },
                { type: 2, bubbleId: 'message-1' },
                { type: 2, bubbleId: 'tool-1' }
              ],
              conversationMap: {
                'message-1': { text: '先打开页面检查当前状态。', createdAt: '2026-09-02T09:55:48.694Z' },
                'tool-1': {
                  createdAt: '2026-09-02T09:55:48.702Z',
                  toolFormerData: {
                    name: 'mcp-cursor-ide-browser-browser_navigate',
                    status: 'completed',
                    rawArgs: '{"args":{"url":"http://localhost"}}',
                    params: { tools: [{ parameters: '{"url":"http://localhost"}' }] },
                    result: { content: [{ type: 'text', text: 'Page loaded' }, { type: 'image', data: 'AAAA' }] }
                  }
                }
              },
              generatingBubbleIds: [],
              modelConfig: { modelName: 'claude-sonnet-4-5' }
            })
          }
        },
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
      }
    }
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    await Promise.resolve()
    const process = frames[0]?.process as { items?: Array<Record<string, unknown>> } | undefined
    expect(process?.items?.map((item) => item.kind)).toEqual(['message', 'tool'])
    expect(process?.items?.[0]).toMatchObject({
      kind: 'message', text: '先打开页面检查当前状态。', startedAt: Date.parse('2026-09-02T09:55:48.694Z')
    })
    expect(process?.items?.[1]).toMatchObject({
      kind: 'tool', toolKind: 'browser', summary: 'http://localhost', status: 'done', output: 'Page loaded\n[image result]',
      startedAt: Date.parse('2026-09-02T09:55:48.702Z')
    })
  })

  it('extracts current Cursor thinking objects and discriminated toolCall payloads', async () => {
    class Manager {
      loadedComposers = { ids: ['composer-modern'] }
      markDirty(): void {}
    }
    const manager = new Manager()
    const frames: Array<Record<string, any>> = []
    const context = {
      Promise,
      queueMicrotask,
      setTimeout,
      globalThis: {
        __qtComposerService: {
          composerDataService: {
            composerDataHandleManager: manager,
            getComposerDataIfLoaded: () => ({
              fullConversationHeadersOnly: [
                { type: 1, bubbleId: 'user-modern' },
                { type: 2, bubbleId: 'thinking-modern' },
                { type: 2, bubbleId: 'tool-modern' }
              ],
              conversationMap: {
                'thinking-modern': { thinking: { text: '按当前 Cursor 对象结构思考' }, thinkingDurationMs: 1_800 },
                'tool-modern': {
                  toolFormerData: {
                    tool: 9,
                    toolCall: { tool: { case: 'shellToolCall', value: {
                      args: { command: 'echo MODERN_OK' },
                      result: { result: { case: 'success', value: { stdout: 'MODERN_OK' } } }
                    } } }
                  }
                }
              },
              todos: [{ content: '核对现代结构', status: 'completed' }],
              generatingBubbleIds: []
            })
          }
        },
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload))
      }
    }
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    await Promise.resolve()
    expect(frames[0]?.process).toMatchObject({
      turnId: 'user-modern',
      items: [
        { kind: 'thinking', text: '按当前 Cursor 对象结构思考', durationMs: 1_800 },
        { kind: 'tool', toolName: 'shellToolCall', toolKind: 'command', summary: 'echo MODERN_OK', status: 'done' }
      ],
      todos: [{ content: '核对现代结构', status: 'completed' }]
    })
  })

  it('clips oversized native process frames to protect the observer socket', async () => {
    class Manager {
      loadedComposers = { ids: ['composer-huge'] }
      markDirty(): void {}
    }
    const manager = new Manager()
    const frames: Array<Record<string, any>> = []
    // 110 个 thinking 块 × 10K 文本 ≈ 1.1M 字符 > 900K 粗判门；
    // vm 上下文无 TextEncoder → 走 length×3 字节估算 → 3.3MB > 3MB 触发裁剪。
    const bigText = 'x'.repeat(10_000)
    const bubbles = Array.from({ length: 110 }, (_, index) => `b-${index}`)
    const context = {
      Promise,
      queueMicrotask,
      setTimeout,
      globalThis: {
        __qtComposerService: {
          composerDataService: {
            composerDataHandleManager: manager,
            getComposerDataIfLoaded: () => ({
              fullConversationHeadersOnly: [
                { type: 1, bubbleId: 'user-huge' },
                ...bubbles.map((bubbleId) => ({ type: 2, bubbleId }))
              ],
              conversationMap: Object.fromEntries(bubbles.map((bubbleId) => [
                bubbleId, { thinking: bigText }
              ])),
              generatingBubbleIds: []
            })
          }
        },
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload))
      }
    }
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    await Promise.resolve()
    const frame = frames[0]
    expect(frame?.process?.items.length).toBeLessThan(110)
    expect(frame?.process?.items.length).toBeGreaterThan(8)
    expect(frame?.process?.truncatedItemCount).toBeGreaterThan(0)
    expect(JSON.stringify(frame).length).toBeLessThan(1_100_000)
  })

  it('attaches: binding + new-document hook + immediate install', async () => {
    const { socket, observer } = buildObserver()
    const attached = await observer.attach()
    expect(attached).toBe(true)
    expect(observer.connected).toBe(true)
    expect(socket.findCall('Runtime.enable')).toBeDefined()
    const bindings = socket.sent.filter((call) => call.method === 'Runtime.addBinding')
    expect(bindings.map((call) => call.params.name)).toEqual(['sgTeamStream', '__sgTeamUsage', 'sgTeamProcess'])
    const newDocument = socket.findCall('Page.addScriptToEvaluateOnNewDocument')
    expect(typeof newDocument?.params.source).toBe('string')
    expect(String(newDocument?.params.source)).toContain('composerDataHandleManager')
    // 幂等双保险 + 可还原：wrapped 标记 / manager 身份 / originals 存档
    expect(String(newDocument?.params.source)).toContain('__sgTeamStreamWrapped')
    expect(String(newDocument?.params.source)).toContain('__sgTeamStreamHookManager')
    expect(String(newDocument?.params.source)).toContain('__sgTeamStreamOriginals')
    expect(String(newDocument?.params.source)).toContain('__sgTeamStreamHookVersion')
    const evaluate = socket.findCall('Runtime.evaluate')
    expect(typeof evaluate?.params.expression).toBe('string')
    observer.dispose()
  })

  it('enables the Page domain before registering the new-document hook and verifies the install with a read-only probe', async () => {
    const states: Array<{ state: string; detail: string }> = []
    const { socket, observer } = buildObserver({ onStatus: (status) => states.push({ state: status.state, detail: status.detail }) })
    await observer.attach()
    const methods = socket.sent.map((call) => call.method)
    // Page 域不启用时 addScriptToEvaluateOnNewDocument 只登记不执行：顺序必须是 enable → add
    expect(methods).toContain('Page.enable')
    expect(methods.indexOf('Page.enable')).toBeLessThan(methods.indexOf('Page.addScriptToEvaluateOnNewDocument'))
    expect(methods.indexOf('Page.enable')).toBeGreaterThan(methods.lastIndexOf('Runtime.addBinding'))
    // 安装（1 次）之后紧跟一次只读探针；connected 只在探针确认 hook 就位后才上报
    expect(socket.installCalls()).toHaveLength(1)
    const probes = socket.sent.filter((call) => call.method === 'Runtime.evaluate' && call.params.expression === CURSOR_STREAM_HOOK_PROBE_EXPRESSION)
    expect(probes).toHaveLength(1)
    expect(socket.sent.indexOf(probes[0]!)).toBeGreaterThan(socket.sent.indexOf(socket.installCalls()[0]!))
    expect(states).toEqual([{ state: 'connected', detail: 'Cursor 原生过程流已连接' }])
    observer.dispose()
  })

  it('reinstalls the hook after an in-place page reload and only reports connected again once verified (2026-09-05 事故)', async () => {
    vi.useFakeTimers()
    try {
      const states: Array<{ state: string; detail: string }> = []
      const { socket, observer } = buildObserver({ onStatus: (status) => states.push({ state: status.state, detail: status.detail }) })
      await observer.attach()
      expect(states.at(-1)?.state).toBe('connected')
      const installsBefore = socket.installCalls().length

      // Cursor 窗口原地重载（Reload Window / 同窗口切换文件夹）：target 与 socket 不变，
      // 文档换新——hook 随旧文档消失，binding 由 Runtime 域自动注入新文档。
      socket.hookAlive = false
      socket.emit('message', JSON.stringify({ method: 'Runtime.executionContextsCleared', params: {} }))
      expect(states.at(-1)).toEqual({ state: 'reconnecting', detail: 'Cursor 工作台已重载，正在重新安装过程 hook' })
      expect(observer.connected).toBe(true)

      // 隔离世界的上下文不触发重装；主世界上下文就位后合并一次重装
      socket.emit('message', JSON.stringify({
        method: 'Runtime.executionContextCreated',
        params: { context: { id: 8, origin: '', name: '', auxData: { isDefault: false, type: 'isolated' } } }
      }))
      socket.emit('message', JSON.stringify({
        method: 'Runtime.executionContextCreated',
        params: { context: { id: 9, origin: '', name: '', auxData: { isDefault: true, type: 'default' } } }
      }))
      socket.emit('message', JSON.stringify({
        method: 'Runtime.executionContextCreated',
        params: { context: { id: 10, origin: '', name: '', auxData: { isDefault: true, type: 'default' } } }
      }))
      expect(socket.installCalls()).toHaveLength(installsBefore)
      await vi.advanceTimersByTimeAsync(400)
      expect(socket.installCalls()).toHaveLength(installsBefore + 1)
      expect(socket.hookAlive).toBe(true)
      expect(states.at(-1)).toEqual({ state: 'connected', detail: 'Cursor 原生过程流已连接' })
      // 已验证就位后，后续 iframe 上下文创建不再触发重装
      socket.emit('message', JSON.stringify({
        method: 'Runtime.executionContextCreated',
        params: { context: { id: 11, origin: '', name: '', auxData: { isDefault: true, type: 'default' } } }
      }))
      await vi.advanceTimersByTimeAsync(400)
      expect(socket.installCalls()).toHaveLength(installsBefore + 1)
      observer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a page-script exception during hook install as an attach failure instead of a false connected', async () => {
    vi.useFakeTimers()
    try {
      const states: Array<{ state: string; detail: string }> = []
      const { socket, observer } = buildObserver({ onStatus: (status) => states.push({ state: status.state, detail: status.detail }) })
      socket.evaluateResponder = (expression) => expression === CURSOR_STREAM_HOOK_EXPRESSION
        ? { exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: boom is not defined' } } }
        : undefined
      const attached = await observer.attach()
      expect(attached).toBe(false)
      expect(observer.connected).toBe(false)
      expect(socket.closed).toBe(true)
      expect(states).toHaveLength(1)
      expect(states[0]!.state).toBe('reconnecting')
      expect(states[0]!.detail).toContain('ReferenceError: boom is not defined')
      observer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('health check reinstalls a hook that disappeared without any event, and never repeats identical status', async () => {
    vi.useFakeTimers()
    try {
      const states: Array<{ state: string; detail: string }> = []
      const { socket, observer } = buildObserver({ onStatus: (status) => states.push({ state: status.state, detail: status.detail }) })
      await observer.attach()
      const installsBefore = socket.installCalls().length
      const probesBefore = socket.sent.filter((call) => call.params.expression === CURSOR_STREAM_HOOK_PROBE_EXPRESSION).length

      // hook 健在：自检只探针、不重装、不重复上报 connected
      await vi.advanceTimersByTimeAsync(20_500)
      expect(socket.installCalls()).toHaveLength(installsBefore)
      expect(socket.sent.filter((call) => call.params.expression === CURSOR_STREAM_HOOK_PROBE_EXPRESSION).length).toBe(probesBefore + 1)
      expect(states.filter((status) => status.state === 'connected')).toHaveLength(1)

      // 未知路径把 hook 清掉且没有任何 CDP 事件：下一拍自检发现缺席并重装
      socket.hookAlive = false
      await vi.advanceTimersByTimeAsync(20_500)
      expect(socket.installCalls()).toHaveLength(installsBefore + 1)
      expect(socket.hookAlive).toBe(true)
      expect(states.at(-1)?.state).toBe('connected')

      // dispose 后自检停止
      observer.dispose()
      const sentAfterDispose = socket.sent.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(socket.sent.length).toBe(sentAfterDispose)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports reconnecting while the workbench composer service is not ready, then connected once the in-page install chain lands', async () => {
    vi.useFakeTimers()
    try {
      const states: Array<{ state: string; detail: string }> = []
      const { socket, observer } = buildObserver({ onStatus: (status) => states.push({ state: status.state, detail: status.detail }) })
      socket.installPending = true
      expect(await observer.attach()).toBe(true)
      expect(observer.connected).toBe(true)
      expect(states.at(-1)).toEqual({ state: 'reconnecting', detail: '等待 Cursor 工作台就绪后安装过程 hook' })

      // 页面内 2s 自轮询链等到 manager 后自行装上（不经拾光再注入）
      socket.installPending = false
      socket.hookAlive = true
      await vi.advanceTimersByTimeAsync(20_500)
      expect(states.at(-1)).toEqual({ state: 'connected', detail: 'Cursor 原生过程流已连接' })
      observer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispatches bindingCalled payloads as write signals', async () => {
    const signals: Array<{ composerId: string }> = []
    const { socket, observer } = buildObserver({
      onWriteSignal: (composerId) => signals.push({ composerId })
    })
    await observer.attach()
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: 'sgTeamStream', payload: 'composer-abc-123' }
    }))
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: 'otherBinding', payload: 'ignored' }
    }))
    expect(signals).toEqual([{ composerId: 'composer-abc-123' }])
    observer.dispose()
  })

  it('dispatches ordered Cursor-native process frames with outputs and todos', async () => {
    const events: CursorNativeProcessEvent[] = []
    const { socket, observer } = buildObserver({ onProcessEvent: (event) => events.push(event) })
    await observer.attach()
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: {
        name: 'sgTeamProcess',
        payload: JSON.stringify({
          composerId: 'composer-native', observedAt: 1234, isGenerating: true,
          process: {
            turnId: 'user-turn-1',
            items: [
              { kind: 'thinking', id: 'th-1', text: '先分析', status: 'done', durationMs: 2500 },
              { kind: 'tool', id: 'tool-1', toolName: 'run_terminal_cmd', toolKind: 'command', summary: 'npm test', status: 'done', output: '42 passed' }
            ],
            todos: [{ content: '验证结果', status: 'in_progress' }],
            generatingBubbleCount: 1
          }
        })
      }
    }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ composerId: 'composer-native', observedAt: 1234, isGenerating: true })
    expect(events[0]?.process?.turnId).toBe('user-turn-1')
    expect(events[0]?.process?.items.map((item) => item.id)).toEqual(['th-1', 'tool-1'])
    expect(events[0]?.process?.items[1]).toMatchObject({ output: '42 passed', toolKind: 'command' })
    expect(events[0]?.process?.todos).toEqual([{ content: '验证结果', status: 'in_progress' }])
    observer.dispose()
  })

  it('dispatches the streaming final answer carried by write-after snapshots (阶段 G 数据层)', async () => {
    const events: CursorNativeProcessEvent[] = []
    const { socket, observer } = buildObserver({ onProcessEvent: (event) => events.push(event) })
    await observer.attach()
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: {
        name: 'sgTeamProcess',
        payload: JSON.stringify({
          composerId: 'composer-native', observedAt: 1300, isGenerating: true,
          response: { id: 'bubble-final', text: '正在逐字生成的正文', generating: true },
          process: { turnId: 'user-turn-1', items: [], generatingBubbleCount: 1, snapshotComplete: true }
        })
      }
    }))
    // 非法正文载荷（缺 id / 缺 text）静默忽略，不影响过程帧本身。
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: {
        name: 'sgTeamProcess',
        payload: JSON.stringify({
          composerId: 'composer-native', observedAt: 1400, isGenerating: false,
          response: { text: '没有 id' },
          process: { turnId: 'user-turn-1', items: [], generatingBubbleCount: 0, snapshotComplete: true }
        })
      }
    }))
    expect(events).toHaveLength(2)
    expect(events[0]?.response).toEqual({ id: 'bubble-final', text: '正在逐字生成的正文' })
    expect(events[1]?.response).toBeUndefined()
    expect(events[1]?.process).toMatchObject({ turnId: 'user-turn-1', snapshotComplete: true })
    observer.dispose()
  })

  it('keeps an authoritative empty snapshot as an explicit process event (RC-3)', async () => {
    // 页面侧快照过滤掉全部内部协议工具后仍是完整帧：snapshotComplete 标记
    // 权威空集，服务层据此撤下旧占位块；不得坍缩成 process: undefined。
    const events: CursorNativeProcessEvent[] = []
    const { socket, observer } = buildObserver({ onProcessEvent: (event) => events.push(event) })
    await observer.attach()
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: {
        name: 'sgTeamProcess',
        payload: JSON.stringify({
          composerId: 'composer-empty', observedAt: 2345, isGenerating: true,
          process: {
            turnId: 'user-turn-quiet',
            items: [
              { kind: 'tool', id: 'cursor:poll', toolName: 'mcp-SG Team-check_messages', toolKind: 'mcp', summary: '', status: 'done' }
            ],
            generatingBubbleCount: 1,
            snapshotComplete: true
          }
        })
      }
    }))
    expect(events).toHaveLength(1)
    expect(events[0]?.process).toMatchObject({ turnId: 'user-turn-quiet', items: [], snapshotComplete: true })
    observer.dispose()
  })

  it('ignores unknown pages, garbage messages and empty payloads', async () => {
    const signals: string[] = []
    const { socket, observer } = buildObserver({
      onWriteSignal: (composerId) => signals.push(composerId)
    })
    await observer.attach()
    socket.emit('message', 'not json')
    socket.emit('message', JSON.stringify({ method: 'Runtime.bindingCalled', params: {} }))
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: 'sgTeamStream', payload: '' }
    }))
    socket.emit('message', JSON.stringify({ method: 'something.else' }))
    expect(signals).toEqual([])
    observer.dispose()
  })

  it('解析 usage binding 载荷并转发结构化事件；坏载荷静默丢弃', async () => {
    const events: Array<Record<string, unknown>> = []
    const samples: Array<Record<string, unknown>> = []
    const socket = new FakeSocket()
    const observer = new CursorStreamObserver({
      fetchPageSocketUrl: async () => 'ws://127.0.0.1:9333/devtools/page/abc',
      openSocket: () => socket,
      onWriteSignal: () => {},
      onUsageEvent: (event) => events.push({ ...event }),
      onUsageSample: (sample) => samples.push({ ...sample })
    })
    await observer.attach()

    socket.emit('message', JSON.stringify({ method: 'Runtime.bindingCalled', params: {
      name: '__sgTeamUsage', payload: JSON.stringify({ kind: 'sample', c: 'comp-1', g: 'generation-1', m: 'gpt-5', used: 12000, t: 1000 })
    } }))
    expect(samples).toEqual([{ composerId: 'comp-1', generationId: 'generation-1', modelId: 'gpt-5', used: 12000, occurredAt: 1000 }])

    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: '__sgTeamUsage', payload: '{"c":"comp-1","i":12168,"o":42,"r":3968,"w":0,"t":1788021941352}' }
    }))
    // 非法值丢弃，不把损坏的事件变成一次零值结算。
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: '__sgTeamUsage', payload: '{"c":"comp-2","i":"bad","o":-5}' }
    }))
    // 坏 JSON / 空 composerId 丢弃
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: '__sgTeamUsage', payload: 'not-json' }
    }))
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: '__sgTeamUsage', payload: '{"c":"","i":10}' }
    }))

    expect(events).toEqual([
      { composerId: 'comp-1', inputTokens: 12168, outputTokens: 42, cacheReadTokens: 3968, cacheWriteTokens: 0, occurredAt: 1788021941352 }
    ])
    observer.dispose()
  })

  it('reattaches after socket close and removes the stale new-document script', async () => {
    vi.useFakeTimers()
    try {
      const sockets: FakeSocket[] = []
      const observer = new CursorStreamObserver({
        fetchPageSocketUrl: async () => 'ws://127.0.0.1:9333/devtools/page/abc',
        openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
        onWriteSignal: () => {}
      })
      await observer.attach()
      const first = sockets[0]!
      expect(observer.connected).toBe(true)
      const firstAdd = first.sent.filter((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument')
      expect(firstAdd).toHaveLength(1)
      expect(first.sent.some((call) => call.method === 'Page.removeScriptToEvaluateOnNewDocument')).toBe(false)

      first.emit('close', undefined)
      expect(observer.connected).toBe(false)
      await vi.advanceTimersByTimeAsync(5_500)
      expect(observer.connected).toBe(true)
      const second = sockets[1]!
      // 重连后必须先移除旧脚本再注册新脚本（防 target 上脚本累积）
      const secondRemove = second.sent.filter((call) => call.method === 'Page.removeScriptToEvaluateOnNewDocument')
      expect(secondRemove).toHaveLength(1)
      expect(secondRemove[0]!.params.identifier).toBe(`script-${firstAdd[0]!.id}`)
      const secondAdd = second.sent.filter((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument')
      expect(secondAdd).toHaveLength(1)
      // 旧 socket 的迟到 close 不得清掉已经连上的新 socket。
      first.emit('close', undefined)
      expect(observer.connected).toBe(true)
      observer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('attach failure schedules retry and stays degraded (polling fallback)', async () => {
    vi.useFakeTimers()
    try {
      const sockets: FakeSocket[] = []
      const observer = new CursorStreamObserver({
        fetchPageSocketUrl: async () => undefined,
        openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
        onWriteSignal: () => {}
      })
      const first = await observer.attach()
      expect(first).toBe(false)
      expect(observer.connected).toBe(false)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(observer.connected).toBe(false)
      observer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose restores page hooks (fire-and-forget evaluate) and removes the script', async () => {
    const { socket, observer } = buildObserver()
    await observer.attach()
    const sentBefore = socket.sent.length
    observer.dispose()
    expect(socket.closed).toBe(true)
    // 还原 evaluate 必须先于 close 发出（离场不留痕）
    const restoreCall = socket.sent.slice(sentBefore).find((call) => (
      call.method === 'Runtime.evaluate'
      && String(call.params.expression).includes('__sgTeamStreamOriginals')
    ))
    expect(restoreCall).toBeDefined()
    const removeCall = socket.sent.slice(sentBefore).find((call) => (
      call.method === 'Page.removeScriptToEvaluateOnNewDocument'
    ))
    expect(removeCall).toBeDefined()
  })

  it('dispose closes socket and stops retries', async () => {
    vi.useFakeTimers()
    try {
      const { socket, observer } = buildObserver()
      await observer.attach()
      observer.dispose()
      expect(socket.closed).toBe(true)
      expect(observer.connected).toBe(false)
      socket.emit('close', undefined)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(observer.connected).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('阶段 D：Bubble 级内部协议相位分组（RC-5 / RC-5.1 / RC-6）', () => {
  function hookContext(data: () => Record<string, unknown>) {
    class Manager {
      loadedComposers = { ids: ['composer-d'] }
      markDirty(): void {}
    }
    const frames: Array<Record<string, any>> = []
    const context = {
      Promise,
      queueMicrotask,
      setTimeout,
      globalThis: {
        __qtComposerService: {
          composerDataService: {
            composerDataHandleManager: new Manager(),
            getComposerDataIfLoaded: () => data()
          }
        },
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
      }
    }
    return { context, frames }
  }

  async function collect(context: ReturnType<typeof hookContext>['context'], frames: Array<Record<string, any>>): Promise<Array<Record<string, any>>> {
    const schedule = (context.globalThis as Record<string, any>).__sgTeamProcessSchedule as (id: string) => void
    frames.length = 0
    schedule('composer-d')
    await Promise.resolve()
    return (frames[0]?.process as { items?: Array<Record<string, any>> })?.items ?? []
  }

  it('defers MCP tool placeholders until the real tool name hydrates (RC-5.1: 从未出现 mcp--)', async () => {
    let bubble: Record<string, any>
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'b-1' }],
      conversationMap: { 'b-1': bubble },
      generatingBubbleIds: []
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)

    // 首帧：toolCase 已到、真实工具名未水合 → 暂缓展示，不产生占位块
    bubble = { toolFormerData: { toolCall: { tool: { case: 'mcpToolCall', value: {} } } } }
    let items = await collect(context, frames)
    expect(items).toEqual([])

    // 水合为内部协议工具（check_messages）→ 隐藏
    bubble = { toolFormerData: { toolCall: { tool: { case: 'mcpToolCall', value: { args: { server: 'SG Team', toolName: 'check_messages' } } } } } }
    items = await collect(context, frames)
    expect(items).toEqual([])

    // 水合为业务 MCP 工具 → 以真实名称展示
    bubble = { toolFormerData: { toolCall: { tool: { case: 'mcpToolCall', value: { args: { server: 'SG Team', toolName: 'team_task' }, result: { result: { case: 'success' } } } } } } }
    items = await collect(context, frames)
    expect(items.map((item) => `${item.kind}:${item.toolName}`)).toEqual(['tool:mcp-SG Team-team_task'])
  })

  it('hides transport bubbles as a group and keeps the final answer out of process messages (RC-5/RC-6)', async () => {
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'msg-interim' },
        { type: 2, bubbleId: 'tool-read' },
        { type: 2, bubbleId: 'msg-final' },
        { type: 2, bubbleId: 'cap-1' },
        { type: 2, bubbleId: 'th-keep' },
        { type: 2, bubbleId: 'tool-check' }
      ],
      conversationMap: {
        'msg-interim': { text: '我先读取文件。' },
        'tool-read': { toolFormerData: { name: 'read_file', status: 'completed' } },
        'msg-final': { text: '这是最终回答。' },
        'cap-1': { capabilityType: 30, simulatedMessageMetadata: { title: '正在调用 check_messages' } },
        'th-keep': { thinking: '没有新消息，继续等待。' },
        'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed' } }
      },
      generatingBubbleIds: []
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    const items = await collect(context, frames)

    // 传输相位整组隐藏：capability:30、keepalive thinking、check_messages 工具。
    expect(items.map((item) => item.id)).toEqual(['cursor-msg:msg-interim', 'cursor:tool-read'])
    // 最终正文之后只剩传输噪声 → 不作为 cursor-msg（不与 record_reply 正文重复）
    expect(items.some((item) => item.id === 'cursor-msg:msg-final')).toBe(false)
  })

  it('keeps business MCP bubbles, their thinking and interim messages fully visible', async () => {
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'msg-interim' },
        { type: 2, bubbleId: 'th-biz' },
        { type: 2, bubbleId: 'tool-team' },
        { type: 2, bubbleId: 'msg-final' }
      ],
      conversationMap: {
        'msg-interim': { text: '先梳理任务。' },
        'th-biz': { thinking: '领取任务前先确认看板状态。' },
        'tool-team': { toolFormerData: { name: 'mcp-SG Team-team_task', status: 'completed' } },
        'msg-final': { text: '任务已领取。' }
      },
      generatingBubbleIds: []
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    const items = await collect(context, frames)

    expect(items.map((item) => item.id)).toEqual([
      'cursor-msg:msg-interim',
      'cursor-th:th-biz',
      'cursor:tool-team'
    ])
    expect(items.find((item) => item.id === 'cursor:tool-team')).toMatchObject({
      toolName: 'mcp-SG Team-team_task', toolKind: 'mcp'
    })
  })

  it('carries the final answer as a write-cadence response payload, never as a process message (阶段 G 数据层)', async () => {
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'msg-interim' },
        { type: 2, bubbleId: 'tool-read' },
        { type: 2, bubbleId: 'msg-final' },
        { type: 2, bubbleId: 'cap-1' },
        { type: 2, bubbleId: 'tool-check' }
      ],
      conversationMap: {
        'msg-interim': { text: '我先读取文件。' },
        'tool-read': { toolFormerData: { name: 'read_file', status: 'completed' } },
        'msg-final': { text: '这是最终回答。' },
        'cap-1': { capabilityType: 30 },
        'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed' } }
      },
      generatingBubbleIds: ['msg-final']
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    const items = await collect(context, frames)
    // 中间消息仍是过程；最终正文改由 response 载荷承载（与 inspect 的 responseId 同一 bubbleId）。
    expect(items.map((item) => item.id)).toEqual(['cursor-msg:msg-interim', 'cursor:tool-read'])
    expect(frames[0]?.response).toEqual({ id: 'msg-final', text: '这是最终回答。', generating: true })

    // 正文之后仍有业务工具：尚无最终正文，不携带 response。
    const working = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'msg-1' },
        { type: 2, bubbleId: 'tool-read' }
      ],
      conversationMap: {
        'msg-1': { text: '我先读取文件。' },
        'tool-read': { toolFormerData: { name: 'read_file', status: 'completed' } }
      },
      generatingBubbleIds: []
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, working.context)
    await collect(working.context, working.frames)
    expect(working.frames[0]?.response).toBeUndefined()
  })

  it('hides trailing polling scaffolding but keeps thinking that leads to a final answer', async () => {
    // 回合尾部余波：check_messages 之后只剩 capability/thinking、无消息跟随 → 隐藏
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'tool-check' },
        { type: 2, bubbleId: 'cap-trail' },
        { type: 2, bubbleId: 'th-trail' }
      ],
      conversationMap: {
        'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed' } },
        'cap-trail': { capabilityType: 30 },
        'th-trail': { thinking: '暂无新消息。' }
      },
      generatingBubbleIds: []
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    expect(await collect(context, frames)).toEqual([])

    // 轮询后取到新消息：thinking 之后跟着最终正文（消息跟随）→ 业务思考保留
    const second = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'tool-check' },
        { type: 2, bubbleId: 'th-biz' },
        { type: 2, bubbleId: 'msg-final' }
      ],
      conversationMap: {
        'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed' } },
        'th-biz': { thinking: '收到新任务，先整理思路再作答。' },
        'msg-final': { text: '这是针对新任务的回答。' }
      },
      generatingBubbleIds: []
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, second.context)
    const items = await collect(second.context, second.frames)
    expect(items.map((item) => item.id)).toEqual(['cursor-th:th-biz'])
  })

  // Cursor 落盘的 MCP 工具结果形态（2026-09-04 从 state.vscdb 实取）：
  // toolFormerData.result 是双层 JSON 字符串：{"result":"{\"content\":[{\"type\":\"text\",\"text\":…}]}"}
  function mcpResult(text: string): string {
    return JSON.stringify({ result: JSON.stringify({ content: [{ type: 'text', text }] }) })
  }
  const deliveredUserMessage = [
    '如图这里流式过程呈现的有点问题，请你来深度分析根因',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    CHANNEL_USER_DELIVERY_MARKER,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '- 思考、工具调用与输出由拾光直接读取 Cursor 原生会话事件',
    '',
    '[轮次 #321 · 队列剩余 0 条]'
  ].join('\n')

  it('keeps the business thinking that follows a delivered user message visible while it is still running (2026-09-04：38s Thought 被隐藏到正文出现)', async () => {
    // 实机形态：record_reply → check_messages（投递了真实用户消息）→ 模型开始长思考。
    // 旧的尾部兜底把「前一工具是内部协议、其后暂无正文」的 thinking 一律判成轮询余波
    // 隐藏，直到后面出现正文才整段蹦出——投递后的首段业务思考因此整段不可见。
    const headers: Array<Record<string, unknown>> = [
      { type: 1, bubbleId: 'user-1' },
      { type: 2, bubbleId: 'tool-record' },
      { type: 2, bubbleId: 'tool-check' },
      { type: 2, bubbleId: 'th-biz' }
    ]
    const map: Record<string, Record<string, unknown>> = {
      'tool-record': { toolFormerData: { name: 'mcp-SG Team-record_reply', status: 'completed', result: mcpResult('{"ok":true}') } },
      'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed', result: mcpResult(deliveredUserMessage) } },
      'th-biz': { thinking: { text: 'Looking at the screenshots, I notice the same message text appears duplicated…' } }
    }
    let generating = ['th-biz']
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: headers, conversationMap: map, generatingBubbleIds: generating
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)

    // 思考进行中、其后还没有任何工具或正文：必须实时可见（running）。
    let items = await collect(context, frames)
    expect(items.map((item) => `${item.id}:${item.status}`)).toEqual(['cursor-th:th-biz:running'])

    // 思考结束 → 业务工具（Shell），仍无正文：思考继续可见，不因「其后无正文」被回收。
    headers.push({ type: 2, bubbleId: 'tool-shell' })
    map['th-biz'] = { thinking: { text: 'Looking at the screenshots, I notice the same message text appears duplicated…', thinkingDurationMs: 38429 } }
    map['tool-shell'] = { toolFormerData: { name: 'run_terminal_command_v2', status: 'completed', params: { command: 'git status --short' } } }
    generating = []
    items = await collect(context, frames)
    expect(items.map((item) => item.id)).toEqual(['cursor-th:th-biz', 'cursor:tool-shell'])
    expect(items[0]).toMatchObject({ status: 'done', durationMs: 38429 })
  })

  it('still hides the polling aftermath after a keepalive result or a silent collaboration notification', async () => {
    const keepalive = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'tool-check' },
        { type: 2, bubbleId: 'th-keep' }
      ],
      conversationMap: {
        'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed', result: mcpResult('<sg_team_keepalive n="4"/>') } },
        'th-keep': { thinking: { text: '没有新消息，继续静默等待。' } }
      },
      generatingBubbleIds: ['th-keep']
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, keepalive.context)
    expect(await collect(keepalive.context, keepalive.frames)).toEqual([])

    const silent = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'tool-check' },
        { type: 2, bubbleId: 'th-internal' }
      ],
      conversationMap: {
        'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed', result: mcpResult('【拾光内部协作通知】有新的团队消息\n\n---\n【内部协作通知协议】\n- 不要向用户输出可见文字') } },
        'th-internal': { thinking: { text: '先读一下收件箱。' } }
      },
      generatingBubbleIds: ['th-internal']
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, silent.context)
    expect(await collect(silent.context, silent.frames)).toEqual([])
  })
})

describe('阶段 X：MCP pending 首帧不得把最终正文误判为中间过程（2026-09-03 双渲染事故）', () => {
  it('keeps the final answer out of cursor-msg when a pending MCP bubble follows it', async () => {
    // 事故形态：正文 → keepalive thinking → MCP 工具首帧（toolCase 已到、真实名
    // 未水合 = pending）。旧前向规则只认 transport，thinking 被当业务思考构成
    // 「后续工作」→ 最终正文进 cursor-msg → 封口固化 → 与回复正文双渲染。
    class Manager {
      loadedComposers = { ids: ['composer-x'] }
      markDirty(): void {}
    }
    let mcpBubble: Record<string, unknown> = { toolFormerData: { toolCall: { tool: { case: 'mcpToolCall', value: {} } } } }
    const frames: Array<Record<string, any>> = []
    const context = {
      Promise, queueMicrotask, setTimeout,
      globalThis: {
        __qtComposerService: { composerDataService: {
          composerDataHandleManager: new Manager(),
          getComposerDataIfLoaded: () => ({
            fullConversationHeadersOnly: [
              { type: 1, bubbleId: 'user-1' },
              { type: 2, bubbleId: 'final-1' },
              { type: 2, bubbleId: 'th-keep' },
              { type: 2, bubbleId: 'mcp-pending' }
            ],
            conversationMap: {
              'final-1': { text: '这是微信（WeChat）的应用图标：绿色圆角方块，中间两个白色对话气泡叠在一起。' },
              'th-keep': { thinking: '暂无新消息，继续等待。' },
              'mcp-pending': mcpBubble
            },
            generatingBubbleIds: ['mcp-pending']
          })
        } },
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
      }
    }
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    await Promise.resolve()
    let items = (frames[0]?.process as { items?: Array<Record<string, any>> })?.items ?? []
    // 最终正文不进 cursor-msg（由 response 载荷 / record_reply 承载）：工作判定对
    // pending 按传输倾向，th-keep 不构成「后续工作」。
    expect(items.some((item) => item.id === 'cursor-msg:final-1')).toBe(false)
    expect(frames[0]?.response).toMatchObject({ id: 'final-1' })
    // 显示层对 pending 不预判：th-keep 在真实工具名水合前保持可见——否则每个业务
    // MCP 调用开始时其前置思考都会消失一帧再重播（打字机从头再来）。
    expect(items.map((item) => item.id)).toEqual(['cursor-th:th-keep'])

    // 水合为 check_messages：整组传输相位隐藏，最终正文依旧不是过程消息。
    mcpBubble = { toolFormerData: { toolCall: { tool: { case: 'mcpToolCall', value: { args: { server: 'SG Team', toolName: 'check_messages' } } } } } }
    frames.length = 0
    ;(context.globalThis as Record<string, any>).__sgTeamProcessSchedule('composer-x')
    await Promise.resolve()
    items = (frames[0]?.process as { items?: Array<Record<string, any>> })?.items ?? []
    expect(items).toEqual([])
    expect(frames[0]?.response).toMatchObject({ id: 'final-1' })
  })

  it('keeps the business thinking that produced the final answer visible when record_reply follows (message resets the transport phase)', async () => {
    class Manager {
      loadedComposers = { ids: ['composer-y'] }
      markDirty(): void {}
    }
    const frames: Array<Record<string, any>> = []
    const context = {
      Promise, queueMicrotask, setTimeout,
      globalThis: {
        __qtComposerService: { composerDataService: {
          composerDataHandleManager: new Manager(),
          getComposerDataIfLoaded: () => ({
            fullConversationHeadersOnly: [
              { type: 1, bubbleId: 'user-1' },
              { type: 2, bubbleId: 'th-answer' },
              { type: 2, bubbleId: 'final-1' },
              { type: 2, bubbleId: 'tool-record' },
              { type: 2, bubbleId: 'th-keep' },
              { type: 2, bubbleId: 'tool-check' }
            ],
            conversationMap: {
              'th-answer': { thinking: '用户问的是图标含义，直接描述即可。' },
              'final-1': { text: '这是微信的应用图标。' },
              'tool-record': { toolFormerData: { name: 'mcp-SG Team-record_reply', status: 'completed' } },
              'th-keep': { thinking: '暂无新消息，继续等待。' },
              'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed' } }
            },
            generatingBubbleIds: []
          })
        } },
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
      }
    }
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    await Promise.resolve()
    const items = (frames[0]?.process as { items?: Array<Record<string, any>> })?.items ?? []
    // 产出答案的 Thought 不被其后的 record_reply/check_messages 回溯吞掉；
    // 正文之后的 keepalive thinking 仍是传输相位；正文本身由 response 载荷承载。
    expect(items.map((item) => item.id)).toEqual(['cursor-th:th-answer'])
    expect(frames[0]?.response).toMatchObject({ id: 'final-1', text: '这是微信的应用图标。' })
  })
})
