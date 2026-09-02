// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBottomFollow } from '../src/renderer/src/use-bottom-follow'

function Harness({ contentKey }: { contentKey: string }): React.JSX.Element {
  const follow = useBottomFollow('session-1', contentKey)
  return (
    <div>
      <div
        data-testid="viewport"
        ref={follow.viewportRef}
        onScroll={follow.onScroll}
        onWheel={follow.onWheel}
        onPointerDown={follow.onPointerDown}
        onPointerUp={follow.onPointerUp}
      >
        <div ref={follow.contentRef}>content</div>
      </div>
      <output>{follow.awayFromBottom ? 'away' : 'following'}</output>
      <button onClick={follow.jumpToBottom}>bottom</button>
    </div>
  )
}

function StrictHarness({ contentKey }: { contentKey: string }): React.JSX.Element {
  return <StrictMode><Harness contentKey={contentKey} /></StrictMode>
}

describe('useBottomFollow', () => {
  let container: HTMLDivElement
  let root: Root
  let height = 1_000
  let resize: (() => void) | undefined

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    height = 1_000
    resize = undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe(): void {}
      disconnect(): void {}
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  const viewport = (): HTMLDivElement => {
    const element = container.querySelector<HTMLDivElement>('[data-testid="viewport"]')!
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, get: () => 300 }
    })
    return element
  }

  it('follows streaming growth, pauses on user upward intent, and resumes at the bottom', async () => {
    await act(async () => root.render(<StrictHarness contentKey="a" />))
    const element = viewport()

    await act(async () => root.render(<StrictHarness contentKey="b" />))
    expect(element.scrollTop).toBe(1_000)

    await act(async () => element.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true })))
    expect(container.textContent).toContain('away')
    element.scrollTop = 420
    height = 1_200
    await act(async () => root.render(<StrictHarness contentKey="c" />))
    expect(element.scrollTop).toBe(420)

    await act(async () => element.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true })))
    element.scrollTop = 900
    await act(async () => element.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(container.textContent).toContain('following')
    height = 1_300
    await act(async () => root.render(<StrictHarness contentKey="d" />))
    expect(element.scrollTop).toBe(1_300)
  })

  it('keeps a small upward scroll paused across ResizeObserver growth', async () => {
    await act(async () => root.render(<StrictHarness contentKey="a" />))
    const element = viewport()
    await act(async () => root.render(<StrictHarness contentKey="b" />))
    expect(element.scrollTop).toBe(1_000)

    await act(async () => element.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true })))
    element.scrollTop = 660 // 距底部仅 40px，仍应尊重明确的向上意图
    await act(async () => element.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(container.textContent).toContain('away')

    height = 1_100
    await act(async () => resize?.())
    expect(element.scrollTop).toBe(660)

    await act(async () => element.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true })))
    element.scrollTop = 800
    await act(async () => element.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(container.textContent).toContain('following')
  })
})
