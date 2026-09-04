// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import { DesktopShell } from '../src/renderer/src/DesktopShell'

const snapshot: DesktopSnapshot = {
  connection: { state: 'connected', endpoint: 'local', attempt: 0, lastError: '' },
  sessions: [], conversations: {}, protocolIssues: [], updatedAt: 1
}

describe('DesktopShell right workspace dock', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
    })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    localStorage.clear()
  })

  it('opens and closes the fixed right pane from the topbar while persisting the preference', async () => {
    const root = createRoot(container)
    await act(async () => root.render(
      <DesktopShell
        snapshot={snapshot}
        activeModule="sessions"
        sidebar={<aside>会话栏</aside>}
        rightPanel={(close) => <aside><span>Review 内容</span><button onClick={close}>关闭 Review</button></aside>}
        cardOpacity={1}
        colorMode="light"
        onModuleChange={() => {}}
        onDetectedWorkspaceClick={() => {}}
        onCardOpacityChange={() => {}}
        onColorModeChange={() => {}}
      >
        <section>会话内容</section>
      </DesktopShell>
    ))
    expect(container.textContent).not.toContain('Review 内容')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开右侧工作区"]')!.click())
    expect(container.textContent).toContain('Review 内容')
    expect(container.querySelector('.workspace-dock.is-fixed-end')).toBeTruthy()
    expect(container.querySelector('.desktop-body.has-workspace-inspector')).toBeTruthy()
    expect(localStorage.getItem('qingtian-team.layout:v1:workspace-inspector:open')).toBe('1')
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '关闭 Review')!.click())
    expect(container.textContent).not.toContain('Review 内容')
    expect(localStorage.getItem('qingtian-team.layout:v1:workspace-inspector:open')).toBe('0')
    await act(async () => root.unmount())
  })
})
