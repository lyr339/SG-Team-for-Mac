import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CursorCdpSessionCreator,
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
    const result = await creator.createAgentSession({ channelId: '2', name: 'CH-2 · 群枢会话', prompt: '开场白', workspacePath: WS_PATH })
    expect(result).toEqual({ ok: true, message: '会话已创建并提交开场提示词', composerId: 'composer-real' })
    const createExpression = evaluatedExpressions.find((expression) => expression.includes('createAgent'))
    expect(createExpression).toBeDefined()
    expect(createExpression).toContain('"CH-2 · 群枢会话"')
    expect(createExpression).toContain('"开场白"')
    expect(createExpression).toContain('autoSubmit: false')
    expect(createExpression).toContain('submitByComposerId')
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
    // 回归钉：submit 只短等回执，未了结时以 getStatus().lastHumanText 前缀比对作为受理证据
    expect(createExpression).toContain('ACK_MS')
    expect(createExpression).toContain('Promise.race')
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
