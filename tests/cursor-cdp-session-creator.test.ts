import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  CursorCdpSessionCreator,
  buildRuntimeInspectionExpression,
  cursorWorkspaceScopeId,
  type CursorCdpTarget
} from '../src/infrastructure/cursor/cursor-cdp-session-creator'

function target(id: string, title = ''): CursorCdpTarget {
  return {
    id,
    type: 'page',
    title,
    url: `file:///Applications/Cursor.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html#${id}`,
    webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${id}`
  }
}

interface FakeWindow {
  title: string
  bridgeReady: boolean
  scope: string
  createResult?: unknown
  runtimeResult?: unknown
}

function createCreator(windows: Record<string, FakeWindow>, options: { failTargets?: boolean } = {}) {
  const targets = Object.keys(windows).map((id) => target(id, windows[id]!.title))
  const evaluatedExpressions: string[] = []
  const creator = new CursorCdpSessionCreator({
    fetchTargets: async () => {
      if (options.failTargets) throw new Error('connect ECONNREFUSED')
      return targets
    },
    evaluate: async (url, expression) => {
      evaluatedExpressions.push(expression)
      const id = url.split('/').pop() ?? ''
      const win = windows[id]
      if (!win) throw new Error('unknown target')
      if (expression.includes('__qtBatchWorkspaceScopeId') && expression.includes('document.title')) {
        return { bridge: win.bridgeReady, scope: win.scope, title: win.title }
      }
      if (expression.includes('bridge.getStatus') && expression.includes('rows.push')) {
        return win.runtimeResult ?? { ok: true, rows: [] }
      }
      // 创建表达式
      if (!win.bridgeReady) return { ok: false, error: 'bridge_not_ready' }
      return win.createResult ?? { ok: true, composerId: `composer-${id}` }
    }
  })
  return { creator, evaluatedExpressions }
}

const WS_PATH = '/Users/example/Projects/qingtian'
const WS_SCOPE = createHash('sha256').update(WS_PATH).digest('hex').slice(0, 16)

describe('cursorWorkspaceScopeId', () => {
  it('与晴天插件的 workspaceScopeId 算法一致（sha256 前 16 位）', () => {
    expect(cursorWorkspaceScopeId(WS_PATH)).toBe(WS_SCOPE)
    expect(cursorWorkspaceScopeId(WS_PATH)).toHaveLength(16)
  })
})

describe('CursorCdpSessionCreator.probe', () => {
  it('调试端口不可达 → available=false 且给出引导信息', async () => {
    const { creator } = createCreator({}, { failTargets: true })
    const result = await creator.probe()
    expect(result.available).toBe(false)
    expect(result.issue).toContain('未检测到 Cursor 调试端口')
    expect(result.issue).toContain('9333')
  })

  it('端口可用时列出各窗口的桥接状态', async () => {
    const { creator } = createCreator({
      a: { title: 'qingtian-team — Cursor', bridgeReady: true, scope: WS_SCOPE }
    })
    const result = await creator.probe()
    expect(result.available).toBe(true)
    expect(result.windows).toEqual([{ title: 'qingtian-team — Cursor', bridgeReady: true, workspaceScope: WS_SCOPE }])
  })
})

describe('CursorCdpSessionCreator.createAgentSession', () => {
  it('单窗口直接使用，创建并提交成功返回真实 composerId', async () => {
    const { creator, evaluatedExpressions } = createCreator({
      only: { title: 'ws', bridgeReady: true, scope: '', createResult: { ok: true, composerId: 'composer-real' } }
    })
    const result = await creator.createAgentSession({ channelId: '2', name: 'CH-2 · 拾光会话', prompt: '开场白', workspacePath: WS_PATH })
    expect(result).toEqual({ ok: true, message: '会话已创建并提交开场提示词', composerId: 'composer-real' })
    const createExpression = evaluatedExpressions.find((expression) => expression.includes('createAgent'))
    expect(createExpression).toBeDefined()
    expect(createExpression).toContain('"CH-2 · 拾光会话"')
    expect(createExpression).toContain('"开场白"')
    expect(createExpression).toContain('autoSubmit: false')
    expect(createExpression).toContain('submitByComposerId')
  })

  it('creates a Composer with an independent per-session modelConfig before submitting', async () => {
    const { creator, evaluatedExpressions } = createCreator({
      only: { title: 'ws', bridgeReady: true, scope: '', createResult: { ok: true, composerId: 'composer-model' } }
    })
    const result = await creator.createAgentSession({
      channelId: '2', name: 'CH-2', prompt: '开始',
      modelSelection: {
        modelId: 'claude-opus-5', displayName: 'Claude Opus 5', maxMode: true,
        parameters: [
          { id: 'thinking', value: 'true' },
          { id: 'context', value: '1m' },
          { id: 'effort', value: 'high' }
        ]
      }
    })
    expect(result).toMatchObject({ ok: true, composerId: 'composer-model', modelId: 'claude-opus-5' })
    const expression = evaluatedExpressions.find((candidate) => candidate.includes('MODEL_CONFIG')) ?? ''
    expect(expression).toContain('window.__qtComposerService')
    expect(expression).toContain('service.createComposer')
    expect(expression).toContain('partialState')
    expect(expression).not.toContain('partialState: { unifiedMode: \'agent\', name: NAME, modelConfig: MODEL_CONFIG }')
    expect(expression).toContain('setModelConfigForComposer')
    expect(expression).toContain('await Promise.resolve(modelService.setModelConfigForComposer')
    expect(expression).toContain('updateGlobalConfig: false')
    expect(expression).toContain('manuallyPersistComposer')
    expect(expression).toContain('"modelName":"claude-opus-5"')
    expect(expression).toContain('"maxMode":true')
    expect(expression).toContain('"thinking","value":"true"')
    expect(expression).toContain('"context","value":"1m"')
    expect(expression).toContain('"effort","value":"high"')
    expect(expression).toContain('max_mode_unconfirmed')
    expect(expression).toContain('model_parameters_unconfirmed')
    expect(expression.indexOf('setModelConfigForComposer')).toBeLessThan(expression.indexOf('submitByComposerId'))
  })

  it('多窗口按工作区 scope 精确匹配', async () => {
    const { creator } = createCreator({
      a: { title: 'other — Cursor', bridgeReady: true, scope: 'deadbeefdeadbeef' },
      b: { title: 'qingtian — Cursor', bridgeReady: true, scope: WS_SCOPE, createResult: { ok: true, composerId: 'composer-b' } }
    })
    const result = await creator.createAgentSession({ channelId: '1', name: 'n', prompt: 'p', workspacePath: WS_PATH })
    expect(result.ok).toBe(true)
    expect(result.composerId).toBe('composer-b')
  })

  it('单窗口但 scope 属于其他工作区时拒绝误用', async () => {
    const { creator } = createCreator({
      only: { title: 'Agent Window — Cursor', bridgeReady: true, scope: 'deadbeefdeadbeef' }
    })
    const result = await creator.createAgentSession({ channelId: '1', name: 'n', prompt: 'p', workspacePath: WS_PATH })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('非当前团队工作区')
  })

  it('单窗口且桥接未就绪、标题不匹配时提示打开团队 IDE 工作区', async () => {
    const { creator } = createCreator({
      only: { title: 'Agent Window — Cursor', bridgeReady: false, scope: '' }
    })
    const result = await creator.createAgentSession({ channelId: '1', name: 'n', prompt: 'p', workspacePath: WS_PATH })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('团队 IDE 工作区')
  })

  it('scope 缺失时按窗口标题中的工作区名匹配', async () => {
    const { creator } = createCreator({
      a: { title: 'unrelated — Cursor', bridgeReady: true, scope: '' },
      b: { title: 'agent-launcher.ts — qingtian — Cursor', bridgeReady: true, scope: '', createResult: { ok: true, composerId: 'composer-title' } }
    })
    const result = await creator.createAgentSession({ channelId: '1', name: 'n', prompt: 'p', workspacePath: WS_PATH })
    expect(result.composerId).toBe('composer-title')
  })

  it('多窗口无法判定时明确报错并列出窗口标题', async () => {
    const { creator } = createCreator({
      a: { title: 'window-a', bridgeReady: true, scope: '' },
      b: { title: 'window-b', bridgeReady: true, scope: '' }
    })
    const result = await creator.createAgentSession({ channelId: '1', name: 'n', prompt: 'p', workspacePath: WS_PATH })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('无法确定团队工作区所在窗口')
    expect(result.message).toContain('window-a')
  })

  it('调试端口不可达 → 返回含引导的失败', async () => {
    const { creator } = createCreator({}, { failTargets: true })
    const result = await creator.createAgentSession({ channelId: '1', name: 'n', prompt: 'p', workspacePath: WS_PATH })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('未检测到 Cursor 调试端口')
  })

  it('窗口内网关联接未就绪 → 明确提示注入', async () => {
    const { creator } = createCreator({
      only: { title: 'ws', bridgeReady: false, scope: '' }
    })
    const result = await creator.createAgentSession({ channelId: '1', name: 'n', prompt: 'p' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('网关联接未就绪')
  })

  it('提交失败但已创建 → 保留 composerId 便于排查', async () => {
    const { creator } = createCreator({
      only: { title: 'ws', bridgeReady: true, scope: '', createResult: { ok: false, error: 'submit_failed:chatService not ready', composerId: 'composer-x' } }
    })
    const result = await creator.createAgentSession({ channelId: '1', name: 'n', prompt: 'p' })
    expect(result.ok).toBe(false)
    expect(result.composerId).toBe('composer-x')
    expect(result.message).toContain('提交失败')
  })

  it('持续对话模式下提交 promise 不了结 → 表达式具备异步受理核验（getStatus/lastHumanText）', async () => {
    const { creator, evaluatedExpressions } = createCreator({
      only: { title: 'ws', bridgeReady: true, scope: '' }
    })
    await creator.createAgentSession({ channelId: '1', name: 'n', prompt: 'p' })
    const createExpression = evaluatedExpressions.find((expression) => expression.includes('createAgent')) ?? ''
    // 回归钉：submit 不了结时以 getStatus().lastHumanText 前缀比对作为受理证据；
    // 提交后立即进入融合核验循环（不等固定 ACK 窗口），5s 总窗口兜底
    expect(createExpression).toContain('OVERALL_MS')
    expect(createExpression).toContain('Date.now() < deadline')
    expect(createExpression).toContain('getStatus')
    expect(createExpression).toContain('lastHumanText')
    expect(createExpression).toContain('submitAsync')
  })

  it('异步受理回执 → 返回成功且文案区分', async () => {
    const { creator } = createCreator({
      only: { title: 'ws', bridgeReady: true, scope: '', createResult: { ok: true, composerId: 'composer-async', submitAsync: true } }
    })
    const result = await creator.createAgentSession({ channelId: '1', name: 'n', prompt: 'p' })
    expect(result.ok).toBe(true)
    expect(result.composerId).toBe('composer-async')
    expect(result.message).toContain('异步受理')
  })

  it('通道号非法与空提示词直接拒绝', async () => {
    const { creator } = createCreator({ only: { title: 'ws', bridgeReady: true, scope: '' } })
    expect((await creator.createAgentSession({ channelId: 'abc', name: 'n', prompt: 'p' })).message).toContain('通道号无效')
    expect((await creator.createAgentSession({ channelId: '1', name: 'n', prompt: '  ' })).message).toContain('开场提示词为空')
  })

  it('创建表达式内嵌文本经过 JSON 转义（防注入）', async () => {
    const { creator, evaluatedExpressions } = createCreator({
      only: { title: 'ws', bridgeReady: true, scope: '' }
    })
    const tricky = '包含"引号"与\n换行`模板`${inverse}'
    await creator.createAgentSession({ channelId: '1', name: 'n`', prompt: tricky })
    const createExpression = evaluatedExpressions.find((expression) => expression.includes('createAgent')) ?? ''
    expect(createExpression).toContain(JSON.stringify(tricky))
    expect(createExpression).toContain(JSON.stringify('n`'))
  })
})

