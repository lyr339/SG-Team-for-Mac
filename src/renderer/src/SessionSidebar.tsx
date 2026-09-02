import { useEffect, useMemo, useState } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import { isAgentOnDuty, isProcessingPhase } from '../../domain/channel-message'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import { SessionRailCard } from './SessionRailCard'
import {
  applySessionOrder,
  moveSessionWithinGroup,
  persistSessionOrder,
  readSessionOrder
} from './session-order'

type SessionFilter = 'all' | 'online' | 'offline'
type SessionGroupId = 'active' | 'attention' | 'waiting' | 'offline'

interface SessionSidebarProps {
  snapshot: DesktopSnapshot
  selectedChannelId?: string
  onSelectSession: (channelId: string) => void
}

const COLLAPSED_GROUPS_STORAGE_KEY = 'shiguang.sessionGroups.collapsed.v1'
const SESSION_GROUPS: ReadonlyArray<{ id: SessionGroupId; label: string; detail: string }> = [
  { id: 'active', label: '执行中', detail: '正在启动、恢复或处理任务' },
  { id: 'attention', label: '需关注', detail: '等待拍板、验收或重新进入待命' },
  { id: 'waiting', label: '待命', detail: '已在线并持续等待新消息' },
  { id: 'offline', label: '离线', detail: '当前没有可信的 Cursor 运行时活性' }
]

/** 分类只投影现有运行事实，不改变 Agent 状态；离线证据始终拥有最高优先级。 */
function sessionGroupOf(session: Pick<AgentSession,
  'online' | 'status' | 'runtimeEvidence' | 'waiting' | 'connectionPhase'
>): SessionGroupId {
  if (!session.online || session.status === 'offline' || session.status === 'stopped' || session.runtimeEvidence === 'stopped') return 'offline'
  if (session.status === 'blocked' || session.status === 'review') return 'attention'
  if (session.status === 'running' || session.status === 'starting' || session.status === 'reviving'
    || isProcessingPhase(session.connectionPhase ?? '')) return 'active'
  if (session.status === 'waiting' || isAgentOnDuty(session)) return 'waiting'
  return 'attention'
}

function readCollapsedGroups(): ReadonlySet<SessionGroupId> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY) ?? '[]')
    const valid = new Set(SESSION_GROUPS.map((group) => group.id))
    return new Set(Array.isArray(parsed)
      ? parsed.filter((id): id is SessionGroupId => typeof id === 'string' && valid.has(id as SessionGroupId))
      : [])
  } catch {
    return new Set()
  }
}

function persistCollapsedGroups(groups: ReadonlySet<SessionGroupId>): void {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify([...groups]))
  } catch { /* 当前进程内的折叠状态仍然有效。 */ }
}

function boundaryAt(list: HTMLElement, clientY: number): number {
  const slots = Array.from(list.querySelectorAll<HTMLElement>('.session-list__slot'))
  const before = slots.findIndex((slot) => {
    const rect = slot.getBoundingClientRect()
    return clientY < rect.top + rect.height / 2
  })
  return before < 0 ? slots.length : before
}

function scrollNearEdge(list: HTMLElement, clientY: number): void {
  const rect = list.getBoundingClientRect()
  const edge = Math.min(44, rect.height / 4)
  if (clientY < rect.top + edge) list.scrollTop -= 12
  else if (clientY > rect.bottom - edge) list.scrollTop += 12
}

/**
 * 会话侧栏：状态事实决定动态分组；手动顺序只决定同组卡片的相对位置。
 * 全部视图支持组内拖拽，在线/离线筛选保持只读，避免跨组拖拽伪造运行状态。
 */
