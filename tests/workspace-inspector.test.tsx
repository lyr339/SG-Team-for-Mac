// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import type { LiveProcessState } from '../src/shared/desktop-api'
import { WorkspaceInspector } from '../src/renderer/src/WorkspaceInspector'

const session: AgentSession = {
  id: 'session-2', channelId: '2', generation: 1, displayName: '实现席', roleName: '实现席',
  status: 'running', currentTask: '右栏', queueDepth: 0, connectionPhase: 'processing',
  online: true, connected: true, waiting: false, workingFiles: [], healthEvidence: []
}

const historical: ConversationEntry = {
  id: 'reply-1', channelId: '2', role: 'assistant', text: '完成', timestamp: 1,
  status: 'complete', source: 'cursor', processBlocks: [{
    kind: 'tool', id: 'old-todos', toolName: 'todos', toolKind: 'todo', status: 'done',
    todos: [{ content: '历史任务', status: 'completed' }]
  }]
}

function liveTodos(content = '实时任务'): LiveProcessState {
  return {
    turn: 'turn-2', startedAt: 2, updatedAt: 3,
    blocks: [{
      kind: 'tool', id: 'live-todos', toolName: 'todos', toolKind: 'todo', status: 'running',
      todos: [{ content, status: 'in_progress' }]
    }]
  }
}

describe('WorkspaceInspector Cursor Todos', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    localStorage.setItem('qingtian-team.inspector:active-tab', 'todos')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    localStorage.clear()
  })

  it('renders the live list in the dock and keeps the close action explicit', async () => {
    const onClose = vi.fn()
    const root = createRoot(container)
    await act(async () => root.render(
      <WorkspaceInspector
        session={session}
        entries={[historical]}
        liveProcess={liveTodos('实现真实 Review')}
        workspaceId="workspace-1"
        workspaceName="demo"
        onClose={onClose}
      />
    ))
    expect(container.textContent).toContain('Cursor Todos')
    expect(container.textContent).toContain('实现真实 Review')
    expect(container.textContent).toContain('0/1')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="收起右侧工作区"]')!.click())
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it('falls back to the latest persisted Todo list after the live turn is archived', async () => {
    const root = createRoot(container)
    await act(async () => root.render(
      <WorkspaceInspector
        session={session}
        entries={[historical]}
        workspaceId="workspace-1"
        onClose={() => {}}
      />
    ))
    expect(container.textContent).toContain('历史任务')
    expect(container.textContent).toContain('1/1')
    await act(async () => root.unmount())
  })

  it('does not carry an old Todo list into a newer live turn that has no Todo state', async () => {
    const root = createRoot(container)
    await act(async () => root.render(
      <WorkspaceInspector
        session={session}
        entries={[historical]}
        liveProcess={{ turn: 'new-turn', startedAt: 3, updatedAt: 4, blocks: [] }}
        workspaceId="workspace-1"
        onClose={() => {}}
      />
    ))
    expect(container.textContent).not.toContain('历史任务')
    expect(container.textContent).toContain('暂无任务清单')
    await act(async () => root.unmount())
  })
})
