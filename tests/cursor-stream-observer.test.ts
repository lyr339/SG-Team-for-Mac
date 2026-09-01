import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import {
  CURSOR_STREAM_HOOK_EXPRESSION,
  CursorStreamObserver,
  type CursorNativeProcessEvent,
  type StreamObserverSocket
} from '../src/infrastructure/cursor/cursor-stream-observer'

interface SentCall {
  id: number
  method: string
  params: Record<string, unknown>
}

class FakeSocket implements StreamObserverSocket {
  readonly sent: SentCall[] = []
  closed = false
  private listeners = new Map<string, Array<(arg: unknown) => void>>()

  send(text: string): void {
    const call = JSON.parse(text) as SentCall
    this.sent.push(call)
    // CDP 调用自动应答（Runtime.enable / addBinding 等无需真实结果）
    const result = call.method === 'Page.addScriptToEvaluateOnNewDocument'
      ? { identifier: `script-${call.id}` }
      : {}
    queueMicrotask(() => this.emit('message', JSON.stringify({ id: call.id, result })))
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
    expect((context.globalThis as Record<string, unknown>).__sgTeamStreamHookVersion).toBe(13)
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
                'message-1': { text: '先打开页面检查当前状态。' },
                'tool-1': {
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
    expect(process?.items?.[0]).toMatchObject({ kind: 'message', text: '先打开页面检查当前状态。' })
    expect(process?.items?.[1]).toMatchObject({
      kind: 'tool', toolKind: 'browser', summary: 'http://localhost', status: 'done', output: 'Page loaded\n[image result]'
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
    const socket = new FakeSocket()
    const observer = new CursorStreamObserver({
      fetchPageSocketUrl: async () => 'ws://127.0.0.1:9333/devtools/page/abc',
      openSocket: () => socket,
      onWriteSignal: () => {},
      onUsageEvent: (event) => events.push({ ...event })
    })
    await observer.attach()

    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: '__sgTeamUsage', payload: '{"c":"comp-1","i":12168,"o":42,"r":3968,"w":0,"t":1788021941352}' }
    }))
    // t 缺失回退当前时间；非法值收敛 0
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
      { composerId: 'comp-1', inputTokens: 12168, outputTokens: 42, cacheReadTokens: 3968, cacheWriteTokens: 0, occurredAt: 1788021941352 },
      { composerId: 'comp-2', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, occurredAt: expect.any(Number) }
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
