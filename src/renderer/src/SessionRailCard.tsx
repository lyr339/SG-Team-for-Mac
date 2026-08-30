import { memo } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import {
  contextPercent,
  contextTone,
  formatContextUsage,
  modelDisplayName,
  statusLabel
} from './format'
import { AgentAvatar } from './AgentAvatar'
import { modelProviderClass, modelProviderLabel } from './model-provider'

interface SessionRailCardProps {
  session: AgentSession
  selected: boolean
  onOpen: (channelId: string) => void
}

/** 状态徽章色调：待命→绿；启动/执行→蓝（呼吸点）；空闲/阻塞/待验收/恢复→琥珀；离线/停止→灰。 */
function stateTone(session: AgentSession): 'waiting' | 'active' | 'attention' | 'offline' {
  if (!session.online) return 'offline'
  if (session.status === 'waiting') return 'waiting'
  if (session.status === 'running' || session.status === 'starting') return 'active'
  if (session.status === 'offline' || session.status === 'stopped') return 'offline'
  return 'attention'
}

function SessionRailCardView({
  session,
  selected,
  onOpen
}: SessionRailCardProps): React.JSX.Element {
  const telemetryDetail = session.telemetry?.detail || '尚未接入 Cursor 本机遥测'
  const runtimeKnown = Boolean(session.modelName || session.executionProfile)
  const runtimeName = modelDisplayName(session.executionProfile, session.modelName)
  const state = session.online
    ? statusLabel(session.status)
    : '已离线'
  const tone = stateTone(session)
  const percent = contextPercent(session.contextUsage)
  const displayedPercent = percent === undefined ? undefined : Math.round(percent * 10) / 10
  const sky = contextTone(percent)

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
              crowned={session.isEffectiveLead ?? session.roleTemplateKey === 'lead'}
              online={session.online}
              size="sm"
            />
            <span className="rail-session-card__identity">
              <strong>{session.displayName}</strong>
            </span>
          </span>
          <em className={`rail-session-card__state is-${tone}`}><i aria-hidden="true" /><span>{state}</span></em>
        </span>

        <span className="rail-session-card__metrics">
          <span
            className={`rail-metric rail-metric--context ${sky ? `is-${sky}` : ''} ${percent === undefined ? 'is-unknown' : ''}`}
            title={percent === undefined ? '上下文用量待读取' : `上下文 ${formatContextUsage(session.contextUsage)}`}
          >
            <i className="rail-metric__track"><b style={{ width: `${displayedPercent ?? 0}%` }} /></i>
            {displayedPercent === undefined ? '—' : `${Math.round(displayedPercent)}%`}
          </span>
          {session.changes ? (
            <span
              className="rail-metric rail-metric--changes"
              title={`Cursor 当前 Composer 实时代码变更：新增 ${session.changes.additions} 行，删除 ${session.changes.deletions} 行`}
              aria-label={`实时变更，新增 ${session.changes.additions} 行，删除 ${session.changes.deletions} 行`}
            >
              <b>+{session.changes.additions}</b><em>-{session.changes.deletions}</em>
            </span>
          ) : null}
          {session.queueDepth > 0 ? (
            <span className="rail-metric rail-metric--queue" title="排队等待 Agent 处理的消息">排队 {session.queueDepth}</span>
          ) : null}
        </span>

        <span
          className={`rail-session-card__model ${runtimeKnown ? modelProviderClass(session.executionProfile?.modelId ?? session.modelName, runtimeName) : 'is-muted'}`}
          title={session.modelName ? `${runtimeName} · ${modelProviderLabel(session.executionProfile?.modelId ?? session.modelName, runtimeName)}` : `${runtimeName}（Cursor 当前 Composer 运行配置）`}
        >
          <b>{runtimeName}</b>
        </span>
      </span>
    </button>
  )
}

/** memo 红利依赖 App 侧快照结构共享（session 引用不变即跳过重渲染）。 */
export const SessionRailCard = memo(SessionRailCardView)
