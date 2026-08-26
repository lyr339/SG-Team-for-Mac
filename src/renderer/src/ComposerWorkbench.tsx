import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import type { MessageAttachment } from '../../domain/conversation-entry'
import {
  badgeTone,
  contextPercent,
  contextTone,
  executionBadges,
  formatExecutionProfile,
  formatAgentSessionDuration,
  formatFileSize,
  modelDisplayName,
  statusLabel
} from './format'
import { planAttachmentIntake } from './attachment-rules'
import { EraseIcon, ExportIcon, HandoffIcon, LinkIcon } from './UiIcons'

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
  attachments?: MessageAttachment[]
  onAttachmentsChange?: (attachments: MessageAttachment[]) => void
  /** 快捷提示词直发（点击 chips 上的发送钮）。 */
  onQuickSend?: (text: string) => void
}

/** 快捷提示词：localStorage 持久化，全应用共享一份。 */
const QUICK_PROMPTS_STORAGE_KEY = 'qingtian.quickPrompts'
const DEFAULT_QUICK_PROMPTS = [
  '按建议来，做之前深度分析审查',
  '继续',
  '汇报当前进度',
  '注意：全程不要使用 subagent'
]

function loadQuickPrompts(): string[] {
  try {
    const raw = localStorage.getItem(QUICK_PROMPTS_STORAGE_KEY)
    if (!raw) return [...DEFAULT_QUICK_PROMPTS]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_QUICK_PROMPTS]
    const prompts = parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    return prompts.length ? prompts.map((item) => item.trim().slice(0, 200)) : [...DEFAULT_QUICK_PROMPTS]
  } catch {
    return [...DEFAULT_QUICK_PROMPTS]
  }
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

function ClockIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
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
  if (!session.online && session.deliveryMode === 'queued') return 'Agent 待轮询'
  if (!session.online) return 'Agent 离线'
  if (session.waiting) return 'Agent 待命'
  return `Agent ${statusLabel(session.status)}`
}

function projectChipLabel(session: AgentSession, currentProjectName?: string): string {
  const projectName = currentProjectName?.trim()
  if (projectName) return projectName
  return session.composerTitle?.trim() || session.displayName
}