describe('CursorCdpSessionCreator.inspectComposerRuntime', () => {
  it('reads final assistant text from Cursor data and excludes interim text followed by work', async () => {
    const data = {
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'interim' },
        { type: 2, bubbleId: 'tool-1' }
      ],
      conversationMap: {
        'user-1': { text: '开始' },
        interim: { text: '我先读取文件。' },
        'tool-1': { toolFormerData: { name: 'read_file' } }
      }
    }
    const window = {
      __qtComposerBridge: {
        ready: true,
        listComposers: () => [{ composerId: 'composer-1', status: 'generating', isGenerating: true }],
        getStatus: () => ({ found: true, status: 'generating', lastAiText: 'DOM 中混入的工具文字', lastAiBubbleId: 'dom' }),
        getComposerData: () => data
      }
    }
    const withoutFinal = await runInNewContext(buildRuntimeInspectionExpression(['composer-1']), { window, Map, Date })
    expect(withoutFinal.rows[0]).toMatchObject({ responseText: '', responseId: '' })

    data.fullConversationHeadersOnly.push({ type: 2, bubbleId: 'final-1' })
    Object.assign(data.conversationMap, { 'final-1': { text: '这是最终回答。' } })
    data.fullConversationHeadersOnly.push({ type: 2, bubbleId: 'record-reply' })
    Object.assign(data.conversationMap, {
      'record-reply': { toolFormerData: { name: 'mcp-SG Team-record_reply' } }
    })
    const withFinal = await runInNewContext(buildRuntimeInspectionExpression(['composer-1']), { window, Map, Date })
    expect(withFinal.rows[0]).toMatchObject({ responseText: '这是最终回答。', responseId: 'final-1' })
  })

  it('uses live status fallback while Composer data is only an empty hydration shell', async () => {
    const window = {
      __qtComposerBridge: {
        ready: true,
        listComposers: () => [{ composerId: 'composer-empty', status: 'generating', isGenerating: true }],
        getStatus: () => ({ found: true, status: 'generating', lastAiText: '仍然可见的实时回复', lastAiBubbleId: 'live-bubble' }),
        getComposerData: () => ({ fullConversationHeadersOnly: [], conversationMap: {} })
      }
    }
    const inspected = await runInNewContext(buildRuntimeInspectionExpression(['composer-empty']), { window, Map, Date })
    expect(inspected.rows[0]).toMatchObject({ responseText: '仍然可见的实时回复', responseId: 'live-bubble' })
  })

  it('returns exact stopped evidence from the live Cursor bridge', async () => {
    const { creator, evaluatedExpressions } = createCreator({
      only: {
        title: 'qingtian — Cursor',
        bridgeReady: true,
        scope: WS_SCOPE,
        runtimeResult: {
          ok: true,
          rows: [{
            composerId: 'composer-dead',
            state: 'stopped',
            detail: 'Cursor Agent 已因错误终止',
            observedAt: 10_000,
            isGenerating: true,
            responseId: 'bubble-live',
            responseText: '正在实时生成回答'
          }]
        }
      }
    })
    const result = await creator.inspectComposerRuntime(WS_PATH, ['composer-dead'])
    expect(result['composer-dead']).toMatchObject({
      state: 'stopped', observedAt: 10_000,
      isGenerating: true, responseId: 'bubble-live', responseText: '正在实时生成回答'
    })
    expect(evaluatedExpressions.some((expression) => expression.includes('bridge.getStatus'))).toBe(true)
    expect(evaluatedExpressions.some((expression) => expression.includes('bridge.getComposerData'))).toBe(true)
    expect(evaluatedExpressions.some((expression) => expression.includes('laterWork'))).toBe(true)
    expect(evaluatedExpressions.some((expression) => expression.includes('lastAiText'))).toBe(true)
    expect(evaluatedExpressions.some((expression) => expression.includes('lastAiBubbleId'))).toBe(true)
  })

  it('只过滤轮询噪音并保留改变业务状态的团队工具', async () => {
    const { creator } = createCreator({
      only: {
        title: 'qingtian — Cursor',
        bridgeReady: true,
        scope: WS_SCOPE,
        runtimeResult: {
          ok: true,
          rows: [{
            composerId: 'composer-live',
            state: 'active',
            detail: 'Cursor 实时状态确认 Agent 正在执行',
            observedAt: 10_000,
            isGenerating: true,
            responseId: 'bubble-live',
            responseText: '回答',
            process: {
              items: [
                { kind: 'thinking', id: 'cursor-th:b1', text: '先读配置', status: 'running' },
                { kind: 'tool', id: 'cursor:b-read', toolName: 'read_file_v2', toolKind: 'read', summary: '/p/a.json', status: 'done' },
                // 仅持续轮询与回复同步属于噪音；团队业务工具必须保留。
                { kind: 'tool', id: 'cursor:b-check', toolName: 'mcp-SG Team-check_messages', toolKind: 'mcp', summary: '', status: 'running' },
                { kind: 'tool', id: 'cursor:b-reply', toolName: 'mcp-SG Team-record_reply', toolKind: 'mcp', summary: '', status: 'done' },
                { kind: 'tool', id: 'cursor:b-team', toolName: 'mcp-SG Team-team_bootstrap', toolKind: 'mcp', summary: '', status: 'done' },
                { kind: 'tool', id: 'cursor:b-plain', toolName: 'team_run', toolKind: 'mcp', summary: '', status: 'done' }
              ],
              todos: [
                { content: '读取配置', status: 'completed' },
                { content: '验证配置', status: 'in_progress' }
              ],
              generatingBubbleCount: 1,
              turnId: 'user-business-turn',
              truncatedItemCount: 2
            }
          }]
        }
      }
    })
    const result = await creator.inspectComposerRuntime(WS_PATH, ['composer-live'])
    const evidence = result['composer-live']
    expect(evidence).toBeDefined()
    expect(evidence?.process).toMatchObject({
      items: [
        { kind: 'thinking', id: 'cursor-th:b1', text: '先读配置', status: 'running' },
        { kind: 'tool', id: 'cursor:b-read', toolName: 'read_file_v2', toolKind: 'read' },
        { kind: 'tool', id: 'cursor:b-team', toolName: 'mcp-SG Team-team_bootstrap', toolKind: 'mcp' },
        { kind: 'tool', id: 'cursor:b-plain', toolName: 'team_run', toolKind: 'mcp' }
      ],
      turnId: 'user-business-turn',
      truncatedItemCount: 2,
      todos: [
        { content: '读取配置', status: 'completed' },
        { content: '验证配置', status: 'in_progress' }
      ],
      generatingBubbleCount: 1
    })
    const toolNames = evidence?.process?.items.flatMap((item) => item.kind === 'tool' ? [item.toolName] : []) ?? []
    expect(toolNames).toEqual(['read_file_v2', 'mcp-SG Team-team_bootstrap', 'team_run'])
  })

  it('keeps long native turns beyond the old 36-step cutoff', async () => {
    const items = Array.from({ length: 80 }, (_, index) => ({
      kind: 'tool', id: `tool-${index}`, toolName: 'read_file', toolKind: 'read',
      summary: `file-${index}.ts`, status: 'done'
    }))
    const { creator } = createCreator({
      only: {
        title: 'qingtian — Cursor', bridgeReady: true, scope: WS_SCOPE,
        runtimeResult: {
          ok: true,
          rows: [{
            composerId: 'composer-long', state: 'active', detail: 'running', observedAt: 1,
            isGenerating: true,
            process: { turnId: 'user-long', items, generatingBubbleCount: 1 }
          }]
        }
      }
    })
    const result = await creator.inspectComposerRuntime(WS_PATH, ['composer-long'])
    expect(result['composer-long']?.process?.items).toHaveLength(80)
    expect(result['composer-long']?.process?.items[0]?.id).toBe('tool-0')
  })

  it('纯内部协议调用回合 → process 为 undefined（不产生噪音卡）', async () => {
    const { creator } = createCreator({
      only: {
        title: 'qingtian — Cursor',
        bridgeReady: true,
        scope: WS_SCOPE,
        runtimeResult: {
          ok: true,
          rows: [{
            composerId: 'composer-quiet',
            state: 'active',
            detail: '生成中',
            observedAt: 10_000,
            isGenerating: true,
            responseId: 'bubble-live',
            responseText: '回答',
            process: {
              items: [
                { kind: 'tool', id: 'cursor:b-check', toolName: 'mcp-SG Team-check_messages', toolKind: 'mcp', summary: '', status: 'running' }
              ],
              generatingBubbleCount: 1
            }
          }]
        }
      }
    })
    const result = await creator.inspectComposerRuntime(WS_PATH, ['composer-quiet'])
    expect(result['composer-quiet']?.process).toBeUndefined()
  })
})
