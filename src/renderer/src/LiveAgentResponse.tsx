import { useEffect, useRef, useState } from 'react'
import type { LiveAgentResponseState } from '../../shared/desktop-api'
import { MessageContent } from './MessageContent'

/**
 * Cursor CDP 每约 250ms 提供一段更长文本；这里用自适应字符缓冲追赶目标，
 * 展现为连续打字而不是 250ms 一跳。目标回退/换 bubble 时立即安全重置。
 */
export function LiveAgentResponse({ response }: { response: LiveAgentResponseState }): React.JSX.Element {
  const [visible, setVisible] = useState('')
  const responseId = useRef(response.id)

  useEffect(() => {
    if (responseId.current !== response.id) {
      responseId.current = response.id
      setVisible('')
    }
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion || response.status === 'complete') {
      setVisible(response.text)
      return
    }
    let frame = 0
    let previousAt = performance.now()
    const tick = (now: number): void => {
      if (now - previousAt >= 16) {
        previousAt = now
        setVisible((current) => {
          if (!response.text.startsWith(current)) return response.text
          const remaining = response.text.length - current.length
          if (remaining <= 0) return current
          // 约 280–480ms 追上最新 CDP 文本；长批次提高步长，短批次逐字呈现。
          const step = Math.max(1, Math.ceil(remaining / 22))
          return response.text.slice(0, current.length + step)
        })
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [response.id, response.status, response.text])

  return (
    <div className="live-agent-response" aria-live="polite" aria-label="Cursor Agent 正在实时生成">
      {visible ? <MessageContent text={visible} className="live-agent-response__text" /> : null}
      {response.status === 'streaming' ? <span className="live-agent-response__caret" aria-hidden="true" /> : null}
    </div>
  )
}