export function SessionSidebar({
  snapshot,
  selectedChannelId,
  onSelectSession
}: SessionSidebarProps): React.JSX.Element {
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [order, setOrder] = useState<string[] | undefined>(() => readSessionOrder())
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<SessionGroupId>>(() => readCollapsedGroups())
  const [dragOrigin, setDragOrigin] = useState<{ sessionId: string; groupId: SessionGroupId } | null>(null)
  const [insertionIndex, setInsertionIndex] = useState<number | null>(null)

  const onlineCount = snapshot.sessions.filter((session) => sessionGroupOf(session) !== 'offline').length
  const offlineCount = snapshot.sessions.length - onlineCount
  const orderedSessions = useMemo(
    () => applySessionOrder(snapshot.sessions, order, (session) => session.id),
    [order, snapshot.sessions]
  )
  const sessions = useMemo(() => orderedSessions.filter((session) => {
    const groupId = sessionGroupOf(session)
    if (filter === 'online') return groupId !== 'offline'
    if (filter === 'offline') return groupId === 'offline'
    return true
  }), [filter, orderedSessions])
  const groups = useMemo(() => SESSION_GROUPS.flatMap((group) => {
    const members = sessions.filter((session) => sessionGroupOf(session) === group.id)
    return members.length ? [{ ...group, sessions: members }] : []
  }), [sessions])
  const rosterSignature = useMemo(
    () => snapshot.sessions.map((session) => session.id).sort().join('\u0000'),
    [snapshot.sessions]
  )
  const draggedCurrentSession = dragOrigin
    ? orderedSessions.find((session) => session.id === dragOrigin.sessionId)
    : undefined
  const draggedCurrentGroupId = draggedCurrentSession ? sessionGroupOf(draggedCurrentSession) : undefined

  const resetDrag = (): void => {
    setDragOrigin(null)
    setInsertionIndex(null)
  }

  // 席位增删或被拖卡片自身换组才中止；其他会话的实时状态变化不打断手势。
  useEffect(() => resetDrag(), [rosterSignature])
  useEffect(() => {
    if (dragOrigin && draggedCurrentGroupId !== dragOrigin.groupId) resetDrag()
  }, [dragOrigin, draggedCurrentGroupId])

  const toggleGroup = (groupId: SessionGroupId): void => {
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      persistCollapsedGroups(next)
      return next
    })
  }

  const handleDrop = (groupId: SessionGroupId, boundary: number): void => {
    if (!dragOrigin || dragOrigin.groupId !== groupId || filter !== 'all') return
    const group = groups.find((candidate) => candidate.id === groupId)
    if (!group) return resetDrag()
    const ids = orderedSessions.map((session) => session.id)
    const groupIds = group.sessions.map((session) => session.id)
    const next = moveSessionWithinGroup(ids, groupIds, dragOrigin.sessionId, boundary)
    if (next.some((id, index) => id !== ids[index])) {
      setOrder(next)
      persistSessionOrder(next)
    }
    resetDrag()
  }

  const lastGroup = groups.at(-1)
  const tailDropEnabled = Boolean(filter === 'all'
    && lastGroup
    && dragOrigin?.groupId === lastGroup.id
    && !collapsedGroups.has(lastGroup.id))

  return (
    <aside className="context-sidebar session-pane">
      <header className="session-pane__header">
        <div><strong>Cursor 会话</strong><span>{snapshot.sessions.length}</span></div>
      </header>
      <div className="session-filters">
        <button className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>全部 <span>{snapshot.sessions.length}</span></button>
        <button className={filter === 'online' ? 'is-active' : ''} onClick={() => setFilter('online')}>在线 <span>{onlineCount}</span></button>
        <button className={filter === 'offline' ? 'is-active' : ''} onClick={() => setFilter('offline')}>离线 <span>{offlineCount}</span></button>
      </div>
      <nav
        className="session-list"
        aria-label="Cursor 会话"
        onDragOver={(event) => {
          if (event.target !== event.currentTarget || !tailDropEnabled || !lastGroup) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          scrollNearEdge(event.currentTarget, event.clientY)
          setInsertionIndex(lastGroup.sessions.length)
        }}
        onDrop={(event) => {
          if (event.target !== event.currentTarget || !tailDropEnabled || !lastGroup) return
          event.preventDefault()
          handleDrop(lastGroup.id, lastGroup.sessions.length)
        }}
      >
        {sessions.length ? groups.map((group) => {
          const collapsed = collapsedGroups.has(group.id)
          const showHeader = filter !== 'offline'
          const markerActive = dragOrigin?.groupId === group.id
          return (
            <section key={group.id} className={`session-group is-${group.id}${collapsed ? ' is-collapsed' : ''}`}>
              {showHeader ? (
                <button
                  type="button"
                  className="session-group__header"
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={!collapsed}
                  title={group.detail}
                >
                  <i className="session-group__marker" aria-hidden="true" />
                  <strong>{group.label}</strong>
                  <em>{group.sessions.length}</em>
                  <i className="session-group__rule" aria-hidden="true" />
                  <svg viewBox="0 0 14 14" aria-hidden="true"><path d="m3.5 5 3.5 3.5L10.5 5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" /></svg>
                </button>
              ) : null}
              {!collapsed || !showHeader ? (
                <div
                  className={`session-group__list${showHeader ? '' : ' is-flat'}`}
                  aria-label={showHeader ? `${group.label}会话` : undefined}
                  onDragOver={(event) => {
                    if (!markerActive || filter !== 'all') return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    const scroller = event.currentTarget.closest<HTMLElement>('.session-list') ?? event.currentTarget
                    scrollNearEdge(scroller, event.clientY)
                    setInsertionIndex(boundaryAt(event.currentTarget, event.clientY))
                  }}
                  onDragLeave={(event) => {
                    if (!markerActive) return
                    const rect = event.currentTarget.getBoundingClientRect()
                    if (
                      event.clientX < rect.left || event.clientX > rect.right
                      || event.clientY < rect.top || event.clientY > rect.bottom
                    ) setInsertionIndex(null)
                  }}
                  onDrop={(event) => {
                    if (!markerActive || filter !== 'all') return
                    event.preventDefault()
                    handleDrop(group.id, boundaryAt(event.currentTarget, event.clientY))
                  }}
                >
                  {group.sessions.map((session, index) => {
                    const dragging = markerActive && dragOrigin?.sessionId === session.id
                    const dropBefore = markerActive && insertionIndex === index
                    const dropAfter = markerActive && insertionIndex === group.sessions.length && index === group.sessions.length - 1
                    return (
                      <div
                        key={session.id}
                        className={`session-list__slot${dragging ? ' is-dragging' : ''}${dropBefore ? ' is-drop-before' : ''}${dropAfter ? ' is-drop-after' : ''}`}
                      >
                        <SessionRailCard
                          session={session}
                          selected={session.channelId === selectedChannelId}
                          onOpen={onSelectSession}
                          draggable={filter === 'all'}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = 'move'
                            event.dataTransfer.setData('application/x-shiguang-session', 'reorder')
                            setDragOrigin({ sessionId: session.id, groupId: group.id })
                          }}
                          onDragEnd={resetDrag}
                        />
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </section>
          )
        }) : (
          <div className="session-list__empty">
            {snapshot.connection.state === 'connecting' || snapshot.connection.state === 'reconnecting'
              ? '正在连接通道…'
              : '这个分组还没有会话'}
          </div>
        )}
      </nav>
    </aside>
  )
}
