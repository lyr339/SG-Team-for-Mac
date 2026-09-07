import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import { SessionRailCard } from './SessionRailCard'
import { Collapsible } from './inspector/Collapsible'
import { InspectorSectionHeader, InspectorState } from './inspector/InspectorState'
import { useNow } from './inspector/use-now'
import { SessionsIcon } from './UiIcons'
import {
  applySessionOrder,
  moveSessionWithinGroup,
  persistSessionOrder,
  readSessionOrder
} from './session-order'
import {
  SESSION_RAIL_GROUPS,
  sessionRailGroupOf,
  sessionRailSummary,
  type SessionRailGroupId
} from './session-rail-view'

interface SessionSidebarProps {
  snapshot: DesktopSnapshot
  selectedChannelId?: string
  onSelectSession: (channelId: string) => void
  /** 空态的去处：还没有任何会话时，把用户带到「运行」页去创建。 */
  onOpenRun?: () => void
}

const COLLAPSED_GROUPS_STORAGE_KEY = 'shiguang.sessionGroups.collapsed.v1'

function readCollapsedGroups(): ReadonlySet<SessionRailGroupId> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY) ?? '[]')
    const valid = new Set(SESSION_RAIL_GROUPS.map((group) => group.id))
    return new Set(Array.isArray(parsed)
      ? parsed.filter((id): id is SessionRailGroupId => typeof id === 'string' && valid.has(id as SessionRailGroupId))
      : [])
  } catch {
    return new Set()
  }
}