function compactPercent(value?: number): string {
  if (value === undefined) return '待读取'
  return `${value.toFixed(1).replace(/\.0$/, '')}%`
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
      const attachment: MessageAttachment = {
        id: crypto.randomUUID(),
        name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        data: data.split(',')[1] ?? '',
        previewUrl: file.type.startsWith('image/') ? data : undefined
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
  attachments = [],
  onAttachmentsChange,
  onQuickSend
}: ComposerWorkbenchProps): React.JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentsRef = useRef(attachments)
  const intakeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [attachmentError, setAttachmentError] = useState('')
  const [pendingAttachmentIntakes, setPendingAttachmentIntakes] = useState(0)
  const [draggingAttachment, setDraggingAttachment] = useState(false)
  const [quickPrompts, setQuickPrompts] = useState<string[]>(loadQuickPrompts)
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  useEffect(() => {
    try { localStorage.setItem(QUICK_PROMPTS_STORAGE_KEY, JSON.stringify(quickPrompts)) } catch { /* 存储不可用时静默 */ }
  }, [quickPrompts])
  const percent = contextPercent(session.contextUsage)
  const tone = contextTone(percent)
  const profile = session.executionProfile
  const profileName = modelDisplayName(profile, session.modelName)
  const badges = executionBadges(profile, session.modelName)
  const profileKnown = Boolean(session.modelName || profile)
  const profileTitle = session.modelName
    ? 'Cursor 为该会话上报的模型'
    : profile
      ? `${formatExecutionProfile(profile)}；这是 Cursor 当前 Composer 运行配置，不代表历史回复的底层模型`
      : 'Cursor 当前 Composer 运行配置尚未读取到'
  const bound = session.telemetry?.state === 'bound'
  const queuedOffline = session.deliveryMode === 'queued' && !session.online
  const projectLabel = projectChipLabel(session, currentProjectName)
  const stateLabel = agentState(session)
  const attachmentBusy = pendingAttachmentIntakes > 0
  const placeholder = canSend
    ? attachmentBusy
      ? `正在读取附件，完成后再给「${session.displayName}」发送…`
      : queuedOffline
      ? `给「${session.displayName}」排队发送（等待 Agent 恢复轮询）…`
      : notWaiting
      ? `给「${session.displayName}」排队发送（Agent 尚未待命）…`
      : `给「${session.displayName}」发送消息…`
    : `Agent 当前离线，可先写下给「${session.displayName}」的消息…`
  const ringStyle = { '--composer-context': `${percent ?? 0}%` } as CSSProperties

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
      className={`workspace-composer ${canSend ? 'is-ready' : 'is-offline'} ${draggingAttachment ? 'is-dragging-attachment' : ''}`}
      aria-label="会话消息工作台"
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingAttachment(false)
      }}
      onDrop={handleDrop}
    >
      <div className="composer-topbar">
        <div className="composer-topbar__left">
          <span
            className={`composer-agent-chip ${session.online ? 'is-online' : queuedOffline ? 'is-queued' : 'is-offline'}`}
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
            title={onHandoff ? '把离线职责交给其他在线空闲 Agent' : '当前会话无需交接或没有有效团队角色'}
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
          <span className={bound ? 'composer-meta is-positive' : 'composer-meta'} title={session.telemetry?.detail}>
            <LinkIcon />
            {bound ? 'Cursor 已绑定' : '会话待绑定'}
          </span>
          <span className="composer-meta composer-queue-meta">
            <QueueIcon />
            队列 {session.queueDepth}
          </span>
          <span className="composer-duration" title={session.online ? '当前 Cursor 会话累计运行时长' : 'Cursor Agent 离线后已截止'}>
            <ClockIcon />
            {formatAgentSessionDuration(session)}
          </span>
        </div>
      </div>

      {attachmentBusy ? <p className="composer-attachment-status" role="status">正在读取附件，完成后再发送。</p> : null}
      {attachmentError ? <p className="composer-attachment-error" role="alert">{attachmentError}</p> : null}

      <div className="composer-quick-prompts" role="group" aria-label="快捷提示词">
        {quickPrompts.map((prompt) => (
          <span className="quick-prompt" key={prompt}>
            <button
              className="quick-prompt__fill"
              title="填入输入框"
              disabled={submitting}
              onClick={() => onDraftChange(draft ? `${draft}\n${prompt}` : prompt)}
            >{prompt}</button>
            <button
              className="quick-prompt__send"
              title={`直接发送：${prompt}`}
              aria-label={`直接发送：${prompt}`}
              disabled={!canSend || submitting || attachmentBusy}
              onClick={() => onQuickSend?.(prompt)}
            >➤</button>
            <button
              className="quick-prompt__remove"
              title="删除这条快捷提示词"
              aria-label={`删除快捷提示词：${prompt}`}
              onClick={() => setQuickPrompts((current) => current.filter((item) => item !== prompt))}
            >×</button>
          </span>
        ))}
        <button
          className="quick-prompt quick-prompt__add"
          title="把当前输入框内容存为快捷提示词"
          disabled={!draft.trim()}
          onClick={() => {
            const text = draft.trim().slice(0, 200)
            if (!text || quickPrompts.includes(text)) return
            setQuickPrompts((current) => [...current, text])
          }}
        >＋ 存当前草稿</button>
      </div>

      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="composer-attachment">
              {attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt={attachment.name} className="composer-attachment-preview" />
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
          className={`composer-model ${profileKnown ? '' : 'is-unknown'}`}
          title={profileTitle}
          aria-label={`运行配置：${formatExecutionProfile(profile, session.modelName)}`}
        >
          <b>{profileName}</b>
          {badges.map((badge) => <i key={badge} className={`is-${badgeTone(badge)}`}>{badge}</i>)}
        </div>
        <div
          className={`composer-context ${percent === undefined ? 'is-unknown' : ''} ${tone ? `is-${tone}` : ''}`}
          title="Cursor 本机会话上下文占用"
        >
          <i style={ringStyle} aria-hidden="true" />
          <span>上下文 {compactPercent(percent)}</span>
        </div>
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
