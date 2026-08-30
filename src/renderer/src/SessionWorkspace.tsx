import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import type { ConversationEntry, MessageAttachment } from '../../domain/conversation-entry'
import type { LiveAgentResponseState, LiveProcessState } from '../../shared/desktop-api'
import { formatClock, formatFileSize, formatRelativeTime, statusLabel } from './format'
import { ComposerWorkbench } from './ComposerWorkbench'
import { AgentAvatar } from './AgentAvatar'
import { MessageContent } from './MessageContent'
import { ProcessTurnCard } from './ProcessTurnCard'
import { LiveAgentResponse } from './LiveAgentResponse'
import { suggestedActionsFromText } from './process-turn-view'

interface SessionWorkspaceProps {
  session: AgentSession
  entries: ConversationEntry[]
  currentProjectName?: string
  onSend: (text: string, attachments?: MessageAttachment[]) => Promise<void>
  onBack: () => void
  onHandoff?: () => void
  draft: string
  onDraftChange: (value: string) => void
  attachments: MessageAttachment[]
  onAttachmentsChange: (attachments: MessageAttachment[]) => void
  /** Cursor 内存模型直接推送的当前回合过程流。 */
  liveProcess?: LiveProcessState
  /** Cursor Composer 原生回复文本（CDP 250ms 增量）。 */
  liveAgentResponse?: LiveAgentResponseState
}

/** 同角色且间隔小于该值的连续消息合并成一组（只显示一次头像与名称）。 */
const GROUP_WINDOW_MS = 5 * 60_000
/** 消息间隔超过该值时插入居中的时间分隔线。 */
const DIVIDER_WINDOW_MS = 10 * 60_000
/** 长回复气泡限高（超出折叠为渐变遮罩 + 「展开全文」），避免单条回复撑满会话窗。 */
const MESSAGE_CLAMP_PX = 384

type TimelineItem =
  | { type: 'entry'; key: string; entry: ConversationEntry; timestamp: number; order: number }
  | { type: 'live-process'; key: string; timestamp: number; order: number }
  | { type: 'live-response'; key: string; timestamp: number; order: number }
  | { type: 'running-placeholder'; key: string; timestamp: number; order: number }

/**
 * 长文本气泡内容：超过限高默认折叠，用户点击「展开全文」查看完整内容。
 * 测量在 useLayoutEffect 中按 text 重测；折叠态 scrollHeight 仍是全文高度，不受 max-height 影响。
 */
