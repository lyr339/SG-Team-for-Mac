import { useEffect, useMemo, useState } from 'react'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import { SessionRailCard } from './SessionRailCard'
import {
  applySessionOrder,
  moveSessionToBoundary,
  persistSessionOrder,
  readSessionOrder
} from './session-order'

type SessionFilter = 'all' | 'online' | 'offline'

interface SessionSidebarProps {
  snapshot: DesktopSnapshot
  selectedChannelId?: string
  onSelectSession: (channelId: string) => void
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
 * 会话侧栏：全部视图支持卡片拖拽重排（HTML5 DnD）。
 * 顺序按 sessionId 持久化到 localStorage；过滤视图按语义分组不重排。
 * 列表统一将指针映射到 N + 1 个插入边界，覆盖卡片、间隙和列表空白区。
 */
export function SessionSidebar({
  snapshot,
  selectedChannelId,
  onSelectSession
}: SessionSidebarProps): React.JSX.Element {
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [order, setOrder] = useState<string[] | undefined>(() => readSessionOrder())
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null)
  const [insertionIndex, setInsertionIndex] = useState<number | null>(null)

  const onlineCount = snapshot.sessions.filter((session) => session.online).length
  const offlineCount = snapshot.sessions.length - onlineCount
  // 全部视图应用手动顺序；过滤视图保持快照原序（子集重排无意义）
  const orderedSessions = useMemo(() => (
    filter === 'all'
      ? applySessionOrder(snapshot.sessions, order, (session) => session.id)
      : snapshot.sessions
  ), [filter, order, snapshot.sessions])
  const sessions = useMemo(() => orderedSessions.filter((session) => {
    if (filter === 'online') return session.online
    if (filter === 'offline') return !session.online
    return true
  }), [filter, orderedSessions])

  const rosterSignature = useMemo(
    () => snapshot.sessions.map((session) => session.id).sort().join('\u0000'),
    [snapshot.sessions]
  )

  // 仅席位集合真正变化时中止拖拽；状态、用量等实时更新不影响手势。
  useEffect(() => {
    setDraggedSessionId(null)
    setInsertionIndex(null)
  }, [rosterSignature])

  const resetDrag = (): void => {
    setDraggedSessionId(null)
    setInsertionIndex(null)
  }

  const handleDrop = (boundary: number): void => {
    if (draggedSessionId === null) return
    const ids = sessions.map((session) => session.id)
    const next = moveSessionToBoundary(ids, draggedSessionId, boundary)
    if (next.some((id, index) => id !== ids[index])) {
      setOrder(next)
      persistSessionOrder(next)
    }
    resetDrag()
  }

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
          if (draggedSessionId === null) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          scrollNearEdge(event.currentTarget, event.clientY)
          setInsertionIndex(boundaryAt(event.currentTarget, event.clientY))
        }}
        onDragLeave={(event) => {
          if (draggedSessionId === null) return
          const rect = event.currentTarget.getBoundingClientRect()
          if (
            event.clientX < rect.left || event.clientX > rect.right
            || event.clientY < rect.top || event.clientY > rect.bottom
          ) setInsertionIndex(null)
        }}
        onDrop={(event) => {
          if (draggedSessionId === null) return
          event.preventDefault()
          handleDrop(boundaryAt(event.currentTarget, event.clientY))
        }}
      >
        {sessions.length ? sessions.map((session, index) => {
          const dragging = draggedSessionId === session.id
          const dropBefore = insertionIndex === index
          const dropAfter = insertionIndex === sessions.length && index === sessions.length - 1
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
                  // 自定义 MIME：拖到外部应用只得到应用名而非裸索引数字；
                  // 拖拽状态经 React state 传递，dataTransfer 仅作 DnD 协议要求
                  event.dataTransfer.setData('application/x-shiguang-session', 'reorder')
                  setDraggedSessionId(session.id)
                }}
                onDragEnd={resetDrag}
              />
            </div>
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
