// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResizableColumns } from '../src/renderer/src/ResizableColumns'

describe('ResizableColumns collapsible first pane', () => {
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

  /**
   * 首栏收起与末栏收起同一套机制：首栏与分隔条留在网格里（轨道数不变，CSS 才能对
   * grid-template-columns 做滑动过渡），子树不重挂载；分隔条退出可达性树与 Tab 序列。
   */
  it('keeps a collapsed first pane and its divider in the grid so the track can slide', async () => {
    const render = (collapsed: boolean) => (
      <ResizableColumns
        finalPaneMinSize={420}
        firstPaneCollapsed={collapsed}
        paneSpecs={[{ defaultSize: 326, minSize: 286, maxSize: 420 }]}
        storageKey="collapse-test"
      >
        <aside>sessions</aside><main>content</main>
      </ResizableColumns>
    )
    const root = createRoot(container)
    await act(async () => root.render(render(false)))
    const layout = container.querySelector('.resizable-columns')!
    const sidebar = layout.children[0]
    const divider = layout.children[1]
    expect(layout.classList.contains('is-first-pane-collapsed')).toBe(false)
    expect(divider?.getAttribute('aria-hidden')).toBeNull()
    expect(divider?.getAttribute('tabindex')).toBeNull()

    await act(async () => root.render(render(true)))
    expect(layout.classList.contains('is-first-pane-collapsed')).toBe(true)
    expect(layout.childElementCount).toBe(3)
    expect(layout.children[0]).toBe(sidebar)
    expect(layout.children[1]).toBe(divider)
    expect(container.textContent).toContain('sessions')
    expect(divider?.getAttribute('aria-hidden')).toBe('true')
    expect(divider?.getAttribute('tabindex')).toBe('-1')
    expect(container.querySelector('.resizable-pane-toggle')).toBeNull()

    await act(async () => root.render(render(false)))
    expect(layout.classList.contains('is-first-pane-collapsed')).toBe(false)
    expect(layout.children[0]).toBe(sidebar)
    expect(divider?.getAttribute('aria-hidden')).toBeNull()
    expect(divider?.getAttribute('tabindex')).toBeNull()
    await act(async () => root.unmount())
  })

  it('ignores the first-pane collapse at the compact breakpoint where the grid stacks', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: query === '(max-width: 760px)', addEventListener: () => {}, removeEventListener: () => {} })
    })
    const root = createRoot(container)
    await act(async () => root.render(
      <ResizableColumns
        finalPaneMinSize={420}
        firstPaneCollapsed
        paneSpecs={[{ defaultSize: 326, minSize: 286, maxSize: 420 }]}
        storageKey="collapse-compact-test"
      >
        <aside>sessions</aside><main>content</main>
      </ResizableColumns>
    ))
    const layout = container.querySelector('.resizable-columns')!
    expect(layout.classList.contains('is-first-pane-collapsed')).toBe(false)
    expect(layout.children[1]?.getAttribute('aria-hidden')).toBeNull()
    await act(async () => root.unmount())
  })

  it('supports a fixed right pane without changing the existing left-pane contract', async () => {
    const root = createRoot(container)
    await act(async () => root.render(
      <ResizableColumns
        finalPaneMinSize={400}
        fixedPaneSide="end"
        paneSpecs={[{ defaultSize: 420, minSize: 300, maxSize: 720 }]}
        storageKey="right-pane-test"
      >
        <main>conversation</main><aside>review</aside>
      </ResizableColumns>
    ))
    const layout = container.querySelector('.resizable-columns')
    expect(layout?.classList.contains('is-fixed-end')).toBe(true)
    expect(layout?.children[0]?.textContent).toBe('conversation')
    expect(layout?.children[1]?.getAttribute('role')).toBe('separator')
    expect(layout?.children[2]?.textContent).toBe('review')
    await act(async () => root.unmount())
  })

})
