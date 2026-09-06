import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CursorWorkspaceDetection } from '../../domain/cursor-workspace'
import { ChevronDownIcon, WorkspaceIcon } from './UiIcons'

interface WorkspaceMenuProps {
  workspace?: { id: string; name: string; path: string }
  detection?: CursorWorkspaceDetection
  onOpenConfiguration: () => void
}

/** 查看项目没有业务副作用；运行项目的选择仍由配置页负责。 */
export function WorkspaceMenu({ workspace, detection, onOpenConfiguration }: WorkspaceMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [position, setPosition] = useState({ left: 12, top: 60, width: 320 })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const panelId = useId()
  const detected = detection?.state === 'detected' ? detection.workspace : undefined
  const label = detected?.name ?? (detection?.state === 'ambiguous' ? '多个 Cursor 工作区' : '工作区未就绪')

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(340, window.innerWidth - 24)
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: rect.bottom + 8 })
    }
    place()
    panel.current?.focus()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (event: Event): void => {
      const target = event.target as Node | null
      if (target && !panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const copyPath = async (): Promise<void> => {
    if (!detected) return
    try {
      await navigator.clipboard.writeText(detected.path)
      setFeedback('路径已复制')
    } catch {
      setFeedback('复制失败，请选中上方路径手动复制')
    }
  }

  return <>
    <button
      ref={trigger}
      className="workspace-detection-chip"
      type="button"
      aria-label={`Cursor 工作区：${label}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      title={detected ? `${detected.name}\n${detected.path}` : detection?.detail ?? '正在识别 Cursor 工作区'}
      onClick={() => { setFeedback(''); setOpen((value) => !value) }}
    >
      <WorkspaceIcon />
      <span>{label}</span>
      <ChevronDownIcon className="workspace-menu__chevron" />
    </button>
    {open && createPortal(
      <div ref={panel} id={panelId} className="workspace-menu" role="dialog" aria-labelledby={titleId} tabIndex={-1}
        style={{ left: position.left, top: position.top, width: position.width }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          event.preventDefault()
          buttons[next]?.focus()
        }}
      >
        <div className="workspace-menu__summary">
          <small>Cursor 当前工作区</small>
          <strong id={titleId}>{label}</strong>
          {detected ? <span className="workspace-menu__path">{detected.path}</span> : <span>{detection?.detail ?? '正在识别 Cursor 工作区'}</span>}
        </div>
        {detected && <button type="button" onClick={() => void copyPath()}>复制项目路径</button>}
        {workspace && workspace.id !== detected?.id && <div className="workspace-menu__hint">
          <small>拾光已有会话所属项目（保持原绑定）</small>
          <span title={workspace.path}>{workspace.name}</span>
        </div>}
        <button type="button" className="workspace-menu__configure" onClick={() => {
          setOpen(false)
          onOpenConfiguration()
        }}>前往项目配置 <span aria-hidden="true">→</span></button>
        <span className="workspace-menu__feedback" role="status">{feedback}</span>
      </div>, document.body
    )}
  </>
}
