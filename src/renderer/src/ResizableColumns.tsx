import {
  Children,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import {
  defaultPaneSizes,
  fitPaneSizes,
  resizePane,
  type ResizablePaneSpec
} from './resizable-layout'

interface ResizableColumnsProps {
  children: ReactNode
  className?: string
  dividerLabels?: string[]
  finalPaneMinSize: number
  paneSpecs: readonly ResizablePaneSpec[]
  storageKey: string
  firstPaneCollapsible?: {
    collapseLabel: string
    expandLabel: string
  }
}

const STORAGE_PREFIX = 'qingtian-team.layout:v1:'

function readStoredSizes(storageKey: string, specs: readonly ResizablePaneSpec[]): number[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${storageKey}`) ?? 'null') as unknown
    if (!Array.isArray(parsed) || parsed.length !== specs.length) return defaultPaneSizes(specs)
    return specs.map((spec, index) => {
      const value = parsed[index]
      return typeof value === 'number' && Number.isFinite(value) ? value : spec.defaultSize
    })
  } catch {
    return defaultPaneSizes(specs)
  }
}

function storeSizes(storageKey: string, sizes: readonly number[]): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${storageKey}`, JSON.stringify(sizes.map(Math.round)))
  } catch {
    // The layout remains usable when storage is disabled or full.
  }
}

function readCollapsed(storageKey: string): boolean {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${storageKey}:collapsed`) === '1'
  } catch {
    return false
  }
}

function storeCollapsed(storageKey: string, collapsed: boolean): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${storageKey}:collapsed`, collapsed ? '1' : '0')
  } catch { /* 当前运行内仍然生效。 */ }
}

function PaneToggleIcon({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.5" y="2.5" width="15" height="15" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7 3v14" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d={collapsed ? 'm10.5 7 3 3-3 3' : 'm13.5 7-3 3 3 3'} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
    </svg>
  )
}

function sizesEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function ResizableColumns({
  children,
  className = '',
  dividerLabels = [],
  finalPaneMinSize,
  paneSpecs,
  storageKey,
  firstPaneCollapsible
}: ResizableColumnsProps): React.JSX.Element {
  const items = Children.toArray(children)
  const collapsible = firstPaneCollapsible !== undefined && items.length === 2
  const [committedSizes, setCommittedSizes] = useState(() => readStoredSizes(storageKey, paneSpecs))
  const [firstPaneCollapsed, setFirstPaneCollapsed] = useState(() => (
    collapsible ? readCollapsed(storageKey) : false
  ))
  const [compactLayout, setCompactLayout] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px)').matches === true
  ))
  const containerRef = useRef<HTMLDivElement>(null)
  const sizesRef = useRef(committedSizes)
  const specsRef = useRef(paneSpecs)
  const finalMinRef = useRef(finalPaneMinSize)
  const dragCleanupRef = useRef<(() => void) | undefined>(undefined)
  specsRef.current = paneSpecs
  finalMinRef.current = finalPaneMinSize

  const applySizes = useCallback((sizes: readonly number[]): void => {
    sizesRef.current = [...sizes]
    const container = containerRef.current
    if (!container) return
    sizes.forEach((size, index) => {
      container.style.setProperty(`--resizable-pane-${index}`, `${Math.round(size)}px`)
      const divider = container.querySelector<HTMLElement>(`[data-resize-divider="${index}"]`)
      divider?.setAttribute('aria-valuenow', String(Math.round(size)))
    })
  }, [])

  const commitSizes = useCallback((sizes: readonly number[]): void => {
    const next = [...sizes]
    applySizes(next)
    setCommittedSizes(next)
    storeSizes(storageKey, next)
  }, [applySizes, storageKey])

  useLayoutEffect(() => {
    applySizes(committedSizes)
  }, [applySizes, committedSizes])

  useEffect(() => {
    const next = readStoredSizes(storageKey, specsRef.current)
    sizesRef.current = next
    setCommittedSizes(next)
    setFirstPaneCollapsed(collapsible ? readCollapsed(storageKey) : false)
  }, [collapsible, storageKey])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia('(max-width: 760px)')
    const update = (): void => setCompactLayout(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? container.clientWidth
      const fitted = fitPaneSizes(committedSizes, specsRef.current, width, finalMinRef.current)
      // Responsive fitting is temporary. Persisting it would overwrite the
      // user's preferred pane width whenever the app window becomes narrow.
      if (!sizesEqual(fitted, sizesRef.current)) applySizes(fitted)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [applySizes, committedSizes])

  useEffect(() => () => dragCleanupRef.current?.(), [])

  const beginResize = (index: number, event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    dragCleanupRef.current?.()
    const container = containerRef.current
    if (!container) return
    const startX = event.clientX
    const startSize = sizesRef.current[index] ?? specsRef.current[index]?.defaultSize ?? 0
    const pointerId = event.pointerId
    event.currentTarget.setPointerCapture?.(pointerId)
    document.body.classList.add('is-resizing-columns')

    const move = (moveEvent: PointerEvent): void => {
      const next = resizePane(
        sizesRef.current,
        specsRef.current,
        index,
        startSize + moveEvent.clientX - startX,
        container.getBoundingClientRect().width,
        finalMinRef.current
      )
      applySizes(next)
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.classList.remove('is-resizing-columns')
      dragCleanupRef.current = undefined
    }
    const finish = (): void => {
      cleanup()
      commitSizes(sizesRef.current)
    }
    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  const resizeWithKeyboard = (index: number, event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return
    event.preventDefault()
    const containerWidth = containerRef.current?.getBoundingClientRect().width ?? window.innerWidth
    const requested = event.key === 'Home'
      ? specsRef.current[index]?.defaultSize ?? sizesRef.current[index] ?? 0
      : (sizesRef.current[index] ?? 0) + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10)
    commitSizes(resizePane(
      sizesRef.current,
      specsRef.current,
      index,
      requested,
      containerWidth,
      finalMinRef.current
    ))
  }

  const resetDivider = (index: number): void => {
    const containerWidth = containerRef.current?.getBoundingClientRect().width ?? window.innerWidth
    commitSizes(resizePane(
      sizesRef.current,
      specsRef.current,
      index,
      specsRef.current[index]?.defaultSize ?? 0,
      containerWidth,
      finalMinRef.current
    ))
  }

  const style = {
    '--resizable-final-min': `${finalPaneMinSize}px`,
    ...Object.fromEntries(sizesRef.current.map((size, index) => [`--resizable-pane-${index}`, `${size}px`]))
  } as CSSProperties
  const collapsed = collapsible && firstPaneCollapsed && !compactLayout
  const setCollapsed = (value: boolean): void => {
    setFirstPaneCollapsed(value)
    storeCollapsed(storageKey, value)
  }

  return (
    <div
      className={`resizable-columns resizable-columns--${items.length}${collapsed ? ' is-first-pane-collapsed' : ''} ${className}`.trim()}
      ref={containerRef}
      style={style}
    >
      {collapsed ? (
        <>
          <aside className="resizable-collapsed-rail">
            <button
              className="resizable-pane-toggle"
              aria-label={firstPaneCollapsible!.expandLabel}
              title={firstPaneCollapsible!.expandLabel}
              onClick={() => setCollapsed(false)}
            ><PaneToggleIcon collapsed /></button>
          </aside>
          {items.at(-1)}
        </>
      ) : items.flatMap((item, index) => {
        const output: ReactNode[] = [item]
        if (index < items.length - 1) {
          const spec = paneSpecs[index]
          output.push(
            <button
              aria-label={dividerLabels[index] ?? `调整第 ${index + 1} 栏宽度`}
              aria-orientation="vertical"
              aria-valuemax={spec?.maxSize}
              aria-valuemin={spec?.minSize}
              aria-valuenow={Math.round(sizesRef.current[index] ?? spec?.defaultSize ?? 0)}
              className="resizable-divider"
              data-resize-divider={index}
              key={`divider-${index}`}
              role="separator"
              title="拖拽调整宽度；双击恢复默认"
              onDoubleClick={() => resetDivider(index)}
              onKeyDown={(event) => resizeWithKeyboard(index, event)}
              onPointerDown={(event) => beginResize(index, event)}
            />
          )
        }
        return output
      })}
      {!collapsed && collapsible ? (
        <button
          className="resizable-pane-toggle resizable-pane-toggle--collapse"
          aria-label={firstPaneCollapsible.collapseLabel}
          title={firstPaneCollapsible.collapseLabel}
          onClick={() => setCollapsed(true)}
        ><PaneToggleIcon collapsed={false} /></button>
      ) : null}
    </div>
  )
}
