import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type UIEvent, type WheelEvent } from 'react'

const BOTTOM_THRESHOLD_PX = 72

export function isNearScrollBottom(element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX
}

/**
 * 对话贴底状态机：内容增长只在 follow=true 时贴底；只有明确的用户滚动意图会暂停，
 * 程序设置 scrollTop 及内容扩高不会反过来误关 follow。
 */
export function useBottomFollow(resetKey: string, contentKey: string) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const pointerActive = useRef(false)
  const downwardIntent = useRef(false)
  const lastScrollTop = useRef(0)
  const [awayFromBottom, setAwayFromBottom] = useState(false)

  const scrollToBottom = useCallback((): void => {
    const element = viewportRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    lastScrollTop.current = element.scrollTop
  }, [])

  const followContent = useCallback((): void => {
    if (following.current) scrollToBottom()
  }, [scrollToBottom])

  useLayoutEffect(() => {
    following.current = true
    downwardIntent.current = false
    setAwayFromBottom(false)
    scrollToBottom()
  }, [resetKey, scrollToBottom])

  useLayoutEffect(() => {
    followContent()
  }, [contentKey, followContent])

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(followContent)
    observer.observe(content)
    return () => observer.disconnect()
  }, [followContent])

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget
    const nearBottom = isNearScrollBottom(element)
    const movedUp = element.scrollTop < lastScrollTop.current - 0.5
    const movedDown = element.scrollTop > lastScrollTop.current + 0.5
    if (pointerActive.current && movedUp) {
      following.current = false
      downwardIntent.current = false
      setAwayFromBottom(true)
    } else if (nearBottom && (following.current || downwardIntent.current || (pointerActive.current && movedDown))) {
      following.current = true
      downwardIntent.current = false
      setAwayFromBottom(false)
    } else if (!following.current) {
      setAwayFromBottom(true)
    }
    lastScrollTop.current = element.scrollTop
  }, [])

  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>): void => {
    if (event.deltaY < 0) {
      following.current = false
      downwardIntent.current = false
      setAwayFromBottom(true)
    } else if (event.deltaY > 0) {
      downwardIntent.current = true
    }
  }, [])

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    pointerActive.current = true
    lastScrollTop.current = event.currentTarget.scrollTop
  }, [])

  const onPointerUp = useCallback((_event: PointerEvent<HTMLDivElement>): void => {
    pointerActive.current = false
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
      downwardIntent.current = false
      following.current = false
      setAwayFromBottom(true)
    } else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) {
      downwardIntent.current = true
    }
  }, [])

  const jumpToBottom = useCallback((): void => {
    following.current = true
    downwardIntent.current = false
    setAwayFromBottom(false)
    scrollToBottom()
  }, [scrollToBottom])

  const beginFollowing = useCallback((): void => {
    following.current = true
    downwardIntent.current = false
    setAwayFromBottom(false)
  }, [])

  return {
    viewportRef,
    contentRef,
    awayFromBottom,
    onScroll,
    onWheel,
    onPointerDown,
    onPointerUp,
    onKeyDown,
    jumpToBottom,
    beginFollowing
  }
}
