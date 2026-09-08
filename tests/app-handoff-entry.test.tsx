// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import { emptyTaskPoolSnapshot } from '../src/domain/task-pool'
import { emptyTeamControlSnapshot, type TeamControlSnapshot, type TeamMemberView } from '../src/domain/team-control'
import { emptyTeamCollaborationSnapshot } from '../src/domain/team-collaboration'
import type { TeamHandoffOptions } from '../src/domain/team-handoff'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import { App } from '../src/renderer/src/App'
import { CONTEXT_HANDOFF_TITLE_TEAM, ROLES_HANDOFF_TITLE } from '../src/renderer/src/handoff-entry'

function makeSession(channelId: string, online: boolean): AgentSession {
  return {
    id: `session-${channelId}`,
    channelId,
    generation: 1,
    displayName: `SG Team CH-${channelId}`,
    roleName: '未绑定外置团队',
    status: online ? 'waiting' : 'offline',
    currentTask: '',
    queueDepth: 0,
    connectionPhase: online ? 'keepalive' : '',
    online,
    connected: online,
    waiting: online,
    workingFiles: [],
    healthEvidence: []
  }
}

const RUN = {
  id: 'team-run:ws:main', workspaceId: 'ws', name: 'demo · 主运行', goal: '交接', templateId: 'software-core-v1',
  status: 'running' as const, createdAt: 1, updatedAt: 1
}

function member(channelId: string, templateKey: string, roleName: string, slotName: string, online: boolean): TeamMemberView {
  const slotId = `slot-${templateKey}`
  return {
    slot: { id: slotId, runId: RUN.id, roleId: `role-${templateKey}`, name: slotName, avatarId: 'architect', channelId, order: 0, createdAt: 1, updatedAt: 1 },
    role: { id: `role-${templateKey}`, runId: RUN.id, key: templateKey, templateKey, name: roleName, mission: '', instructions: '', capabilities: [], skills: [], accent: 'mint', order: 0 },
    binding: {
      id: `b-${channelId}`, workspaceId: 'ws', runId: RUN.id, slotId, channelId, agentSessionId: `agent-${channelId}`, generation: 'g1',
      installedAt: 1, launchStatus: 'acknowledged', launchDetail: '', lastCheckInNote: '', composerBindingKey: `k-${channelId}`, composerId: `composer-${channelId}`
    },
    runtime: { channelId, status: online ? 'waiting' : 'offline', online, waiting: online, queueDepth: 0, healthEvidence: [], workingFiles: [] },
    readiness: online ? 'active' : 'offline'
  }
}

const members = [
  member('1', 'lead', '主控协调', '主控席', true),
  member('2', 'builder', '架构实现', '实现席', true),
  member('5', 'reviewer', '质量验证', '验收席', false)
]

const teamControl: TeamControlSnapshot = {
  ...emptyTeamControlSnapshot(),
  revision: 1,
  activeWorkspaceId: 'ws',
  workspaces: [{ id: 'ws', name: 'demo', path: '/workspace/demo', createdAt: 1, updatedAt: 1 }],
  runs: [RUN],
  activeRun: RUN,
  members,
  bindings: members.map((item) => item.binding!)
}

const snapshot: DesktopSnapshot = {
  connection: { state: 'connected', endpoint: 'shiguang://test', attempt: 0, lastError: '' },
  sessions: [makeSession('1', true), makeSession('2', true), makeSession('5', false)],
  conversations: { '1': [], '2': [], '5': [] },
  protocolIssues: [],
  updatedAt: 1
}

const manualHandoffOptions: TeamHandoffOptions = {
  runId: RUN.id,
  sourceSlotId: 'slot-reviewer',
  sourceRoleName: '质量验证',
  sourceChannelId: '5',
  candidates: [{
    agentSessionId: 'agent-2', kind: 'member', mode: 'role_rebind', channelId: '2', slotId: 'slot-builder',
    roleName: '架构实现', avatarId: 'architect', eligible: true, impact: '架构实现席将转为离线空缺'
  }]
}

const getManualHandoffOptions = vi.fn(async () => manualHandoffOptions)
const getSessionHandoffContext = vi.fn(() => new Promise(() => {}))

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
    getTeamControlSnapshot: async () => teamControl,
    getTeamCollaborationSnapshot: async () => emptyTeamCollaborationSnapshot(RUN.id),
    listCursorAccounts: async () => [],
    getAozaiCardStatus: async () => ({ saved: false }),
    getAgentLaunchPlan: async () => undefined,
    getAccountAutomationSettings: async () => ({ enabled: false, delaySec: 30 }),
    getAccountAutomationRun: async () => ({ phase: 'idle' }),
    getCursorCdpSettings: async () => ({ autoHealEnabled: false }),
    getCursorUpdatePreferences: async () => ({}),
    detectCursorWorkspace: async () => ({ state: 'none', source: 'test', confidence: 0, candidates: [], detail: '' }),
    refreshAozaiBalance: async () => ({ saved: false }),
    getManualHandoffOptions,
    getSessionHandoffContext
  }
  const api = new Proxy(base, {
    get: (target, prop) => {
      if (prop in target) return target[prop as keyof typeof target]
      if (String(prop).startsWith('on')) return () => () => {}
      return async () => undefined
    }
  })
  ;(window as unknown as { sgDesktop: unknown }).sgDesktop = api
}

let container: HTMLDivElement
let root: Root

function handoffButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button.composer-tool'))
    .find((element) => element.textContent?.trim() === '交接')
  if (!button) throw new Error('handoff button not rendered')
  return button
}

async function renderApp(hash: string): Promise<void> {
  window.location.hash = hash
  root = createRoot(container)
  await act(async () => { root.render(<App />) })
  await act(async () => {})
  await act(async () => {})
}

async function click(element: Element): Promise<void> {
  await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })) })
  await act(async () => {})
}

describe('App 会话页「交接」入口分流', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    getManualHandoffOptions.mockClear()
    getSessionHandoffContext.mockClear()
    if (!window.Element.prototype.scrollTo) window.Element.prototype.scrollTo = () => {}
    if (!window.matchMedia) {
      window.matchMedia = (() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
    }
    installDesktopMock()
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
    window.location.hash = ''
    localStorage.clear()
  })

  it('在线团队席位：按钮可用，打开上下文交接弹窗并按通道解析上下文', async () => {
    await renderApp('#sessions:2')
    const button = handoffButton()
    expect(button.disabled).toBe(false)
    expect(button.title).toBe(CONTEXT_HANDOFF_TITLE_TEAM)
    await click(button)
    expect(container.querySelector('.session-handoff')?.textContent).toContain('交接会话上下文')
    expect(getSessionHandoffContext).toHaveBeenCalledWith({ channelId: '2' })
    expect(getManualHandoffOptions).not.toHaveBeenCalled()
  })

  it('离线团队席位（运行中）：按钮走职责迁移弹窗，并提供随迁移交接上下文的选项', async () => {
    await renderApp('#sessions:5')
    const button = handoffButton()
    expect(button.disabled).toBe(false)
    expect(button.title).toBe(ROLES_HANDOFF_TITLE)
    await click(button)
    expect(getManualHandoffOptions).toHaveBeenCalledWith('slot-reviewer')
    const dialog = container.querySelector('.handoff-dialog:not(.session-handoff)')
    expect(dialog?.textContent).toContain('交接 质量验证')
    expect(dialog?.textContent).toContain('同时交接上下文文档')
    expect(getSessionHandoffContext).not.toHaveBeenCalled()
  })
})