function ClampedMessage({ text }: { text: string }): React.JSX.Element {
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

function entryLabel(entry: ConversationEntry): string {
  if (entry.role === 'user') return entry.source === 'desktop' ? '你' : '用户'
  if (entry.role === 'assistant') return 'Agent'
  if (entry.role === 'error') return '错误'
  return '系统'
}

function dividerLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  if (sameDay) return formatClock(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${formatClock(timestamp)}`
}

function CopyIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 3.5h-6a2 2 0 0 0-2 2v6" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  )
}

function QuoteIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5V6.8A3.3 3.3 0 0 1 6.3 3.5M3 8.5h3.2v4H3v-4ZM9.5 8.5V6.8a3.3 3.3 0 0 1 3.3-3.3M9.5 8.5h3.2v4H9.5v-4Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" />
    </svg>
  )
}

function RetryIcon(): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 6A5.5 5.5 0 1 0 13 10.7M13.2 2.8V6H10" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.35"/></svg>
}

function StarIcon({ filled }: { filled: boolean }): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m8 2 1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.4l-3.6 1.9.7-4.1-3-2.9 4.1-.6z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeLinejoin="round" strokeWidth="1.2"/></svg>
}

function ListenIcon(): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6.3h2.4L8.2 4v8L5.4 9.7H3zM10.7 5.6a3.2 3.2 0 0 1 0 4.8M12.5 3.8a5.8 5.8 0 0 1 0 8.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.25"/></svg>
}

export function SessionWorkspace({
  session,
  entries,
  currentProjectName,
  onSend,
  onBack,
  onHandoff,
  draft,
  onDraftChange,
  attachments,
  onAttachmentsChange,
  liveProcess,
  liveAgentResponse
}: SessionWorkspaceProps): React.JSX.Element {
  const [sendError, setSendError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [copiedId, setCopiedId] = useState('')
  const [starredIds, setStarredIds] = useState<ReadonlySet<string>>(new Set())
  const visibleEntries = useMemo(() => entries.filter((entry) => !entry.silent), [entries])
  const latestAssistantId = [...visibleEntries].reverse().find((entry) => entry.role === 'assistant')?.id
  const timelineRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const seenCount = useRef(visibleEntries.length)
  const agentOffline = !session.online
  const lastEntry = visibleEntries.at(-1)
  const lastEntryKey = lastEntry
    ? `${lastEntry.id}:${lastEntry.status}:${lastEntry.text.length}`
    : 'empty'
  const queuedTransport = session.deliveryMode === 'queued'
  // live 过程流指纹：块数/状态翻转都改变它，驱动贴底滚动跟上实时过程
  const liveProcessKey = liveProcess
    ? [
        liveProcess.turn,
        liveProcess.updatedAt,
        ...liveProcess.blocks.slice(-8).map((block) => [
          block.id,
          block.status,
          'summary' in block ? block.summary : '',
          'text' in block ? block.text : '',
          'output' in block ? block.output : ''
        ].join(':'))
      ].join('|')
    : ''
  const finalizedLiveResponse = liveAgentResponse && visibleEntries.some((entry) => (
    entry.role === 'assistant'
    && entry.status === 'complete'
    && entry.timestamp >= liveAgentResponse.startedAt - 5_000
    && entry.text.trim() === liveAgentResponse.text.trim()
  ))
  const visibleLiveResponse = liveAgentResponse && !finalizedLiveResponse ? liveAgentResponse : undefined
  const liveResponseKey = visibleLiveResponse
    ? `${visibleLiveResponse.id}:${visibleLiveResponse.status}:${visibleLiveResponse.text.length}:${visibleLiveResponse.updatedAt}`
    : ''
  const pendingVisibleUser = visibleEntries.at(-1)?.role === 'user'
  const lastVisibleTimestamp = visibleEntries.at(-1)?.timestamp ?? 0
  const showRunningPlaceholder = pendingVisibleUser
    && session.online
    && session.status === 'running'
    && !liveProcess?.blocks.length
    && !visibleLiveResponse
  const timelineItems = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = visibleEntries.map((entry, index) => ({
      type: 'entry',
      key: `entry:${entry.id}`,
      entry,
      timestamp: entry.timestamp,
      order: index * 10
    }))
    if (liveProcess?.blocks.length) {
      items.push({
        type: 'live-process',
        key: `live-process:${liveProcess.turn}`,
        timestamp: Math.max(liveProcess.updatedAt, lastVisibleTimestamp + 1),
        order: Number.MAX_SAFE_INTEGER - 1
      })
    } else if (showRunningPlaceholder) {
      items.push({
        type: 'running-placeholder',
        key: `running-placeholder:${session.id}`,
        timestamp: (visibleEntries.at(-1)?.timestamp ?? Date.now()) + 1,
        order: Number.MAX_SAFE_INTEGER
      })
    }
    if (visibleLiveResponse) {
      items.push({
        type: 'live-response',
        key: `live-response:${visibleLiveResponse.id}`,
        timestamp: Math.max(visibleLiveResponse.updatedAt, lastVisibleTimestamp + 2),
        order: Number.MAX_SAFE_INTEGER
      })
    }
    return items.sort((left, right) => (
      left.timestamp - right.timestamp
      || left.order - right.order
      || left.key.localeCompare(right.key)
    ))
  }, [visibleEntries, liveProcess, visibleLiveResponse, showRunningPlaceholder, session.id, lastVisibleTimestamp])
  const canSend = (session.online || queuedTransport) && !submitting
  const disconnected = agentOffline && !queuedTransport
  const queuedOffline = agentOffline && queuedTransport
  const notWaiting = !disconnected && !queuedOffline && !session.waiting && session.status !== 'running'
  const scrollTimelineTo = (top: number, behavior: ScrollBehavior = 'smooth'): void => {
    const element = timelineRef.current
    if (!element) return
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({ top, behavior })
      return
    }
    element.scrollTop = top
  }

  useLayoutEffect(() => {
    stickToBottom.current = true
    seenCount.current = visibleEntries.length
    setAwayFromBottom(false)
    scrollTimelineTo(timelineRef.current?.scrollHeight ?? 0, 'auto')
  }, [session.composerId, session.id])

  useEffect(() => {
    if (stickToBottom.current) {
      scrollTimelineTo(timelineRef.current?.scrollHeight ?? 0)
      seenCount.current = visibleEntries.length
    }
  }, [visibleEntries.length, lastEntryKey, session.composerId, session.id, liveProcessKey, liveResponseKey])

  useEffect(() => {
    if (!copiedId) return
    const timer = setTimeout(() => setCopiedId(''), 1_600)
    return () => clearTimeout(timer)
  }, [copiedId])

  const pendingBelow = awayFromBottom ? Math.max(0, visibleEntries.length - seenCount.current) : 0

  const jumpToBottom = (): void => {
    stickToBottom.current = true
    seenCount.current = visibleEntries.length
    setAwayFromBottom(false)
    scrollTimelineTo(timelineRef.current?.scrollHeight ?? 0)
  }

  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || !canSend) return
    setSubmitting(true)
    stickToBottom.current = true
    setSendError('')
    try {
      await onSend(text, attachments.length > 0 ? attachments : undefined)
      onDraftChange('')
      onAttachmentsChange([])
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const copyEntry = async (entry: ConversationEntry): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entry.text)
      setCopiedId(entry.id)
    } catch {
      setSendError('复制失败：系统剪贴板不可用')
    }
  }

  const quoteEntry = (entry: ConversationEntry): void => {
    const quoted = entry.text.split('\n').map((line) => `> ${line}`).join('\n')
    onDraftChange(draft ? `${draft}\n\n${quoted}\n\n` : `${quoted}\n\n`)
  }

  const retryEntry = async (entry: ConversationEntry): Promise<void> => {
    const index = visibleEntries.findIndex((candidate) => candidate.id === entry.id)
    const previousUser = visibleEntries.slice(0, index).reverse().find((candidate) => candidate.role === 'user')
    await quickSend(previousUser?.text
      ? `请重新处理上一条请求，保留有效结论并修正不足：\n\n${previousUser.text}`
      : '请重新检查并回答上一条请求，保留有效结论并修正不足。')
  }

  const listenEntry = (entry: ConversationEntry): void => {
    if (!('speechSynthesis' in window)) {
      setSendError('当前系统没有可用的朗读服务')
      return
    }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(entry.text)
    utterance.lang = 'zh-CN'
    window.speechSynthesis.speak(utterance)
  }

  const quickSend = async (text: string): Promise<void> => {
    if (!canSend || !text.trim()) return
    setSubmitting(true)
    stickToBottom.current = true
    setSendError('')
    try {
      await onSend(text.trim())
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const exportTranscript = (): void => {
    const header = `# ${session.displayName} · CH-${session.channelId} 会话记录\n\n导出于 ${new Date().toLocaleString()} · 共 ${visibleEntries.length} 条\n\n---\n`
    const body = visibleEntries.map((entry) => {
      const time = new Date(entry.timestamp).toLocaleString()
      return `\n## ${entryLabel(entry)} · ${time}\n\n${entry.text || '（空）'}\n`
    }).join('')
    const blob = new Blob([header + body], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `wedge-ch${session.channelId}-transcript.md`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const renderEntryRow = (entry: ConversationEntry, previous: ConversationEntry | undefined): React.JSX.Element => {
    const gap = previous ? entry.timestamp - previous.timestamp : Number.POSITIVE_INFINITY
    const needDivider = gap > DIVIDER_WINDOW_MS
    const grouped = !needDivider
      && previous?.role === entry.role
      && previous?.source === entry.source
      && gap < GROUP_WINDOW_MS
    const mine = entry.role === 'user'
    const rowTone = entry.role === 'error' ? 'error' : mine ? 'mine' : 'agent'
    const hasProcess = Boolean(entry.processBlocks?.length)
    const suggestions = entry.role === 'assistant' && entry.status === 'complete'
      ? suggestedActionsFromText(entry.text)
      : []
    return (
      <div key={`entry-wrap:${entry.id}`}>
        {needDivider && (
          <div className="chat-divider"><span>{dividerLabel(entry.timestamp)}</span></div>
        )}
        <div className={`chat-row chat-row--${rowTone} ${hasProcess ? 'chat-row--process' : ''} ${grouped ? 'is-grouped' : ''}`}>
          <span className="chat-gutter" aria-hidden={grouped}>
            {!grouped && (
              mine
                ? <i className="chat-face chat-face--mine">你</i>
                : entry.role === 'error'
                  ? <i className="chat-face chat-face--error">!</i>
                  : <span className="chat-face-avatar"><AgentAvatar avatarId={session.avatarId} name={session.displayName} crowned={session.isEffectiveLead ?? session.roleTemplateKey === 'lead'} size="sm" /></span>
            )}
          </span>
          <div className="chat-col">
            {!grouped && (
              <div className="chat-name">
                <strong>{entryLabel(entry)}</strong>
                <time>{formatClock(entry.timestamp)}</time>
              </div>
            )}
            <div className="chat-bubble">
              {hasProcess ? (
                <ProcessTurnCard
                  id={entry.turn ?? `entry:${entry.id}`}
                  blocks={entry.processBlocks}
                  startedAt={entry.processBlocks?.[0]?.startedAt}
                  updatedAt={entry.timestamp}
                  defaultOpen={entry.id === latestAssistantId}
                  compact
                />
              ) : null}
              {entry.text
                ? <ClampedMessage text={entry.text} />
                : entry.status === 'streaming' ? '正在生成…' : '（空）'}
              {entry.attachments && entry.attachments.length > 0 && (
                <div className="chat-attachments">
                  {entry.attachments.map((attachment) => (
                    <div key={attachment.id} className="chat-attachment">
                      {attachment.mimeType.startsWith('image/') && attachment.previewUrl ? (
                        <img src={attachment.previewUrl} alt={attachment.name} className="chat-attachment-image" />
                      ) : (
                        <div className="chat-attachment-file">
                          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.2"/><path d="M9 2v3h3" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>
                          <span>{attachment.name}</span>
                          <small>{formatFileSize(attachment.size)}</small>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {entry.status === 'streaming' && (
                <span className="typing-indicator"><i /><i /><i /></span>
              )}
              {suggestions.length ? (
                <div className="response-suggestions" aria-label="接下来可以">
                  <span>接下来可以：</span>
                  <div>{suggestions.map((suggestion, index) => (
                    <button key={`${entry.id}:suggestion:${index}`} onClick={() => onDraftChange(suggestion)}>
                      <i>{index + 1}</i><span>{suggestion}</span>
                    </button>
                  ))}</div>
                </div>
              ) : null}
            </div>
            <div className="chat-tail">
              {entry.text && (
                <button
                  className="chat-action"
                  title="复制消息全文"
                  onClick={() => void copyEntry(entry)}
                >
                  <CopyIcon /><span>{copiedId === entry.id ? '已复制' : '复制'}</span>
                </button>
              )}
              {entry.role === 'assistant' && entry.status === 'complete' && entry.text && (
                <button
                  className="chat-action"
                  title="引用这条消息回复"
                  onClick={() => quoteEntry(entry)}
                >
                  <QuoteIcon /><span>引用</span>
                </button>
              )}
              {entry.role === 'assistant' && entry.status === 'complete' && entry.text ? (
                <>
                  <button className="chat-action" title="重新生成这条回答" onClick={() => void retryEntry(entry)}><RetryIcon /><span>重试</span></button>
                  <button className={`chat-action ${starredIds.has(entry.id) ? 'is-active' : ''}`} title={starredIds.has(entry.id) ? '取消收藏' : '收藏回答'} onClick={() => setStarredIds((current) => {
                    const next = new Set(current)
                    if (next.has(entry.id)) next.delete(entry.id)
                    else next.add(entry.id)
                    return next
                  })}><StarIcon filled={starredIds.has(entry.id)} /><span>收藏</span></button>
                  <button className="chat-action" title="朗读回答" onClick={() => listenEntry(entry)}><ListenIcon /><span>朗读</span></button>
                </>
              ) : null}
              <span className={`chat-state ${entry.status === 'failed' ? 'is-failed' : ''}`}>
                {entry.status === 'pending' && '发送中…'}
                {entry.status === 'complete' && mine && `已发送 ${formatClock(entry.timestamp)}`}
                {entry.status === 'streaming' && '实时生成中'}
                {entry.status === 'failed' && `发送失败：${entry.error || '未知原因'}`}
              </span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const renderLiveProcessRow = (): React.JSX.Element => (
    <div className="chat-row chat-row--agent live-process-row" key={`live-process:${liveProcess?.turn ?? session.id}`}>
      <span className="chat-gutter">
        <span className="chat-face-avatar"><AgentAvatar avatarId={session.avatarId} name={session.displayName} crowned={session.isEffectiveLead ?? session.roleTemplateKey === 'lead'} size="sm" /></span>
      </span>
      <div className="chat-col">
        <div className="chat-name">
          <strong>Agent</strong>
          <time>{formatClock(liveProcess?.startedAt ?? Date.now())}</time>
        </div>
        <div className="chat-bubble">
          <ProcessTurnCard
            id={liveProcess?.turn ?? `live:${session.id}`}
            blocks={liveProcess?.blocks}
            startedAt={liveProcess?.startedAt}
            updatedAt={liveProcess?.updatedAt ?? Date.now()}
            defaultOpen
            compact
            live
          />
        </div>
      </div>
    </div>
  )

  const renderLiveResponseRow = (): React.JSX.Element => {
    const response = visibleLiveResponse!
    return (
    <div className="chat-row chat-row--agent live-response-row" key={`live-response:${response.id}`}>
      <span className="chat-gutter">
        <span className="chat-face-avatar"><AgentAvatar avatarId={session.avatarId} name={session.displayName} crowned={session.isEffectiveLead ?? session.roleTemplateKey === 'lead'} size="sm" /></span>
      </span>
      <div className="chat-col">
        <div className="chat-name"><strong>Agent</strong><time>{formatClock(response.startedAt)}</time></div>
        <div className="chat-bubble"><LiveAgentResponse response={response} /></div>
        <div className="chat-tail"><span className="chat-state">{response.status === 'streaming' ? 'Cursor 实时生成中' : '正在归档…'}</span></div>
      </div>
    </div>
    )
  }

  const renderRunningPlaceholder = (): React.JSX.Element => (
    <div className="chat-row chat-row--agent live-process-row" key={`running-placeholder:${session.id}`}>
      <span className="chat-gutter">
        <span className="chat-face-avatar"><AgentAvatar avatarId={session.avatarId} name={session.displayName} crowned={session.isEffectiveLead ?? session.roleTemplateKey === 'lead'} size="sm" /></span>
      </span>
      <div className="chat-col">
        <div className="chat-name">
          <strong>Agent</strong>
          <span className="live-process-badge"><i className="process-pulse" />正在处理</span>
        </div>
        <div className="chat-bubble live-process-idle">
          <span className="typing-indicator"><i /><i /><i /></span>
          <span className="live-process-idle__hint">过程流就绪后将在此实时展示</span>
        </div>
      </div>
    </div>
  )

  const renderTimelineItems = (): React.JSX.Element[] => {
    let previousEntry: ConversationEntry | undefined
    return timelineItems.map((item) => {
      if (item.type === 'entry') {
        const rendered = renderEntryRow(item.entry, previousEntry)
        previousEntry = item.entry
        return rendered
      }
      if (item.type === 'live-process') return renderLiveProcessRow()
      if (item.type === 'live-response') return renderLiveResponseRow()
      return renderRunningPlaceholder()
    })
  }

  return (
    <section className="workspace-main">
      <header className="workspace-header">
        <button className="workspace-back" onClick={onBack} aria-label="返回会话列表">←</button>
        <AgentAvatar
          avatarId={session.avatarId}
          name={session.displayName}
          crowned={session.isEffectiveLead ?? session.roleTemplateKey === 'lead'}
          online={session.online}
          size="lg"
        />
        <div className="workspace-identity">
          <div>
            <h1>{session.displayName}</h1>
            <span className={`status-pill status-pill--${session.status}`}>{statusLabel(session.status)}</span>
          </div>
          <p>
            {session.composerTitle || session.id} · {session.roleName} · {session.online
              ? formatRelativeTime(session.lastSeenAt)
              : 'Agent 当前离线'}
          </p>
        </div>
      </header>

      <div
        className={disconnected
          ? 'workspace-warning'
          : queuedOffline || notWaiting
            ? 'workspace-warning workspace-warning--idle'
            : 'workspace-warning workspace-warning--hidden'}
        aria-hidden={!disconnected && !queuedOffline && !notWaiting}
      >
        <strong>{queuedOffline
          ? 'Cursor Agent 已离线，消息会先进入队列'
          : agentOffline
          ? 'Cursor Agent 已离线，这条会话此刻不能发送'
          : 'Cursor Agent 在线，但没有进入待命'}</strong>
        <span>{queuedOffline
          ? '只要该 Cursor 会话继续调用 SG Team 的 check_messages，就会自动取走；不会因为心跳过期阻止发送。'
          : disconnected
          ? '会话与本地时间线仍保留，重新启动对应 Cursor Agent 后可以继续。'
          : `消息会排队，直到对应 Cursor 会话调用 SG Team 的 check_messages。`}</span>
      </div>

      <div className="workspace-timeline-wrap">
        <div
          className="workspace-timeline"
          ref={timelineRef}
          onScroll={(event) => {
            const element = event.currentTarget
            const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 90
            stickToBottom.current = nearBottom
            if (nearBottom) seenCount.current = visibleEntries.length
            setAwayFromBottom(!nearBottom)
          }}
        >
          {timelineItems.length === 0 ? (
            <div className="timeline-empty">
              <h2>本轮尚无消息</h2>
              <p>这里只显示当前 TeamRun 的新消息；旧对话仍保留在 Cursor 历史中。</p>
            </div>
          ) : renderTimelineItems()}
        </div>
        {awayFromBottom && visibleEntries.length > 0 && (
          <button className="timeline-jump" role="status" aria-live="polite" onClick={jumpToBottom}>
            {pendingBelow > 0 ? `${pendingBelow} 条新消息` : '回到底部'} ↓
          </button>
        )}
      </div>

      <ComposerWorkbench
        session={session}
        currentProjectName={currentProjectName}
        draft={draft}
        canSend={canSend}
        notWaiting={notWaiting}
        submitting={submitting}
        sendError={sendError}
        onDraftChange={onDraftChange}
        onSubmit={() => void submit()}
        onExport={exportTranscript}
        exportEnabled={visibleEntries.length > 0}
        onHandoff={onHandoff}
        attachments={attachments}
        onAttachmentsChange={onAttachmentsChange}
        onQuickSend={(text) => void quickSend(text)}
      />
    </section>
  )
}
