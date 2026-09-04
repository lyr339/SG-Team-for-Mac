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

  it('applies an externally controlled first-pane collapse without rendering a duplicate toggle', async () => {
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
    await act(async () => root.render(render(true)))
    expect(container.querySelector('.resizable-columns')?.classList.contains('is-first-pane-collapsed')).toBe(true)
    expect(container.textContent).not.toContain('sessions')
    expect(container.querySelector('.resizable-pane-toggle')).toBeNull()
    await act(async () => root.render(render(false)))
    expect(container.textContent).toContain('sessions')
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
