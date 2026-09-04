import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import type { ConversationEntry, MessageAttachment } from '../../domain/conversation-entry'
import {
  clampManualHeight,
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  dragManualHeight,
  readStoredComposerHeight,
  resolveComposerHeight,
  storeComposerHeight
} from './composer-height'
import { AttachmentThumbnail } from './AttachmentImageViewer'
import {
  badgeTone,
  executionBadges,
  formatExecutionProfile,
  formatAgentSessionDuration,
  formatFileSize,
  modelDisplayName,
  statusLabel
} from './format'
import { planAttachmentIntake } from './attachment-rules'
import { sniffedAttachmentMimeType } from '../../domain/conversation-entry'
import { ContextUsagePopover } from './ContextUsagePopover'
import { modelProviderClass, modelProviderLabel } from './model-provider'
import { EraseIcon, ExportIcon, HandoffIcon } from './UiIcons'

interface ComposerWorkbenchProps {
  session: AgentSession
  currentProjectName?: string
  draft: string
  canSend: boolean
  notWaiting: boolean
  submitting: boolean
  sendError: string
  onDraftChange: (value: string) => void
  onSubmit: () => void
  onExport?: () => void
  exportEnabled?: boolean
  onHandoff?: () => void
  /** 交接按钮的悬停说明（不可用时解释原因）。 */
  handoffTitle?: string
  attachments?: MessageAttachment[]
  onAttachmentsChange?: (attachments: MessageAttachment[]) => void
  /** 仍在排队（未投递）的用户消息，供队列弹层逐条展示与撤回。 */
  queuedEntries?: ConversationEntry[]
  onWithdrawQueued?: (entryId: string) => void
  onReleaseQueued?: (entryId: string) => void
}

function WindowIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.8 7h14.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="5.2" cy="5.25" r=".65" fill="currentColor" />
    </svg>
  )
}

function QueueIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6.5 5h10M6.5 10h10M6.5 15h10" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
      <circle cx="3" cy="5" r="1" fill="currentColor" />
      <circle cx="3" cy="10" r="1" fill="currentColor" />
      <circle cx="3" cy="15" r="1" fill="currentColor" />
    </svg>
  )
}

function queuePreview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact || '（仅附件）'
}

