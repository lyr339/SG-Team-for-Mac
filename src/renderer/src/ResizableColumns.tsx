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
  /** 两栏布局中固定宽度栏所在边；默认左侧。 */
  fixedPaneSide?: 'start' | 'end'
  /** 首栏收起态由外层导航控制；组件只负责布局。 */
  firstPaneCollapsed?: boolean
  /**
   * 末栏收起（仅 fixedPaneSide='end' 的两栏布局）：末栏与分隔条的轨道收到 0，但都留在网格里，
   * 轨道数不变，CSS 才能对 grid-template-columns 做滑动过渡；末栏子树保持挂载，
   * 由调用方设置 inert / aria-hidden。`--resizable-pane-0` 仍是末栏的真实宽度，
   * 末栏内容据此保持固定宽度，收合过程是被裁切而不是被挤压。
   */
  endPaneCollapsed?: boolean
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
  fixedPaneSide = 'start',
  firstPaneCollapsed = false,
  endPaneCollapsed = false
}: ResizableColumnsProps): React.JSX.Element {
  const items = Children.toArray(children)
  const [committedSizes, setCommittedSizes] = useState(() => readStoredSizes(storageKey, paneSpecs))
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
  }, [storageKey])

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
      const direction = fixedPaneSide === 'end' && items.length === 2 ? -1 : 1
      const next = resizePane(
        sizesRef.current,
        specsRef.current,
        index,
        startSize + direction * (moveEvent.clientX - startX),
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
      : (sizesRef.current[index] ?? 0)
        + (event.key === 'ArrowRight' ? 1 : -1)
          * (fixedPaneSide === 'end' && items.length === 2 ? -1 : 1)
          * (event.shiftKey ? 40 : 10)
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
  const collapsed = items.length === 2 && firstPaneCollapsed && !compactLayout
  const endCollapsed = items.length === 2 && fixedPaneSide === 'end' && endPaneCollapsed

  return (
    <div
      className={`resizable-columns resizable-columns--${items.length}${fixedPaneSide === 'end' && items.length === 2 ? ' is-fixed-end' : ''}${collapsed ? ' is-first-pane-collapsed' : ''}${endCollapsed ? ' is-end-pane-collapsed' : ''} ${className}`.trim()}
      ref={containerRef}
      style={style}
    >
      {collapsed ? items.at(-1) : items.flatMap((item, index) => {
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
              aria-hidden={endCollapsed || undefined}
              className="resizable-divider"
              data-resize-divider={index}
              key={`divider-${index}`}
              role="separator"
              tabIndex={endCollapsed ? -1 : undefined}
              title="拖拽调整宽度；双击恢复默认"
              onDoubleClick={() => resetDivider(index)}
              onKeyDown={(event) => resizeWithKeyboard(index, event)}
              onPointerDown={(event) => beginResize(index, event)}
            />
          )
        }
        return output
      })}
    </div>
  )
}
