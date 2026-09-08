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

  /** 右栏收起 = 停靠栏轨道收到 0、面板 inert 且对辅助技术隐藏；子树保持挂载。 */
  function expectInspectorCollapsed(collapsed: boolean): void {
    const dock = container.querySelector('.workspace-dock.is-fixed-end')
    const pane = container.querySelector('.workspace-inspector-pane')
    expect(dock).toBeTruthy()
    expect(pane).toBeTruthy()
    expect(dock!.classList.contains('is-end-pane-collapsed')).toBe(collapsed)
    expect(pane!.hasAttribute('inert')).toBe(collapsed)
    expect(pane!.getAttribute('aria-hidden')).toBe(collapsed ? 'true' : 'false')
    expect(container.querySelector('.workspace-dock > .resizable-divider')?.getAttribute('aria-hidden')).toBe(collapsed ? 'true' : null)
  }

  /** 左栏收起 = 外层分栏首轨道收到 0、包裹层 inert 且对辅助技术隐藏；名册子树保持挂载。 */
  function expectSidebarCollapsed(collapsed: boolean): void {
    const columns = container.querySelector('.shell-columns.resizable-columns--2')
    const pane = container.querySelector('.session-sidebar-pane')
    expect(columns).toBeTruthy()
    expect(pane).toBeTruthy()
    expect(columns!.classList.contains('is-first-pane-collapsed')).toBe(collapsed)
    expect(pane!.hasAttribute('inert')).toBe(collapsed)
    expect(pane!.getAttribute('aria-hidden')).toBe(collapsed ? 'true' : 'false')
    expect(container.querySelector('.shell-columns > .resizable-divider')?.getAttribute('aria-hidden')).toBe(collapsed ? 'true' : null)
    expect(container.textContent).toContain('会话栏')
  }

  it('slides the right pane open and closed without remounting the session stage or the panel', async () => {
    const visibility: boolean[] = []
    const root = createRoot(container)
    await act(async () => root.render(
      <DesktopShell
        snapshot={snapshot}
        activeModule="sessions"
        sidebar={<aside>会话栏</aside>}
        rightPanel={(close, visible) => {
          visibility.push(visible)
          return <aside><span>Review 内容</span><button onClick={close}>关闭 Review</button></aside>
        }}
        cardOpacity={1}
        colorMode="light"
        onModuleChange={() => {}}
        onOpenProjectConfiguration={() => {}}
        onCardOpacityChange={() => {}}
        onColorModeChange={() => {}}
      >
        <section data-testid="stage">会话内容</section>
      </DesktopShell>
    ))
    expectSidebarCollapsed(false)
    expect(container.querySelectorAll('.panel-button')).toHaveLength(2)
    const stage = container.querySelector('[data-testid="stage"]')
    const panel = container.querySelector('.workspace-inspector-pane > aside')
    const sidebar = container.querySelector('.session-sidebar-pane > aside')
    expect(stage).toBeTruthy()
    expect(sidebar).toBeTruthy()
    // 默认收起：面板已在 DOM 里（状态常驻），但不可交互、不可见于辅助技术。
    expect(panel?.textContent).toContain('Review 内容')
    expectInspectorCollapsed(true)
    expect(visibility.at(-1)).toBe(false)

    // 左栏与右栏同一套：收起只收放轨道，名册仍是同一个 DOM 节点（滚动、拖拽手势、焦点漫游不丢）。
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="收起会话列表"]')!.click())
    expectSidebarCollapsed(true)
    expect(container.querySelector('.session-sidebar-pane > aside')).toBe(sidebar)
    expect(localStorage.getItem('sg-team.layout:v1:shell.sessions.v2:collapsed')).toBe('1')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开会话列表"]')!.click())
    expectSidebarCollapsed(false)
    expect(container.querySelector('.session-sidebar-pane > aside')).toBe(sidebar)
    expect(localStorage.getItem('sg-team.layout:v1:shell.sessions.v2:collapsed')).toBe('0')
    expectInspectorCollapsed(true)

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开右侧工作区"]')!.click())
    expectInspectorCollapsed(false)
    expect(visibility.at(-1)).toBe(true)
    expect(localStorage.getItem('sg-team.layout:v1:workspace-inspector:open')).toBe('1')
    // 开合前后中栏与面板都是同一个 DOM 节点：滚动位置、打字机缓冲、展开态得以保留。
    expect(container.querySelector('[data-testid="stage"]')).toBe(stage)
    expect(container.querySelector('.workspace-inspector-pane > aside')).toBe(panel)

    // 两栏开合互不干扰：左栏收起时右栏保持展开，中栏也不重挂载。
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="收起会话列表"]')!.click())
    expectSidebarCollapsed(true)
    expectInspectorCollapsed(false)
    expect(container.querySelector('[data-testid="stage"]')).toBe(stage)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开会话列表"]')!.click())
    expectSidebarCollapsed(false)
    expect(container.querySelector('[data-testid="stage"]')).toBe(stage)
    expect(container.querySelector('.session-sidebar-pane > aside')).toBe(sidebar)

    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '关闭 Review')!.click())
    expectInspectorCollapsed(true)
    expect(visibility.at(-1)).toBe(false)
    expect(localStorage.getItem('sg-team.layout:v1:workspace-inspector:open')).toBe('0')
    expect(container.querySelector('[data-testid="stage"]')).toBe(stage)
    expect(container.querySelector('.workspace-inspector-pane > aside')).toBe(panel)
    await act(async () => root.unmount())
  })

  it('toggles the right pane with Ctrl/⌘+\\ and ignores the shortcut without a right panel', async () => {
    const root = createRoot(container)
    const render = (withPanel: boolean): Promise<void> => act(async () => root.render(
      <DesktopShell
        snapshot={snapshot}
        activeModule="sessions"
        sidebar={<aside>会话栏</aside>}
        rightPanel={withPanel ? () => <aside>Review 内容</aside> : undefined}
        cardOpacity={1}
        colorMode="light"
        onModuleChange={() => {}}
        onOpenProjectConfiguration={() => {}}
        onCardOpacityChange={() => {}}
        onColorModeChange={() => {}}
      >
        <section>会话内容</section>
      </DesktopShell>
    ))
    await render(true)
    expectInspectorCollapsed(true)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', ctrlKey: true })) })
    expectInspectorCollapsed(false)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true })) })
    expectInspectorCollapsed(true)
    // 没有可停靠的面板（未选中会话）时快捷键无效，停靠栏保持收起且为空。
    await render(false)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', ctrlKey: true })) })
    expectInspectorCollapsed(true)
    expect(container.querySelector('.workspace-inspector-pane')?.childElementCount).toBe(0)
    await act(async () => root.unmount())
  })
  it('keeps compact-layout accessibility in sync and restores the desktop collapse preference', async () => {
    let compact = false
    const listeners = new Set<() => void>()
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({
      get matches() { return compact },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener)
    }) })
    localStorage.setItem('sg-team.layout:v1:shell.sessions.v2:collapsed', '1')
    const root = createRoot(container)
    await act(async () => root.render(
      <DesktopShell snapshot={snapshot} activeModule="sessions" sidebar={<aside>会话栏</aside>}
        cardOpacity={1} colorMode="light" onModuleChange={() => {}}
        onOpenProjectConfiguration={() => {}} onCardOpacityChange={() => {}} onColorModeChange={() => {}}>
        <main>正文</main>
      </DesktopShell>
    ))
    const sidebar = container.querySelector('.session-sidebar-pane > aside')!
    expectSidebarCollapsed(true)
    await act(async () => { compact = true; listeners.forEach(listener => listener()) })
    expectSidebarCollapsed(false)
    expect(container.querySelector('.session-sidebar-pane > aside')).toBe(sidebar)
    await act(async () => { compact = false; listeners.forEach(listener => listener()) })
    expectSidebarCollapsed(true)
    await act(async () => root.unmount())
    expect(listeners.size).toBe(0)
  })

})
