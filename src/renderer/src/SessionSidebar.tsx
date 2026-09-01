import { useEffect, useMemo, useState } from 'react'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import { SessionRailCard } from './SessionRailCard'
import { applySessionOrder, persistSessionOrder, readSessionOrder } from './session-order'

type SessionFilter = 'all' | 'online' | 'offline'

interface SessionSidebarProps {
  snapshot: DesktopSnapshot
  selectedChannelId?: string
  onSelectSession: (channelId: string) => void
}

/**
 * 会话侧栏：全部视图支持卡片拖拽重排（HTML5 DnD，dataTransfer 只传索引）。
 * 顺序按 sessionId 持久化到 localStorage；过滤视图按语义分组不重排。
 * 拖拽期间用行内插入占位（无动画重排），松手落位——反馈即时且不依赖 FLIP。
 */
export function SessionSidebar({
  snapshot,
  selectedChannelId,
  onSelectSession
}: SessionSidebarProps): React.JSX.Element {
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [order, setOrder] = useState<string[] | undefined>(() => readSessionOrder())
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

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

  // 拖拽中途会话集合变化（席位增删）：中止拖拽而非落位到错误索引
  useEffect(() => {
    setDragIndex(null)
    setOverIndex(null)
  }, [snapshot.sessions])

  const handleDrop = (): void => {
    if (dragIndex === null || overIndex === null || dragIndex === overIndex) {
      setDragIndex(null)
      setOverIndex(null)
      return
    }
    const ids = sessions.map((session) => session.id)
    const [moved] = ids.splice(dragIndex, 1)
    ids.splice(overIndex, 0, moved!)
    setOrder(ids)
    persistSessionOrder(ids)
    setDragIndex(null)
    setOverIndex(null)
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
      <nav className="session-list" aria-label="Cursor 会话">
        {sessions.length ? sessions.map((session, index) => {
          const dragging = dragIndex === index
          const showDropBefore = overIndex === index && dragIndex !== null && dragIndex !== index
          return (
            <div
              key={session.id}
              className={`session-list__slot${dragging ? ' is-dragging' : ''}`}
              onDragOver={(event) => {
                if (dragIndex === null) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setOverIndex(index)
              }}
              onDrop={(event) => {
                if (dragIndex === null) return
                event.preventDefault()
                setOverIndex(index)
                handleDrop()
              }}
            >
              {showDropBefore ? <div className="session-list__drop-marker" aria-hidden="true" /> : null}
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
                  setDragIndex(index)
                }}
                onDragEnd={() => {
                  setDragIndex(null)
                  setOverIndex(null)
                }}
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
