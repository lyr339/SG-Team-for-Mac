import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * 右栏统一的空态 / 加载态 / 错误态：一个图标、一句标题、一句解释、可选的一个动作。
 * 空态必须「可行动」——告诉用户接下来什么事会让这里出现内容，或给一个能去的地方。
 * 非 compact 形态在面板剩余高度内垂直居中（面板是 flex 列，本组件 flex:1）。
 */
export function InspectorState({
  tone = 'neutral',
  icon,
  title,
  hint,
  action,
  compact = false
}: {
  tone?: 'neutral' | 'error' | 'loading'
  icon?: ReactNode
  title: string
  hint?: ReactNode
  action?: ReactNode
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className={`inspector-state is-${tone}${compact ? ' is-compact' : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone === 'loading'
        ? <span className="inspector-state__spinner" aria-hidden="true" />
        : icon ? <span className="inspector-state__icon" aria-hidden="true">{icon}</span> : null}
      <strong>{title}</strong>
      {hint ? <span>{hint}</span> : null}
      {action ? <div className="inspector-state__action">{action}</div> : null}
    </div>
  )
}

/** 面板顶部的小节头：标题 + 说明 + 右侧统计 / 控件。 */
export function InspectorSectionHeader({
  title,
  hint,
  aside
}: {
  title: ReactNode
  hint?: ReactNode
  aside?: ReactNode
}): React.JSX.Element {
  return (
    <header className="inspector-section__header">
      <div>
        <strong>{title}</strong>
        {hint ? <span>{hint}</span> : null}
      </div>
      {aside ? <div className="inspector-section__aside">{aside}</div> : null}
    </header>
  )
}

/** 列表内的分组标题（如活动面板的「文件 / 命令 / 来源」）。 */
export function InspectorGroupLabel({ children, count }: { children: ReactNode; count?: number }): React.JSX.Element {
  return (
    <div className="inspector-group-label">
      <span>{children}</span>
      {count !== undefined ? <b>{count}</b> : null}
    </div>
  )
}

/**
 * 面板底部的短暂反馈（复制成功 / 操作失败 / 定位结果）：绝对定位浮在内容之上，
 * 出现与消失都不改变列表布局。空串不渲染。
 */
export function InspectorToast({ message }: { message: string }): React.JSX.Element | null {
  if (!message) return null
  return <p className="inspector-toast" role="status">{message}</p>
}

/**
 * 读取中的占位骨架：几行不同宽度的灰条，代替一句「正在读取…」文字，
 * 让内容落位前后的高度与形态接近，减少一次性跳动。
 */
export function InspectorSkeleton({ rows = 3, mono = false }: { rows?: number; mono?: boolean }): React.JSX.Element {
  const widths = [72, 46, 88, 58, 64, 40]
  return (
    <div className={`inspector-skeleton${mono ? ' is-mono' : ''}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <i key={index} style={{ width: `${widths[index % widths.length]}%` }} />
      ))}
    </div>
  )
}

/** 短暂反馈（复制成功 / 操作失败）：1.6s 后自动清空；传空串立即清空。 */
export function useTransientFeedback(): [string, (message: string) => void] {
  const [value, setValue] = useState('')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])
  const flash = (message: string): void => {
    setValue(message)
    if (timer.current) window.clearTimeout(timer.current)
    if (message) timer.current = window.setTimeout(() => setValue(''), 1_600)
  }
  return [value, flash]
}
