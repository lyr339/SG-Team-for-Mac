import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MessageAttachment } from '../../domain/conversation-entry'
import type { QingtianDesktopApi } from '../../shared/desktop-api'
import { formatFileSize } from '../../shared/format-file-size'

/**
 * 图片附件的查看与操作（输入区芯片与时间线共用）：
 * - 点击缩略图 → 大图查看（Esc / 点击遮罩关闭）；
 * - 右键 → 上下文菜单：查看大图 / 复制图片 / 另存为… /（已落盘的）在 Finder 中显示 /（输入区的）移除；
 * - 复制与另存经主进程 IPC（Electron clipboard / 保存对话框），渲染层只传 data URL。
 */

type Desktop = Pick<QingtianDesktopApi, 'copyImageToClipboard' | 'saveImageAs' | 'revealPathInFolder'>

/** 静态渲染 / 测试环境没有 preload 注入的 API：操作按钮退化为提示，不抛错。 */
function desktopApi(): Desktop | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { qingtianDesktop?: QingtianDesktopApi }).qingtianDesktop
}

function imageSource(attachment: MessageAttachment): string | undefined {
  if (attachment.previewUrl) return attachment.previewUrl
  if (attachment.data && attachment.mimeType.startsWith('image/')) return `data:${attachment.mimeType};base64,${attachment.data}`
  return undefined
}

export interface AttachmentActionState {
  /** 最近一次操作的短暂反馈文案（1.6s 后清空）。 */
  feedback: string
  copy(): Promise<void>
  save(): Promise<void>
  reveal(): Promise<void>
  canReveal: boolean
}

export function useAttachmentActions(attachment: MessageAttachment): AttachmentActionState {
  const [feedback, setFeedback] = useState('')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  const flash = (text: string): void => {
    setFeedback(text)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setFeedback(''), 1_600)
  }
  const source = imageSource(attachment)
  return {
    feedback,
    canReveal: Boolean(attachment.path),
    copy: async () => {
      const api = desktopApi()
      if (!api || !source) { flash('无法复制'); return }
      try {
        flash(await api.copyImageToClipboard({ dataUrl: source }) ? '已复制到剪贴板' : '复制失败')
      } catch (error) {
        flash(error instanceof Error ? error.message : '复制失败')
      }
    },
    save: async () => {
      const api = desktopApi()
      if (!api || !source) { flash('无法保存'); return }
      try {
        const saved = await api.saveImageAs({ dataUrl: source, name: attachment.name })
        flash(saved ? '已保存' : '')
      } catch (error) {
        flash(error instanceof Error ? error.message : '保存失败')
      }
    },
    reveal: async () => {
      const api = desktopApi()
      if (!api || !attachment.path) return
      try {
        if (!(await api.revealPathInFolder({ path: attachment.path }))) flash('文件不在拾光附件目录内')
      } catch (error) {
        flash(error instanceof Error ? error.message : '无法显示')
      }
    }
  }
}

interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
}

function AttachmentContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))
    })
  }, [x, y])
  useEffect(() => {
    const onPointer = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node | null)) onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])
  return (
    <div ref={ref} className="attachment-menu" role="menu" style={{ left: position.left, top: position.top }}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? 'is-danger' : ''}
          onClick={() => { onClose(); item.onSelect() }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function AttachmentLightbox({
  attachment,
  actions,
  onClose
}: {
  attachment: MessageAttachment
  actions: AttachmentActionState
  onClose: () => void
}): React.JSX.Element | null {
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>()
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  const source = imageSource(attachment)
  if (!source) return null
  const meta = [
    formatFileSize(attachment.size),
    dimensions ? `${dimensions.width} × ${dimensions.height}` : '',
    attachment.mimeType
  ].filter(Boolean).join(' · ')
  return (
    <div
      className="attachment-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`查看图片 ${attachment.name}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <figure>
        <img
          src={source}
          alt={attachment.name}
          draggable={false}
          onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        />
        <figcaption>
          <div className="attachment-lightbox__meta">
            <strong title={attachment.name}>{attachment.name}</strong>
            <span>{meta}</span>
          </div>
          <div className="attachment-lightbox__actions">
            {actions.feedback ? <em role="status">{actions.feedback}</em> : null}
            <button type="button" onClick={() => void actions.copy()}>复制图片</button>
            <button type="button" onClick={() => void actions.save()}>另存为…</button>
            {actions.canReveal ? <button type="button" onClick={() => void actions.reveal()}>在 Finder 中显示</button> : null}
            <button type="button" className="is-primary" onClick={onClose}>关闭</button>
          </div>
        </figcaption>
      </figure>
    </div>
  )
}

export function AttachmentThumbnail({
  attachment,
  className,
  onRemove
}: {
  attachment: MessageAttachment
  className?: string
  /** 输入区芯片：菜单里多一项「移除」。 */
  onRemove?: () => void
}): React.JSX.Element | null {
  const [viewerOpen, setViewerOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number }>()
  const actions = useAttachmentActions(attachment)
  const source = imageSource(attachment)
  if (!source) return null
  const items: MenuItem[] = [
    { label: '查看大图', onSelect: () => setViewerOpen(true) },
    { label: '复制图片', onSelect: () => void actions.copy() },
    { label: '另存为…', onSelect: () => void actions.save() },
    ...(actions.canReveal ? [{ label: '在 Finder 中显示', onSelect: () => void actions.reveal() }] : []),
    ...(onRemove ? [{ label: '移除附件', onSelect: onRemove, danger: true }] : [])
  ]
  return (
    <>
      <button
        type="button"
        className={`attachment-thumb ${className ?? ''}`}
        title={`${attachment.name} · 点击查看大图，右键更多操作`}
        onClick={() => setViewerOpen(true)}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        <img src={source} alt={attachment.name} draggable={false} />
        {actions.feedback && !viewerOpen ? <span className="attachment-thumb__feedback" role="status">{actions.feedback}</span> : null}
      </button>
      {menu ? <AttachmentContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(undefined)} /> : null}
      {viewerOpen ? <AttachmentLightbox attachment={attachment} actions={actions} onClose={() => setViewerOpen(false)} /> : null}
    </>
  )
}
