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

  it('collapses to a floating restore control, persists the choice, and restores the saved pane width', async () => {
    const render = () => (
      <ResizableColumns
        finalPaneMinSize={420}
        paneSpecs={[{ defaultSize: 326, minSize: 286, maxSize: 420 }]}
        storageKey="collapse-test"
        firstPaneCollapsible={{ collapseLabel: '收起会话列表', expandLabel: '展开会话列表' }}
      >
        <aside>sessions</aside><main>content</main>
      </ResizableColumns>
    )
    let root = createRoot(container)
    await act(async () => root.render(render()))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="收起会话列表"]')!.click())
    expect(container.querySelector('.resizable-columns')?.classList.contains('is-first-pane-collapsed')).toBe(true)
    expect(container.textContent).not.toContain('sessions')
    expect(container.querySelector('.resizable-collapsed-rail')).toBeNull()
    expect(container.querySelector('.resizable-pane-toggle--expand')).toBeTruthy()
    expect(localStorage.getItem('qingtian-team.layout:v1:collapse-test:collapsed')).toBe('1')

    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(render()))
    expect(container.querySelector<HTMLButtonElement>('[aria-label="展开会话列表"]')).toBeTruthy()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开会话列表"]')!.click())
    expect(container.textContent).toContain('sessions')
    expect(localStorage.getItem('qingtian-team.layout:v1:collapse-test:collapsed')).toBe('0')
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

  it('temporarily collapses the first pane without persisting over the user preference', async () => {
    let forcedExpand = 0
    const root = createRoot(container)
    await act(async () => root.render(
      <ResizableColumns
        finalPaneMinSize={420}
        forceFirstPaneCollapsed
        onForcedFirstPaneExpand={() => { forcedExpand += 1 }}
        paneSpecs={[{ defaultSize: 326, minSize: 286, maxSize: 420 }]}
        storageKey="forced-collapse-test"
        firstPaneCollapsible={{ collapseLabel: '收起会话列表', expandLabel: '展开会话列表' }}
      >
        <aside>sessions</aside><main>content</main>
      </ResizableColumns>
    ))
    expect(container.textContent).not.toContain('sessions')
    expect(localStorage.getItem('qingtian-team.layout:v1:forced-collapse-test:collapsed')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开会话列表"]')!.click())
    expect(forcedExpand).toBe(1)
    expect(localStorage.getItem('qingtian-team.layout:v1:forced-collapse-test:collapsed')).toBeNull()
    await act(async () => root.unmount())
  })
})
