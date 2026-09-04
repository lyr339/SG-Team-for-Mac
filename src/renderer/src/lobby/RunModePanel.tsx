import { useState } from 'react'
import { hasInFlightExecution, isAgentOnDuty } from '../../../domain/channel-message'
import type { TeamControlSnapshot, TeamMemberView } from '../../../domain/team-control'
import { BrandMark } from '../BrandMark'
import { formatRelativeTime } from '../format'

export type RunModeSeatState = 'waiting' | 'working' | 'offline' | 'unconfirmed'

export interface RunModeSeat {
  channelId: string
  name: string
  state: RunModeSeatState
  lastSeenAt?: number
}

export const SEAT_STATE_LABEL: Record<RunModeSeatState, string> = {
  waiting: '待命中',
  working: '执行中',
  offline: '离线',
  unconfirmed: '待确认'
}

/** 席位运行态归一：与服务端守卫/围栏口径一致（在岗 / 执行租约 / 无证据 / 离线）。 */
export function runModeSeatOf(member: TeamMemberView): RunModeSeat {
  const channelId = member.binding?.channelId ?? member.slot.channelId ?? '?'
  const runtime = member.runtime
  const state: RunModeSeatState = !runtime
    ? 'unconfirmed'
    : isAgentOnDuty(runtime) && runtime.waiting
      ? 'waiting'
      : runtime.online || hasInFlightExecution(runtime)
        ? 'working'
        : 'offline'
  return { channelId, name: member.slot.name, state, lastSeenAt: runtime?.lastSeenAt }
}

interface RunModePanelProps {
  team: TeamControlSnapshot
  busy: boolean
  error?: string
  onViewSessions: () => void
  onSwitchToTeam: () => Promise<void> | void
  onEndRun: () => Promise<void> | void
}

/**
 * 独立模式面板（替代此前整页拦截的「当前正在使用独立会话」）。
 *
 * 切换模式不再以「全部离线」为硬前提：会话围栏让旧会话在下一次轮询自行退出，
 * 面板只负责把后果讲清楚并要一次确认。三类动作分明：查看（次要）、结束批次
 * （次要、破坏性需确认）、切换为团队（主要、有在线会话时需确认）。
 */
export function RunModePanel({ team, busy, error, onViewSessions, onSwitchToTeam, onEndRun }: RunModePanelProps): React.JSX.Element {
  const [confirming, setConfirming] = useState<'switch' | 'end' | null>(null)
  const run = team.activeRun
  const ended = run?.status === 'completed'
  const seats = team.members.filter((member) => member.slot.solo === true).map(runModeSeatOf)
  const live = seats.filter((seat) => seat.state === 'waiting' || seat.state === 'working' || seat.state === 'unconfirmed')
  const counts = {
    waiting: seats.filter((seat) => seat.state === 'waiting').length,
    working: seats.filter((seat) => seat.state === 'working').length,
    unconfirmed: seats.filter((seat) => seat.state === 'unconfirmed').length,
    offline: seats.filter((seat) => seat.state === 'offline').length
  }
  const needsConfirm = !ended && live.length > 0

  const perform = async (action: 'switch' | 'end'): Promise<void> => {
    setConfirming(null)
    await (action === 'switch' ? onSwitchToTeam() : onEndRun())
  }
  const request = (action: 'switch' | 'end'): void => {
    if (needsConfirm) setConfirming(action)
    else void perform(action)
  }

  const consequence = ended
    ? '本批次已结束：旧会话下一次轮询会收到结束指令并自行退出。现在可以直接组建团队，或到「独立会话」新建批次。'
    : live.length
      ? `${live.length} 个会话仍在线或待确认。切换或结束后，它们会在下一次轮询（最长 60 秒）收到结束指令并退出；尚未取走的排队消息将归档，不会误送进新的运行。`
      : '所有独立会话已离线，可以直接切换。'

  return (
    <section className="run-mode-panel" aria-label="运行模式">
      <header className="run-mode-panel__head">
        <span className="run-mode-panel__brand"><BrandMark /></span>
        <div>
          <small>{ended ? '独立批次 · 已结束' : '当前模式 · 独立会话'}</small>
          <h1>{run?.name ?? '独立会话'}</h1>
          <p>
            {seats.length} 席 · 待命 {counts.waiting} · 执行中 {counts.working}
            {counts.unconfirmed ? ` · 待确认 ${counts.unconfirmed}` : ''} · 离线 {counts.offline}
          </p>
        </div>
      </header>

      <ul className="run-mode-panel__seats" aria-label="独立会话席位">
        {seats.map((seat) => (
          <li key={seat.channelId} className={`is-${seat.state}`}>
            <b>CH-{seat.channelId}</b>
            <span>{seat.name}</span>
            <em>{SEAT_STATE_LABEL[seat.state]}</em>
            <small>{seat.state === 'unconfirmed' ? '尚无工具调用证据' : formatRelativeTime(seat.lastSeenAt)}</small>
          </li>
        ))}
      </ul>

      <p className={`run-mode-panel__consequence${needsConfirm ? ' is-warning' : ''}`}>{consequence}</p>

      {confirming ? (
        <div className="run-mode-panel__confirm" role="alertdialog" aria-label="确认操作">
          <p>
            {confirming === 'switch'
              ? `确认切换为团队模式？${live.length} 个独立会话将被结束，切换后进入组队流程。`
              : `确认结束独立批次？${live.length} 个独立会话将被结束。`}
          </p>
          <div>
            <button className="is-secondary" disabled={busy} onClick={() => setConfirming(null)}>取消</button>
            <button className="is-danger" disabled={busy} onClick={() => void perform(confirming)}>
              {confirming === 'switch' ? '确认切换' : '确认结束'}
            </button>
          </div>
        </div>
      ) : (
        <div className="run-mode-panel__actions">
          <button className="is-secondary" disabled={busy} onClick={onViewSessions}>查看独立会话</button>
          <button className="is-secondary" disabled={busy || ended} onClick={() => request('end')}>结束独立批次</button>
          <button disabled={busy} onClick={() => request('switch')}>
            {busy ? '处理中…' : '切换为团队模式'}
          </button>
        </div>
      )}
      {error ? <em className="run-mode-panel__error">{error}</em> : null}
    </section>
  )
}
