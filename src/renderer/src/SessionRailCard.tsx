import { memo } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import {
  badgeTone,
  contextPercent,
  contextTone,
  executionBadges,
  formatContextUsage,
  formatRelativeTimeCompact,
  modelDisplayName,
  statusLabel
} from './format'
import { AgentAvatar } from './AgentAvatar'

interface SessionRailCardProps {
  session: AgentSession
  selected: boolean
  onOpen: (channelId: string) => void
}

/** 状态徽章色调：待命→绿；启动/执行→蓝（呼吸点）；空闲/阻塞/待验收/恢复→琥珀；离线/停止→灰。 */
function stateTone(session: AgentSession): 'waiting' | 'active' | 'attention' | 'offline' {
  if (!session.online) return session.deliveryMode === 'queued' ? 'attention' : 'offline'
  if (session.status === 'waiting') return 'waiting'
  if (session.status === 'running' || session.status === 'starting') return 'active'
  if (session.status === 'offline' || session.status === 'stopped') return 'offline'
  return 'attention'
}

/** 消息摘要：优先取 Cursor 工作过程最新条目，其次当前任务，再次会话标题。 */
function sessionDigest(session: AgentSession): { text: string; live: boolean } | undefined {
  const entries = session.workEntries
  if (entries?.length) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!
      const text = entry.text.replace(/\s+/g, ' ').trim()
      if (text) return { text, live: entry.kind === 'tool' && entry.status === 'running' }
    }
  }
  const task = session.currentTask.trim()
  if (task) return { text: task, live: false }
  const title = session.composerTitle?.trim()
  if (title) return { text: title, live: false }
  return undefined
}

function SessionRailCardView({
  session,
  selected,
  onOpen
}: SessionRailCardProps): React.JSX.Element {
  const telemetryDetail = session.telemetry?.detail || '尚未接入 Cursor 本机遥测'
  const runtimeKnown = Boolean(session.modelName || session.executionProfile)
  const runtimeName = modelDisplayName(session.executionProfile, session.modelName)
  const badges = executionBadges(session.executionProfile, session.modelName)
  const state = session.online
    ? statusLabel(session.status)
    : session.deliveryMode === 'queued' ? '待轮询' : '已离线'
  const tone = stateTone(session)
  const digest = sessionDigest(session)
  const percent = contextPercent(session.contextUsage)
  const sky = contextTone(percent)
  const activityLabel = formatRelativeTimeCompact(session.lastSeenAt ?? session.lastAgentActivityAt)
  const hasMetrics = percent !== undefined || Boolean(session.changes) || session.queueDepth > 0 || Boolean(activityLabel)

  return (
    <button
      className={`rail-session-card rail-session-card--${session.status} ${selected ? 'is-active' : ''}`}
      onClick={() => onOpen(session.channelId)}
      title={session.composerTitle ? `${telemetryDetail} · ${session.composerTitle}` : telemetryDetail}
    >
      <span className="rail-session-card__body">
        <span className="rail-session-card__topline">
          <span>
            <AgentAvatar
              avatarId={session.avatarId}
              name={session.displayName}
              crowned={session.roleTemplateKey === 'lead'}
              online={session.online}
              size="sm"
            />
            <span className="rail-session-card__identity">
              <strong>{session.displayName}</strong>
              <small>{session.roleName} · CH-{session.channelId}</small>
            </span>
          </span>
          <em className={`rail-session-card__state is-${tone}`}><i aria-hidden="true" />{state}</em>
        </span>

        {digest ? (
          <span className={`rail-session-card__digest ${digest.live ? 'is-live' : ''}`} title={digest.text}>
            <span>{digest.text}</span>
          </span>
        ) : null}

        {hasMetrics ? (
          <span className="rail-session-card__metrics">
            {percent !== undefined ? (
              <span
                className={`rail-metric rail-metric--context ${sky ? `is-${sky}` : ''}`}
                title={`上下文 ${formatContextUsage(session.contextUsage)}`}
              >
                <i className="rail-metric__track"><b style={{ width: `${percent}%` }} /></i>
                {Math.round(percent)}%
              </span>
            ) : null}
            {session.changes ? (
              <span
                className="rail-metric rail-metric--changes"
                title={session.changes.files === undefined ? '代码改动 · 文件待统计' : `代码改动 · ${session.changes.files} 文件`}
              >
                <b>+{session.changes.additions}</b>
                <b>−{session.changes.deletions}</b>
              </span>
            ) : null}
            {session.queueDepth > 0 ? (
              <span className="rail-metric rail-metric--queue" title="排队等待 Agent 处理的消息">排队 {session.queueDepth}</span>
            ) : null}
            {activityLabel ? <span className="rail-metric rail-metric--time">{activityLabel}</span> : null}
          </span>
        ) : null}

        <span
          className={`model-badges is-compact ${runtimeKnown ? '' : 'is-muted'}`}
          title={session.modelName ? runtimeName : `${runtimeName}（Cursor 当前 Composer 运行配置）`}
        >
          <b>{runtimeName}</b>
          {badges.map((badge) => <i key={badge} className={`is-${badgeTone(badge)}`}>{badge}</i>)}
        </span>
      </span>
    </button>
  )
}

/** memo 红利依赖 App 侧快照结构共享（session 引用不变即跳过重渲染）。 */
export const SessionRailCard = memo(SessionRailCardView)