function queueClock(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * 队列弹层：向上展开（永不遮住输入区），悬停即览、点击钉住；列出仍在排队的用户消息，
 * 每条可撤回，带「等待新会话」保持位的可放行。数字口径 = 服务端待投递计数（含内部
 * 静默消息），列表口径 = 用户可见条目，两者相差时如实注明。
 */
function QueueStatus({
  session,
  queuedEntries = [],
  onWithdraw,
  onRelease
}: {
  session: AgentSession
  queuedEntries?: ConversationEntry[]
  onWithdraw?: (entryId: string) => void
  onRelease?: (entryId: string) => void
}): React.JSX.Element {
  const popoverId = useId()
  const rootRef = useRef<HTMLSpanElement>(null)
  const [pinned, setPinned] = useState(false)
  useEffect(() => {
    if (!pinned) return
    const onPointer = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node | null)) setPinned(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPinned(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [pinned])
  const depth = session.queueDepth
  const heldCount = queuedEntries.filter((entry) => entry.heldForNextSession).length
  const hiddenCount = Math.max(0, depth - queuedEntries.length)
  const tone = !session.online ? 'offline' : session.waiting ? 'waiting' : 'busy'
  const state = !session.online
    ? 'Agent 离线：消息保留在本地队列，恢复轮询后按顺序送达'
    : session.waiting
      ? 'Agent 正在监听：下一条消息会立即投递'
      : 'Agent 正在处理当前任务：新消息按顺序等待'
  return (
    <span className={`composer-queue-status ${pinned ? 'is-pinned' : ''} ${depth > 0 ? 'has-items' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="composer-queue-status__chip"
        aria-expanded={pinned}
        aria-controls={popoverId}
        title={pinned ? '收起消息队列' : '查看消息队列'}
        onClick={() => setPinned((value) => !value)}
      >
        <QueueIcon />
        <span>队列 <b>{depth}</b></span>
        {heldCount > 0 ? <i className="composer-queue-status__held" title={`${heldCount} 条等待新会话`}>{heldCount}</i> : null}
      </button>
      <div className="composer-queue-popover" id={popoverId} role="dialog" aria-label="消息队列">
        <header>
          <span><QueueIcon /></span>
          <strong>消息队列</strong>
          <em>{depth}</em>
        </header>
        <p className={`composer-queue-popover__state is-${tone}`}><i />{state}</p>
        {queuedEntries.length ? (
          <ol className="composer-queue-list">
            {queuedEntries.map((entry, index) => (
              <li key={entry.id} className={`composer-queue-item ${entry.heldForNextSession ? 'is-held' : ''}`}>
                <span className="composer-queue-item__index">{index + 1}</span>
                <div className="composer-queue-item__body">
                  <div className="composer-queue-item__meta">
                    <time>{queueClock(entry.timestamp)}</time>
                    {entry.attachments?.length ? <span>{entry.attachments.length} 个附件</span> : null}
                    {entry.heldForNextSession ? <b>等待新会话</b> : null}
                  </div>
                  <p title={entry.text}>{queuePreview(entry.text)}</p>
                </div>
                <div className="composer-queue-item__actions">
                  {entry.heldForNextSession && onRelease ? (
                    <button type="button" title="解除等待：当前 Agent 下一次轮询即取走" onClick={() => onRelease(entry.id)}>放行</button>
                  ) : null}
                  {onWithdraw ? (
                    <button type="button" className="is-danger" title="撤回这条尚未投递的消息" onClick={() => onWithdraw(entry.id)}>撤回</button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="composer-queue-popover__empty">
            {depth > 0 ? `${depth} 条系统内部消息在队列中，不显示正文。` : '队列为空，下一条消息将按上面的状态投递。'}
          </p>
        )}
        {queuedEntries.length && hiddenCount > 0 ? (
          <p className="composer-queue-popover__note">另有 {hiddenCount} 条系统内部消息在队列中。</p>
        ) : null}
        <footer>投递方式：check_messages 长轮询，取走即最多一次；未投递前可撤回。</footer>
      </div>
    </span>
  )
}

function AlarmIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5.2 3.6-2 2M14.8 3.6l2 2M6 17l-1 1.4M14 17l1 1.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      <circle cx="10" cy="10.5" r="6.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 6.3V10l2.7 1.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    </svg>
  )
}

function SendIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 22 22" aria-hidden="true">
      <path d="m19 3-7.2 16-2.1-6.7L3 10.2 19 3Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="m9.7 12.3 4.1-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  )
}

function agentState(session: AgentSession): string {
  if (!session.online) return 'Agent 离线'
  if (session.waiting) return 'Agent 待命'
  return `Agent ${statusLabel(session.status)}`
}

function projectChipLabel(session: AgentSession, currentProjectName?: string): string {
  const projectName = currentProjectName?.trim()
  if (projectName) return projectName
  const composerTitle = session.composerTitle?.trim()
  if (session.roleTemplateKey === 'solo' && composerTitle?.toLowerCase() === 'independent agent mode') {
    return session.displayName
  }
  return composerTitle || session.displayName
}

function AttachmentIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m12.5 4.5-7 7a2.5 2.5 0 0 0 3.5 3.5l7-7a1.5 1.5 0 0 0-2-2l-7 7a.5.5 0 0 0 .5.5h.09l6.41-6.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  )
}

function RemoveIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </svg>
  )
}

/** 附件读取：防护规则见 attachment-rules.ts（唯一出口，含单测）。 */

type TransferLike = {
  files?: ArrayLike<File> | null
  items?: ArrayLike<{ kind: string; getAsFile?: () => File | null }> | null
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/svg+xml') return 'svg'
  const match = mimeType.match(/^image\/([a-z0-9.+-]+)$/i)
  if (match?.[1]) return match[1].replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'
  return 'bin'
}

export function attachmentNameFor(file: Pick<File, 'name' | 'type'>, index: number): string {
  const name = file.name.trim()
  if (name) return name
  const image = file.type.startsWith('image/')
  return `${image ? 'clipboard-image' : 'clipboard-file'}-${index + 1}.${extensionForMime(file.type)}`
}

export function filesFromTransfer(dataTransfer: TransferLike | null | undefined): File[] {
  const files = Array.from(dataTransfer?.files ?? []).filter((file) => file.size > 0)
  if (files.length) return files
  return Array.from(dataTransfer?.items ?? []).flatMap((item) => {
    if (item.kind !== 'file') return []
    const file = item.getAsFile?.()
    return file && file.size > 0 ? [file] : []
  })
}

function hasTransferFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files') || filesFromTransfer(dataTransfer).length > 0
}

function readFileAsAttachment(file: File, index: number): Promise<MessageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const data = reader.result as string
      const name = attachmentNameFor(file, index)
      // file.type 在部分拖放/剪贴板来源下为空或万金油 octet-stream——按扩展名
      // 嗅探纠正，否则图片会被投递层当成二进制文本墙（模型看到乱码）。
      const mimeType = sniffedAttachmentMimeType(name, file.type)
      const attachment: MessageAttachment = {
        id: crypto.randomUUID(),
        name,
        mimeType,
        size: file.size,
        data: data.split(',')[1] ?? '',
        previewUrl: mimeType.startsWith('image/') ? data : undefined
      }
      resolve(attachment)
    }
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`))
    reader.readAsDataURL(file)
  })
}

