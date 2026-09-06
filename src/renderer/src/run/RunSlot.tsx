import { useEffect, useState, type ReactNode } from 'react'

const COLLAPSE_MS = 240

interface RunSlotProps {
  /** 有内容即展开；为 null 时收起，内容在过渡结束后再卸载。 */
  children: ReactNode | null
}

/**
 * 可折叠插槽：确认面、提示条这类"有时出现"的内容通过它进入版面，
 * 高度用 grid-template-rows 0fr↔1fr 过渡，下方内容随之滑动而不是跳动。
 */
export function RunSlot({ children }: RunSlotProps): React.JSX.Element {
  const open = children !== null && children !== undefined && children !== false
  const [rendered, setRendered] = useState<ReactNode>(open ? children : null)

  useEffect(() => {
    if (open) {
      setRendered(children)
      return
    }
    const timer = setTimeout(() => setRendered(null), COLLAPSE_MS)
    return () => clearTimeout(timer)
  }, [children, open])

  return (
    <div className={`run-slot${open ? ' is-open' : ''}`} aria-hidden={!open}>
      <div className="run-slot__inner" inert={!open}>
        {open ? children : rendered}
      </div>
    </div>
  )
}
