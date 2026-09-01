import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent
} from 'react'
import { createPortal } from 'react-dom'
import type { CursorSessionUsage } from '../../domain/cursor-usage'
import {
  formatCostUsd,
  formatTokenCount,
  totalUsageTokens
} from '../../domain/cursor-usage'

interface SessionUsageStatProps {
  usage?: CursorSessionUsage
  bound?: boolean
}

/** 用量构成段：颜色与悬浮卡里的分段条、明细行一一对应。 */
const USAGE_SEGMENTS = [
  { key: 'input', label: '输入', tone: 'is-input', value: (usage: CursorSessionUsage) => usage.inputTokens },
  { key: 'output', label: '输出', tone: 'is-output', value: (usage: CursorSessionUsage) => usage.outputTokens },
  { key: 'cacheRead', label: '缓存读', tone: 'is-cacheread', value: (usage: CursorSessionUsage) => usage.cacheReadTokens },
  { key: 'cacheWrite', label: '缓存写', tone: 'is-cachewrite', value: (usage: CursorSessionUsage) => usage.cacheWriteTokens }
] as const

/**
 * 会话页头用量度量组（Orbit「静默度量」）+ 悬浮明细卡：
 * 常态是排版即界面的两段度量（小号大写标签压齐宽数字，hairline 竖分隔，
 * 无底色无描边）；悬浮/聚焦展开分段明细卡，设计语言对齐上下文卡与队列卡。
 */
export function SessionUsageStat({ usage, bound = false }: SessionUsageStatProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const titleId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const ready = Boolean(usage && usage.turns > 0)
  if (!ready && !bound) return null
  const tokens = ready ? formatTokenCount(totalUsageTokens(usage!)) : '—'
  const cost = ready ? formatCostUsd(usage!.estimatedCostUsd) : '—'

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

  // 页头在窗口顶部：卡片锚在触发器下方、右对齐（上下文卡在底部，语义相反）。
  useLayoutEffect(() => {
    if (!open) return
    const update = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = 320
      setPosition({
        left: Math.max(12, Math.min(rect.right - width + 14, window.innerWidth - width - 12)),
        top: Math.min(rect.bottom + 12, window.innerHeight - 260)
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

  const segments = ready
    ? USAGE_SEGMENTS.map((segment) => ({ ...segment, tokens: segment.value(usage!) }))
    : []
  return (
    <div
      className="usage-meter"
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
        className={`session-usage${ready ? '' : ' is-pending'}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={ready
          ? `真实计费 token ${tokens}，等价 API 费用估算 ${cost}，${usage!.turns} 回合，查看明细`
          : '用量待读取'}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="session-usage__cell">
          <span className="session-usage__label">Tokens</span>
          <b className="session-usage__value">{tokens}</b>
        </span>
        <span className="session-usage__sep" aria-hidden="true" />
        <span className="session-usage__cell">
          <span className="session-usage__label">Cost</span>
          <b className="session-usage__value">{cost}</b>
        </span>
      </button>

      {open ? createPortal(
        <section
          ref={popoverRef}
          className="usage-popover"
          role="dialog"
          aria-labelledby={titleId}
          style={{ left: position.left, top: position.top } as CSSProperties}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <header>
            <strong id={titleId}>Usage</strong>
            <button type="button" aria-label="关闭用量明细" onClick={close}>×</button>
          </header>
          {ready ? (
            <>
              <div className="usage-popover__summary">
                <b>{tokens} <small>tokens</small></b>
                <span>{cost} · {usage!.turns} 回合</span>
              </div>
              <div className="usage-breakdown-bar" aria-hidden="true">
                {segments.filter((segment) => segment.tokens > 0).map((segment) => (
                  <i
                    key={segment.key}
                    className={segment.tone}
                    style={{ '--usage-segment-grow': segment.tokens } as CSSProperties}
                  />
                ))}
              </div>
              <ul className="usage-breakdown-list">
                {segments.map((segment) => (
                  <li key={segment.key}>
                    <i className={segment.tone} aria-hidden="true" />
                    <span>{segment.label}</span>
                    <b>{segment.tokens.toLocaleString()}</b>
                  </li>
                ))}
              </ul>
              <footer>
                <span>{usage!.pricedModel}</span>
                <span>输入+输出+缓存读/写合计 · 结束后冻结</span>
              </footer>
            </>
          ) : (
            <p className="usage-popover__empty">等待 Cursor 完成首个可读取的计费回合；轮询通道就绪后自动出现。</p>
          )}
        </section>,
        document.body
      ) : null}
    </div>
  )
}
