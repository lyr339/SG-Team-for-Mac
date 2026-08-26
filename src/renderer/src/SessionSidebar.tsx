import { useMemo, useState } from 'react'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import { SessionRailCard } from './SessionRailCard'

type SessionFilter = 'all' | 'online' | 'offline'

interface SessionSidebarProps {
  snapshot: DesktopSnapshot
  selectedChannelId?: string
  onSelectSession: (channelId: string) => void
}

export function SessionSidebar({
  snapshot,
  selectedChannelId,
  onSelectSession
}: SessionSidebarProps): React.JSX.Element {
  const [filter, setFilter] = useState<SessionFilter>('all')
  const onlineCount = snapshot.sessions.filter((session) => session.online).length
  const offlineCount = snapshot.sessions.length - onlineCount
  const sessions = useMemo(() => snapshot.sessions.filter((session) => {
    if (filter === 'online') return session.online
    if (filter === 'offline') return !session.online
    return true
  }), [filter, snapshot.sessions])

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
        {sessions.length ? sessions.map((session) => (
          <SessionRailCard
            key={session.id}
            session={session}
            selected={session.channelId === selectedChannelId}
            onOpen={onSelectSession}
          />
        )) : (
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