export function ComposerWorkbench({
  session,
  currentProjectName,
  draft,
  canSend,
  notWaiting,
  submitting,
  sendError,
  onDraftChange,
  onSubmit,
  onExport,
  exportEnabled = false,
  onHandoff,
  handoffTitle,
  attachments = [],
  onAttachmentsChange,
  queuedEntries,
  onWithdrawQueued,
  onReleaseQueued
}: ComposerWorkbenchProps): React.JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachmentsRef = useRef(attachments)
  const intakeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [attachmentError, setAttachmentError] = useState('')
  const [pendingAttachmentIntakes, setPendingAttachmentIntakes] = useState(0)
  const [draggingAttachment, setDraggingAttachment] = useState(false)
  // 输入区高度：内容自适应 + 上边缘可拖（手动高度 = 最低高度，持久化）。
  const [manualHeight, setManualHeight] = useState<number | undefined>(() => readStoredComposerHeight())
  const [resizingHeight, setResizingHeight] = useState(false)
  const manualHeightRef = useRef(manualHeight)
  manualHeightRef.current = manualHeight
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const apply = (): void => {
      // 先收到最小高度量出内容真实高度，再按模型夹紧；避免 scrollHeight 被上一次高度撑大。
      textarea.style.height = `${COMPOSER_TEXTAREA_MIN_HEIGHT}px`
      const next = resolveComposerHeight({
        contentHeight: textarea.scrollHeight,
        manualHeight: manualHeightRef.current,
        viewportHeight: window.innerHeight
      })
      textarea.style.height = `${next}px`
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [draft, manualHeight])

  const commitManualHeight = (value: number | undefined): void => {
    setManualHeight(value)
    storeComposerHeight(value)
  }

  const beginHeightResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = manualHeightRef.current ?? textareaRef.current?.getBoundingClientRect().height ?? COMPOSER_TEXTAREA_MIN_HEIGHT
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setResizingHeight(true)
    let latest = startHeight
    const move = (moveEvent: PointerEvent): void => {
      latest = dragManualHeight(startHeight, startY, moveEvent.clientY, window.innerHeight)
      setManualHeight(latest)
    }
    const finish = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      setResizingHeight(false)
      // 拖回默认高度即视为清除手动高度（回到纯内容自适应）。
      commitManualHeight(latest <= COMPOSER_TEXTAREA_MIN_HEIGHT ? undefined : latest)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  const resizeHeightWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Home') {
      event.preventDefault()
      commitManualHeight(undefined)
      return
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const current = manualHeightRef.current ?? textareaRef.current?.getBoundingClientRect().height ?? COMPOSER_TEXTAREA_MIN_HEIGHT
    const step = (event.shiftKey ? 40 : 10) * (event.key === 'ArrowUp' ? 1 : -1)
    const next = clampManualHeight(current + step, window.innerHeight)
    commitManualHeight(next <= COMPOSER_TEXTAREA_MIN_HEIGHT ? undefined : next)
  }
  const profile = session.executionProfile
  const profileName = modelDisplayName(profile, session.modelName)
  const badges = executionBadges(profile)
  const profileKnown = Boolean(session.modelName || profile)
  const profileTitle = session.modelName
    ? 'Cursor 为该会话上报的模型'
    : profile
      ? `${formatExecutionProfile(profile)}；这是 Cursor 当前 Composer 运行配置，不代表历史回复的底层模型`
      : 'Cursor 当前 Composer 运行配置尚未读取到'
  const queuedOffline = session.deliveryMode === 'queued' && !session.online
  const projectLabel = projectChipLabel(session, currentProjectName)
  const stateLabel = agentState(session)
  const attachmentBusy = pendingAttachmentIntakes > 0
  const durationLabel = formatAgentSessionDuration(session)
  const placeholder = canSend
    ? attachmentBusy
      ? `正在读取附件，完成后再给「${session.displayName}」发送…`
      : queuedOffline
      ? `给「${session.displayName}」排队发送（等待 Agent 恢复轮询）…`
      : notWaiting
      ? `给「${session.displayName}」排队发送（Agent 尚未待命）…`
      : `给「${session.displayName}」发送消息…`
    : `Agent 当前离线，可先写下给「${session.displayName}」的消息…`

  const intakeFiles = (files: File[], source: '选择' | '粘贴' | '拖放'): Promise<void> => {
    if (!files.length) return Promise.resolve()
    if (!onAttachmentsChange) {
      setAttachmentError('当前会话不能添加附件')
      return Promise.resolve()
    }
    setPendingAttachmentIntakes((count) => count + 1)
    const job = intakeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const { accepted, rejections } = planAttachmentIntake(files, attachmentsRef.current)
        setAttachmentError(rejections.join('；'))
        if (!accepted.length) return
        try {
          const newAttachments = await Promise.all(accepted.map((file, index) => readFileAsAttachment(file, index)))
          if (newAttachments.length) {
            const next = [...attachmentsRef.current, ...newAttachments]
            attachmentsRef.current = next
            onAttachmentsChange(next)
          }
          if (!rejections.length) setAttachmentError('')
        } catch (error) {
          setAttachmentError(error instanceof Error ? error.message : `${source}附件失败，请重试`)
        }
      })
      .finally(() => setPendingAttachmentIntakes((count) => Math.max(0, count - 1)))
    intakeQueueRef.current = job.catch(() => undefined)
    return job
  }

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    await intakeFiles(filesFromTransfer(event.target), '选择')
    event.target.value = ''
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = filesFromTransfer(event.clipboardData)
    if (!files.length) return
    event.preventDefault()
    void intakeFiles(files, '粘贴')
  }

  const handleDragOver = (event: React.DragEvent<HTMLElement>): void => {
    if (!hasTransferFiles(event.dataTransfer)) return
    event.preventDefault()
    setDraggingAttachment(true)
  }

  const handleDrop = (event: React.DragEvent<HTMLElement>): void => {
    if (!hasTransferFiles(event.dataTransfer)) return
    event.preventDefault()
    setDraggingAttachment(false)
    void intakeFiles(filesFromTransfer(event.dataTransfer), '拖放')
  }

  const removeAttachment = (id: string): void => {
    setAttachmentError('')
    onAttachmentsChange?.(attachments.filter((attachment) => attachment.id !== id))
  }

  return (
    <section
      className={`workspace-composer ${canSend ? 'is-ready' : 'is-offline'} ${draggingAttachment ? 'is-dragging-attachment' : ''} ${resizingHeight ? 'is-resizing-height' : ''}`}
      aria-label="会话消息工作台"
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingAttachment(false)
      }}
      onDrop={handleDrop}
      onClick={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('button, input, textarea, label, a')) return
        textareaRef.current?.focus({ preventScroll: true })
      }}
    >
      <div
        className="composer-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖动调整输入区高度；↑/↓ 微调，Home 恢复默认"
        aria-valuenow={manualHeight ?? COMPOSER_TEXTAREA_MIN_HEIGHT}
        aria-valuemin={COMPOSER_TEXTAREA_MIN_HEIGHT}
        title={manualHeight ? '拖动调整输入区高度 · 双击恢复自适应' : '向上拖动可加高输入区'}
        tabIndex={0}
        onPointerDown={beginHeightResize}
        onDoubleClick={() => commitManualHeight(undefined)}
        onKeyDown={resizeHeightWithKeyboard}
        onClick={(event) => event.stopPropagation()}
      >
        <i aria-hidden="true" />
      </div>
      <div className="composer-topbar">
        <div className="composer-topbar__left">
          <span
            className={`composer-agent-chip ${session.online ? 'is-online' : 'is-offline'}`}
            title={`${projectLabel} · ${session.roleName} · CH-${session.channelId} · ${stateLabel}`}
          >
            <WindowIcon />
            <strong>{projectLabel}</strong>
          </span>
          <span className="composer-divider" aria-hidden="true" />
          <button
            className="composer-tool"
            disabled={!exportEnabled}
            title={exportEnabled ? '把当前会话时间线导出为 Markdown' : '会话还没有可导出的消息'}
            onClick={onExport}
          >
            <ExportIcon />
            <span>导出</span>
          </button>
          <button
            className="composer-tool"
            disabled={!draft}
            title="清空输入框草稿"
            onClick={() => onDraftChange('')}
          >
            <EraseIcon />
            <span>清空</span>
          </button>
          <button className="composer-tool" disabled={!onHandoff}
            title={handoffTitle ?? (onHandoff ? '交接这个会话的上下文' : '当前会话无需交接或没有有效团队角色')}
            onClick={onHandoff}>
            <HandoffIcon />
            <span>交接</span>
          </button>
          <button
            className="composer-tool"
            disabled={submitting || attachmentBusy || !onAttachmentsChange}
            title="添加图片或文件附件"
            onClick={() => fileInputRef.current?.click()}
          >
            <AttachmentIcon />
            <span>附件</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.pdf,.txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.java,.go,.rs,.c,.cpp,.h,.hpp,.css,.html,.xml,.yaml,.yml,.toml,.ini,.sh,.bat,.ps1,.sql,.csv,.log"
            style={{ display: 'none' }}
            onChange={(event) => void handleFileSelect(event)}
          />
        </div>
        <div className="composer-topbar__right">
          <QueueStatus
            session={session}
            queuedEntries={queuedEntries}
            onWithdraw={onWithdrawQueued}
            onRelease={onReleaseQueued}
          />
          <span
            className={`composer-duration ${session.online ? 'is-running' : 'is-inactive'}`}
            data-tooltip={durationLabel}
            aria-label={session.online ? `会话运行时间：${durationLabel}` : `会话截止时间：${durationLabel}`}
            tabIndex={0}
          >
            <AlarmIcon />
            <span className="composer-duration__text">{durationLabel}</span>
          </span>
        </div>
      </div>

      {attachmentBusy ? <p className="composer-attachment-status" role="status">正在读取附件，完成后再发送。</p> : null}
      {attachmentError ? <p className="composer-attachment-error" role="alert">{attachmentError}</p> : null}

      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="composer-attachment">
              {attachment.previewUrl ? (
                <AttachmentThumbnail
                  attachment={attachment}
                  className="composer-attachment-preview"
                  onRemove={() => removeAttachment(attachment.id)}
                />
              ) : (
                <div className="composer-attachment-file">
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.2"/><path d="M9 2v3h3" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>
                </div>
              )}
              <div className="composer-attachment-info">
                <span className="composer-attachment-name" title={attachment.name}>{attachment.name}</span>
                <span className="composer-attachment-size">{formatFileSize(attachment.size)}</span>
              </div>
              <button
                className="composer-attachment-remove"
                title="移除附件"
                onClick={() => removeAttachment(attachment.id)}
              >
                <RemoveIcon />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={draft}
        placeholder={placeholder}
        disabled={submitting}
        aria-label={`给 ${session.displayName} 发送消息`}
        onChange={(event) => onDraftChange(event.target.value)}
        onPaste={handlePaste}
        onKeyDown={(event) => {
          // isComposing：中文等输入法组词态按 Enter 是选词，不能触发发送。
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            if (!attachmentBusy) onSubmit()
          }
        }}
      />

      <div className="composer-controls">
        <div
          className={`composer-model ${profileKnown ? modelProviderClass(profile?.modelId ?? session.modelName, profileName) : 'is-unknown'}`}
          title={`${profileTitle}${profileKnown ? ` · ${modelProviderLabel(profile?.modelId ?? session.modelName, profileName)}` : ''}`}
          aria-label={`运行配置：${formatExecutionProfile(profile, session.modelName)}`}
        >
          <b>{profileName}</b>
          {badges.map((badge) => <i key={badge} className={`is-${badgeTone(badge)}`}>{badge}</i>)}
        </div>
        <ContextUsagePopover usage={session.contextUsage} />
        {sendError && <span className="composer-error" role="alert">{sendError}</span>}
        <div className="composer-submit">
          <kbd title="Enter 发送；Shift + Enter 换行">↵</kbd>
          <button
            disabled={!canSend || attachmentBusy || (!draft.trim() && attachments.length === 0)}
            onClick={onSubmit}
            title={!session.online && !queuedOffline
              ? '对应 Cursor Agent 离线，恢复后可发送'
              : undefined}
          >
            <SendIcon />
            {submitting ? '发送中' : attachmentBusy ? '读取中' : queuedOffline || notWaiting ? '排队' : '发送'}
          </button>
        </div>
      </div>
    </section>
  )
}