function persistCollapsedGroups(groups: ReadonlySet<SessionRailGroupId>): void {
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

/** 方向键在可见行之间漫游；折叠组内的行处于 inert，不在候选里。 */
function moveRowFocus(list: HTMLElement, current: HTMLElement, key: string): boolean {
  const rows = Array.from(list.querySelectorAll<HTMLButtonElement>('.session-row'))
    .filter((row) => !row.closest('[inert]'))
  const index = rows.indexOf(current as HTMLButtonElement)
  if (index < 0 || !rows.length) return false
  let next: HTMLButtonElement | undefined
  if (key === 'ArrowDown') next = rows[Math.min(rows.length - 1, index + 1)]
  else if (key === 'ArrowUp') next = rows[Math.max(0, index - 1)]
  else if (key === 'Home') next = rows[0]
  else if (key === 'End') next = rows[rows.length - 1]
  if (!next || next === current) return next !== undefined
  next.focus()
  next.scrollIntoView?.({ block: 'nearest' })
  return true
}

/**
 * 会话侧栏：一份名册。状态事实决定动态分组（执行中 / 需关注 / 待命 / 离线），
 * 手动顺序只决定同组内的相对位置；分组标题吸顶、可折叠并持久化；
 * 方向键在行间漫游，Enter / 空格打开；组内拖拽重排，跨组不伪造运行状态。
 */
export function SessionSidebar({
  snapshot,
  selectedChannelId,
  onSelectSession,
  onOpenRun
}: SessionSidebarProps): React.JSX.Element {
  const [order, setOrder] = useState<string[] | undefined>(() => readSessionOrder())
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<SessionRailGroupId>>(() => readCollapsedGroups())
  const [dragOrigin, setDragOrigin] = useState<{ sessionId: string; groupId: SessionRailGroupId } | null>(null)
  const [insertionIndex, setInsertionIndex] = useState<number | null>(null)
  const listRef = useRef<HTMLElement>(null)
  const now = useNow(60_000)

  const orderedSessions = useMemo(
    () => applySessionOrder(snapshot.sessions, order, (session) => session.id),
    [order, snapshot.sessions]
  )
  const groups = useMemo(() => SESSION_RAIL_GROUPS.flatMap((group) => {
    const members = orderedSessions.filter((session) => sessionRailGroupOf(session) === group.id)
    return members.length ? [{ ...group, sessions: members }] : []
  }), [orderedSessions])
  const summary = useMemo(() => sessionRailSummary(snapshot.sessions), [snapshot.sessions])
  const rosterSignature = useMemo(
    () => snapshot.sessions.map((session) => session.id).sort().join('\u0000'),
    [snapshot.sessions]
  )
  const draggedCurrentSession = dragOrigin
    ? orderedSessions.find((session) => session.id === dragOrigin.sessionId)
    : undefined
  const draggedCurrentGroupId = draggedCurrentSession ? sessionRailGroupOf(draggedCurrentSession) : undefined
  // 选中行进入 Tab 序列；没有选中行（或它在折叠组里）时把第一行交给 Tab。
  const selectedVisible = groups.some((group) => !collapsedGroups.has(group.id)
    && group.sessions.some((session) => session.channelId === selectedChannelId))
  const firstVisibleId = groups.find((group) => !collapsedGroups.has(group.id))?.sessions[0]?.id

  const resetDrag = (): void => {
    setDragOrigin(null)
    setInsertionIndex(null)
  }

  // 席位增删或被拖行自身换组才中止；其他会话的实时状态变化不打断手势。
  useEffect(() => resetDrag(), [rosterSignature])
  useEffect(() => {
    if (dragOrigin && draggedCurrentGroupId !== dragOrigin.groupId) resetDrag()
  }, [dragOrigin, draggedCurrentGroupId])

  const toggleGroup = (groupId: SessionRailGroupId): void => {
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      persistCollapsedGroups(next)
      return next
    })
  }

  const handleDrop = (groupId: SessionRailGroupId, boundary: number): void => {
    if (!dragOrigin || dragOrigin.groupId !== groupId) return
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

  const onListKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const target = event.target as HTMLElement | null
    if (!target?.classList.contains('session-row') || !listRef.current) return
    if (moveRowFocus(listRef.current, target, event.key)) event.preventDefault()
  }

  const lastGroup = groups.at(-1)
  const tailDropEnabled = Boolean(lastGroup
    && dragOrigin?.groupId === lastGroup.id
    && !collapsedGroups.has(lastGroup.id))
  const connecting = snapshot.connection.state === 'connecting' || snapshot.connection.state === 'reconnecting'

  return (
    <aside className="context-sidebar session-pane" aria-label="Cursor 会话">
      <InspectorSectionHeader
        title="会话"
        hint={summary || (connecting ? '正在连接通道…' : '还没有会话')}
        aside={snapshot.sessions.length ? <b className="session-pane__count">{snapshot.sessions.length}</b> : null}
      />
      <nav
        ref={listRef}
        className="session-list"
        aria-label="Cursor 会话"
        onKeyDown={onListKeyDown}
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
        {groups.length ? groups.map((group) => {
          const collapsed = collapsedGroups.has(group.id)
          const markerActive = dragOrigin?.groupId === group.id
          return (
            <section key={group.id} className={`session-group is-${group.id}${collapsed ? ' is-collapsed' : ''}`}>
              <button
                type="button"
                className="session-group__header"
                onClick={() => toggleGroup(group.id)}
                aria-expanded={!collapsed}
                title={`${group.detail}${collapsed ? '（已折叠，点击展开）' : ''}`}
              >
                <span>{group.label}</span>
                <b>{group.sessions.length}</b>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" /></svg>
              </button>
              <Collapsible open={!collapsed}>
                <div
                  className="session-group__list"
                  aria-label={`${group.label}会话`}
                  onDragOver={(event) => {
                    if (!markerActive) return
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
                    if (!markerActive) return
                    event.preventDefault()
                    handleDrop(group.id, boundaryAt(event.currentTarget, event.clientY))
                  }}
                >
                  {group.sessions.map((session, index) => {
                    const dragging = markerActive && dragOrigin?.sessionId === session.id
                    const dropBefore = markerActive && insertionIndex === index
                    const dropAfter = markerActive && insertionIndex === group.sessions.length && index === group.sessions.length - 1
                    const selected = session.channelId === selectedChannelId
                    return (
                      <div
                        key={session.id}
                        className={`session-list__slot${dragging ? ' is-dragging' : ''}${dropBefore ? ' is-drop-before' : ''}${dropAfter ? ' is-drop-after' : ''}`}
                      >
                        <SessionRailCard
                          session={session}
                          selected={selected}
                          onOpen={onSelectSession}
                          now={now}
                          tabIndex={selected || (!selectedVisible && session.id === firstVisibleId) ? 0 : -1}
                          draggable={group.sessions.length > 1}
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
              </Collapsible>
            </section>
          )
        }) : (
          <InspectorState
            tone={connecting ? 'loading' : 'neutral'}
            icon={<SessionsIcon />}
            title={connecting ? '正在连接通道…' : '还没有会话'}
            hint={connecting
              ? '拾光正在等待 SG Team 通道就绪'
              : '在「运行」页创建团队或独立批次后，每个席位会作为一行出现在这里'}
            action={!connecting && onOpenRun
              ? <button type="button" className="inspector-link" onClick={onOpenRun}>前往运行页</button>
              : undefined}
          />
        )}
      </nav>
    </aside>
  )
}
