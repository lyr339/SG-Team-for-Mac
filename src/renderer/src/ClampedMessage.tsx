import { useLayoutEffect, useRef, useState } from 'react'
import { MessageContent } from './MessageContent'

/** 长回复气泡限高（超出折叠为渐变遮罩 + 「展开全文」），避免单条回复撑满会话窗。 */
export const MESSAGE_CLAMP_PX = 384

/**
 * 长文本气泡内容：超过限高默认折叠，用户点击「展开全文」查看完整内容。
 * 测量在 useLayoutEffect 中按 text 重测；折叠态 scrollHeight 仍是全文高度，不受 max-height 影响。
 * 只用于历史水合的回复：本会话内看着流出来的正文不再事后折叠（折叠会让刚播完的内容突然收缩）。
 */
export function ClampedMessage({ text }: { text: string }): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useLayoutEffect(() => {
    const element = contentRef.current
    if (!element) return
    setOverflowing(element.scrollHeight > MESSAGE_CLAMP_PX)
  }, [text])
  return (
    <div className={`clamped-message${overflowing && !expanded ? ' is-clamped' : ''}`}>
      <div ref={contentRef}>
        <MessageContent text={text} />
      </div>
      {overflowing ? (
        <button
          type="button"
          className="clamped-message__toggle"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? '收起 ▴' : `展开全文 ▾`}
        </button>
      ) : null}
    </div>
  )
}
