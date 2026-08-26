// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { MessageAttachment } from '../src/domain/conversation-entry'
import { emptyTaskPoolSnapshot } from '../src/domain/task-pool'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import { emptyTeamCollaborationSnapshot } from '../src/domain/team-collaboration'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import { App } from '../src/renderer/src/App'

function makeSession(channelId: string, displayName: string): AgentSession {
  return {
    id: `session-${channelId}`,
    channelId,
    generation: 1,
    displayName,
    roleName: '实现席',
    status: 'waiting',
    currentTask: '',
    queueDepth: 0,
    connectionPhase: 'keepalive',
    online: true,
    connected: true,
    waiting: true,
    workingFiles: [],
    healthEvidence: []
  }
}

const snapshot: DesktopSnapshot = {
  connection: { state: 'connected', endpoint: 'qunshu://test', attempt: 0, lastError: '' },
  sessions: [
    makeSession('2', '后端实现 · CH-2'),
    makeSession('5', '专项实现 · CH-5')
  ],
  conversations: { '2': [], '5': [] },
  protocolIssues: [],
  updatedAt: 1
}

interface SendMessageCall {
  channelId: string
  text: string
  attachments?: MessageAttachment[]
}

const sendMessage = vi.fn<(input: SendMessageCall) => Promise<void>>(async () => {})

function stubScrollApis(): void {
  // jsdom 未实现元素滚动 API；会话时间线的贴底滚动在测试中置为空操作
  if (!window.Element.prototype.scrollTo) {
    window.Element.prototype.scrollTo = () => {}
  }
}

function installDesktopMock(): void {
  const base: Record<string, unknown> = {
    onSnapshot: () => () => {},
    onTaskPoolSnapshot: () => () => {},
    onTeamControlSnapshot: () => () => {},
    onTeamCollaborationSnapshot: () => () => {},
    onAozaiProgress: () => () => {},
    onAgentLaunchProgress: () => () => {},
    onCdpAutoHealEvent: () => () => {},
    onAccountAutomationProgress: () => () => {},
    getSnapshot: async () => snapshot,
    getTaskPoolSnapshot: async () => emptyTaskPoolSnapshot(),
    getTeamControlSnapshot: async () => emptyTeamControlSnapshot(),
    getTeamCollaborationSnapshot: async () => emptyTeamCollaborationSnapshot(),
    listCursorAccounts: async () => [],
    getAozaiCardStatus: async () => ({ saved: false }),
    getAgentLaunchPlan: async () => undefined,
    getAccountAutomationSettings: async () => ({ enabled: false, delaySec: 30 }),
    getAccountAutomationRun: async () => ({ phase: 'idle' }),
    getCursorCdpSettings: async () => ({ autoHealEnabled: false }),
    getCursorUpdatePreferences: async () => ({}),
    detectCursorWorkspace: async () => ({ state: 'none', source: 'test', confidence: 0, candidates: [], detail: '' }),
    refreshAozaiBalance: async () => ({ saved: false }),
    installTaskMcp: async () => ({ ok: true, restartRequired: false }),
    sendMessage
  }
  const api = new Proxy(base, {
    get: (target, prop) => {
      if (prop in target) return target[prop as keyof typeof target]
      if (String(prop).startsWith('on')) return () => () => {}
      return async () => undefined
    }
  })
  ;(window as unknown as { qingtianDesktop: unknown }).qingtianDesktop = api
}

let container: HTMLDivElement
let root: Root

function composerTextarea(): HTMLTextAreaElement {
  const element = container.querySelector('textarea[aria-label^="给 "]')
  if (!element) throw new Error('composer textarea not rendered')
  return element as HTMLTextAreaElement
}

function sessionCard(channelId: string): HTMLButtonElement {
  const card = Array.from(container.querySelectorAll<HTMLButtonElement>('button.rail-session-card'))
    .find((element) => element.textContent?.includes(`CH-${channelId}`))
  if (!card) throw new Error(`session card CH-${channelId} not rendered`)
  return card
}

async function renderApp(hash: string): Promise<void> {
  window.location.hash = hash
  root = createRoot(container)
  await act(async () => {
    root.render(<App />)
  })
  // 初始 effect 链（快照/团队/账号等 Promise）全部落进 React 状态
  await act(async () => {})
  await act(async () => {})
}

async function typeDraft(value: string): Promise<void> {
  const textarea = composerTextarea()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(textarea, value)
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function selectChannel(channelId: string): Promise<void> {
  const card = sessionCard(channelId)
  await act(async () => {
    card.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await act(async () => {})
}

async function attachFile(name: string, type = 'text/plain'): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('attachment input not rendered')
  const file = new window.File(['hello attachment'], name, { type })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  // FileReader 以宏任务完成读取，等待附件落进状态
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await act(async () => {})
}

function clickButtonWithText(text: string): void {
  const button = Array.from(container.querySelectorAll('button'))
    .find((element) => element.textContent?.trim() === text)
  if (!button) throw new Error(`button "${text}" not rendered`)
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

describe('App 输入框草稿与附件按通道隔离', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    sendMessage.mockClear()
    stubScrollApis()
    installDesktopMock()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    window.location.hash = ''
  })

  it('draft 按 channelId 保存：切换通道互不干扰，切回后恢复', async () => {
    await renderApp('#sessions:2')
    expect(composerTextarea().value).toBe('')
    expect(composerTextarea().getAttribute('aria-label')).toContain('CH-2')

    await typeDraft('给 CH-2 的草稿')
    await selectChannel('5')
    expect(composerTextarea().getAttribute('aria-label')).toContain('CH-5')
    expect(composerTextarea().value).toBe('')

    await typeDraft('CH-5 的另一份草稿')
    await selectChannel('2')
    expect(composerTextarea().value).toBe('给 CH-2 的草稿')

    await selectChannel('5')
    expect(composerTextarea().value).toBe('CH-5 的另一份草稿')
  })

  it('附件按 channelId 保存：切换通道后各自恢复', async () => {
    await renderApp('#sessions:2')
    await attachFile('ch2-notes.md')
    expect(container.textContent).toContain('ch2-notes.md')

    await selectChannel('5')
    expect(container.textContent).not.toContain('ch2-notes.md')

    await attachFile('ch5-shot.png', 'image/png')
    expect(container.textContent).toContain('ch5-shot.png')

    await selectChannel('2')
    expect(container.textContent).toContain('ch2-notes.md')
    expect(container.textContent).not.toContain('ch5-shot.png')

    await selectChannel('5')
    expect(container.textContent).toContain('ch5-shot.png')
    expect(container.textContent).not.toContain('ch2-notes.md')
  })

  it('发送成功后清空该通道草稿并把文本发给对应 channelId', async () => {
    await renderApp('#sessions:2')
    await typeDraft('请处理这个任务')
    await act(async () => {
      clickButtonWithText('发送')
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith({
      channelId: '2',
      text: '请处理这个任务',
      attachments: undefined
    })
    expect(composerTextarea().value).toBe('')

    await selectChannel('5')
    expect(composerTextarea().value).toBe('')
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
