import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent
} from 'react'
import { createPortal } from 'react-dom'
import type { ContextUsage, ContextUsageCategory } from '../../domain/agent-session'
import { contextPercent, contextTone, formatTokenCount } from './format'

interface ContextUsagePopoverProps {
  usage?: ContextUsage
}

const CATEGORY_TONES: Record<string, string> = {
  system_prompt: 'system',
  tools: 'tools',
  rules: 'rules',
  skills: 'skills',
  mcp: 'mcp',
  subagents: 'subagents',
  summarized_conversation: 'summary',
  conversation: 'conversation'
}

function compactPercent(value?: number): string {
  if (value === undefined) return '待读取'
  return `${value.toFixed(1).replace(/\.0$/, '')}%`
}

function categoryTone(category: ContextUsageCategory): string {
  return CATEGORY_TONES[category.id] ?? 'other'
}

export function ContextUsagePopover({ usage }: ContextUsagePopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 12, bottom: 12, width: 420 })
  const titleId = useId()
  const popoverId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const percent = contextPercent(usage)
  const tone = contextTone(percent)
  const breakdown = usage?.breakdown
  const used = breakdown?.totalUsedTokens ?? usage?.used
  const limit = breakdown?.maxTokens ?? usage?.limit
  const categories = breakdown?.categories ?? []
  const categoryTotal = categories.reduce((total, category) => total + category.estimatedTokens, 0)
  const remaining = Math.max(0, (limit ?? categoryTotal) - categoryTotal)

  const cancelClose = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = undefined
  }
  useLayoutEffect(() => cancelClose, [])
  const show = (): void => {
    cancelClose()
    setOpen(true)
  }
  const close = (): void => {
    cancelClose()
    setOpen(false)
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 120)
  }
  const closeOnFocusExit = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget
    if (next && (event.currentTarget.contains(next) || popoverRef.current?.contains(next))) return
    scheduleClose()
  }

  useLayoutEffect(() => {
    if (!open) return
    const update = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const margin = 12
      const width = Math.min(440, window.innerWidth - margin * 2)
      setPosition({
        left: Math.max(margin, Math.min(rect.right - width + 8, window.innerWidth - width - margin)),
        bottom: Math.max(margin, window.innerHeight - rect.top + 12),
        width
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  return (
    <div
      className="context-meter"
      onMouseEnter={show}
      onMouseLeave={scheduleClose}
      onFocusCapture={show}
      onBlurCapture={closeOnFocusExit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`composer-context ${percent === undefined ? 'is-unknown' : ''} ${tone ? `is-${tone}` : ''}`}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-haspopup="dialog"
        aria-label={`上下文占用 ${compactPercent(percent)}，查看原生统计`}
        onClick={() => setOpen((value) => !value)}
      >
        <svg className="composer-context-ring" viewBox="0 0 32 32" aria-hidden="true">
          <circle className="composer-context-ring__track" cx="16" cy="16" r="13" />
          {percent !== undefined && percent > 0 ? (
            <circle className="composer-context-ring__progress" cx="16" cy="16" r="13"
              pathLength="100" strokeDasharray={`${percent} 100`} />
          ) : null}
        </svg>
        <span>上下文 {compactPercent(percent)}</span>
      </button>

      {open ? createPortal(
        <section
          ref={popoverRef}
          id={popoverId}
          className="context-popover"
          role="dialog"
          aria-labelledby={titleId}
          style={{ left: position.left, bottom: position.bottom, width: position.width }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <header>
            <strong id={titleId}>Context</strong>
            <button type="button" aria-label="关闭上下文统计" onClick={close}>×</button>
          </header>
          <div className="context-popover__summary">
            <b>{percent === undefined ? 'Usage pending' : `${Math.round(percent)}% Full`}</b>
            <span>{used === undefined || limit === undefined
              ? 'Token totals pending'
              : `~${formatTokenCount(used)} / ${formatTokenCount(limit)} Tokens`}</span>
          </div>
          <div className="context-breakdown-bar" aria-hidden="true">
            {categories.filter((category) => category.estimatedTokens > 0).map((category) => (
              <i
                className={`is-${categoryTone(category)}`}
                key={category.id}
                style={{ '--context-segment-grow': category.estimatedTokens } as CSSProperties}
              />
            ))}
            <i className="is-remaining" style={{ '--context-segment-grow': remaining || 1 } as CSSProperties} />
          </div>
          {categories.length ? (
            <ul className="context-breakdown-list">
              {categories.map((category) => (
                <li key={category.id}>
                  <i className={`is-${categoryTone(category)}`} aria-hidden="true" />
                  <span>{category.label}</span>
                  <b>{formatTokenCount(category.estimatedTokens)}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p className="context-popover__empty">等待 Cursor 写入分类统计；总占用仍按原生数据实时显示。</p>
          )}
        </section>,
        document.body
      ) : null}
    </div>
  )
}
