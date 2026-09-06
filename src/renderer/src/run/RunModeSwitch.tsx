import { useLayoutEffect, useRef, useState } from 'react'
import type { WorkspaceRunMode } from '../../../domain/team-control'
import { SoloIcon, TeamIcon } from '../UiIcons'

export const RUN_MODE_LABEL: Record<WorkspaceRunMode, string> = {
  team: '团队',
  independent: '独立'
}

export const RUN_MODE_DESCRIPTION: Record<WorkspaceRunMode, string> = {
  team: '主控 + 成员，共享任务板，围绕一个目标协作',
  independent: '多个常驻会话，各自只听你的消息，互不干扰'
}

interface RunModeSwitchProps {
  value: WorkspaceRunMode
  disabled?: boolean
  /** 紧凑：只在头部作为模式切换器；默认带说明文字，用于开始运行。 */
  compact?: boolean
  onChange: (mode: WorkspaceRunMode) => void
}

const ORDER: WorkspaceRunMode[] = ['team', 'independent']

/** 分段控件：两种运行模式互斥，指示块滑到选中项，语义上是同一槽位的两个取值。 */
export function RunModeSwitch({ value, disabled = false, compact = false, onChange }: RunModeSwitchProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<Map<WorkspaceRunMode, HTMLButtonElement>>(new Map())
  const [indicator, setIndicator] = useState<{ left: number; width: number }>()

  useLayoutEffect(() => {
    const list = listRef.current
    const active = buttonRefs.current.get(value)
    if (!list || !active) return
    const measure = (): void => {
      const width = active.offsetWidth
      setIndicator(width > 0 ? { left: active.offsetLeft, width } : undefined)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    observer.observe(active)
    return () => observer.disconnect()
  }, [value, compact])

  return (
    <div
      ref={listRef}
      className={`run-mode-switch${compact ? ' is-compact' : ''}`}
      role="radiogroup"
      aria-label="运行模式"
    >
      {indicator ? (
        <span
          aria-hidden="true"
          className="run-mode-switch__indicator"
          style={{ transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px` }}
        />
      ) : null}
      {ORDER.map((mode) => (
        <button
          key={mode}
          ref={(node) => { if (node) buttonRefs.current.set(mode, node); else buttonRefs.current.delete(mode) }}
          type="button"
          role="radio"
          aria-checked={value === mode}
          className={value === mode ? 'is-active' : ''}
          disabled={disabled}
          onClick={() => { if (mode !== value) onChange(mode) }}
        >
          {mode === 'team' ? <TeamIcon /> : <SoloIcon />}
          <span>
            <b>{RUN_MODE_LABEL[mode]}</b>
            {!compact ? <small>{RUN_MODE_DESCRIPTION[mode]}</small> : null}
          </span>
        </button>
      ))}
    </div>
  )
}
