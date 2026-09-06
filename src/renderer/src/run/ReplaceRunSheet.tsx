import { useEffect, useRef } from 'react'
import type { ReplaceRunConsequence } from './run-view'

interface ReplaceRunSheetProps {
  consequence: ReplaceRunConsequence
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * 破坏性动作的唯一确认面：结束 / 切换模式 / 新建批次 / 新一轮共用。
 * 随内容流展示（不是遮罩弹窗），标题说动作、正文说后果、按钮说结果。
 */
export function ReplaceRunSheet({ consequence, busy, onCancel, onConfirm }: ReplaceRunSheetProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [busy, onCancel])

  return (
    <section className="run-sheet" role="alertdialog" aria-labelledby="run-sheet-title" aria-describedby="run-sheet-body">
      <div className="run-sheet__body">
        <strong id="run-sheet-title">{consequence.title}</strong>
        <p id="run-sheet-body">{consequence.body}</p>
      </div>
      <div className="run-sheet__actions">
        <button ref={cancelRef} className="secondary-button" disabled={busy} onClick={onCancel}>取消</button>
        <button className="run-sheet__confirm" disabled={busy} onClick={onConfirm}>
          {busy ? '处理中…' : consequence.confirmLabel}
        </button>
      </div>
    </section>
  )
}
