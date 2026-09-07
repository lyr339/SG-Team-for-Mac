import { memo } from 'react'
import type { DragEvent } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import {
  contextTone,
  formatContextUsage,
  formatFullClock,
  formatRelativeClock,
  modelDisplayName
} from './format'
import { AgentAvatar } from './AgentAvatar'
import { modelProviderClass, modelProviderLabel } from './model-provider'
import {
  contextRingDash,
  sessionRailContextPercent,
  sessionRailGroupOf,
  sessionRailStateLabel,
  sessionRailTitle
} from './session-rail-view'

interface SessionRailCardProps {
  session: AgentSession
  selected: boolean
  onOpen: (channelId: string) => void
  /** 拖拽重排透传（侧栏启用；HTML5 DnD 事件直接落在行按钮上）。 */
  draggable?: boolean
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void
  onDragEnd?: (event: DragEvent<HTMLButtonElement>) => void
  /** 键盘漫游：只有当前选中行进入 Tab 序列，其余行由方向键到达。 */
  tabIndex?: number
  /** 侧栏用「N 分钟前」时的时间基准（每分钟刷新一次即可）。 */
  now?: number
}

/**
 * 名册里的一行：头像（含上下文光环）+ 角色名 / 通道号 / 状态 + 模型 / 指标。
 * 状态语义只落在一个 7px 的点上；上下文压力的精确值在指标行，光环是它的一眼版。
 */
function SessionRailCardView({
  session,
  selected,
  onOpen,
  draggable = false,
  onDragStart,
  onDragEnd,
  tabIndex,
  now
}: SessionRailCardProps): React.JSX.Element {
  const group = sessionRailGroupOf(session)
  const offline = group === 'offline'
  const { name, channel } = sessionRailTitle(session)
  const state = sessionRailStateLabel(session)
  const percent = sessionRailContextPercent(session)
  const ringDash = contextRingDash(percent)
  const sky = contextTone(percent)
  const runtimeKnown = Boolean(session.modelName || session.executionProfile)
  const runtimeName = modelDisplayName(session.executionProfile, session.modelName)
  const modelId = session.executionProfile?.modelId ?? session.modelName
  const telemetryDetail = session.telemetry?.detail || '尚未接入 Cursor 本机遥测'
  const tooltip = [
    session.composerTitle ? `${session.displayName} · ${session.composerTitle}` : session.displayName,
    telemetryDetail,
    draggable ? '拖动可调整同组内的顺序' : ''
  ].filter(Boolean).join('\n')
  const lastSeen = offline && session.lastSeenAt ? session.lastSeenAt : undefined

  return (
    <button
      type="button"
      className={`session-row is-${group}${selected ? ' is-selected' : ''}`}
      onClick={() => onOpen(session.channelId)}
      title={tooltip}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${name} ${channel}，${state}${percent === undefined ? '' : `，上下文 ${Math.round(percent)}%`}${session.queueDepth > 0 ? `，排队 ${session.queueDepth}` : ''}`}
      tabIndex={tabIndex}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <span className="session-row__avatar">
        <AgentAvatar
          avatarId={session.avatarId}
          name={session.displayName}
          crowned={session.isEffectiveLead ?? session.roleTemplateKey === 'lead'}
          size="sm"
        />
        <svg className={`session-row__ring${sky ? ` is-${sky}` : ''}`} viewBox="0 0 42 42" aria-hidden="true">
          <circle className="session-row__ring-track" cx="21" cy="21" r="19.25" />
          {ringDash ? (
            <circle className="session-row__ring-arc" cx="21" cy="21" r="19.25" pathLength="100" strokeDasharray={ringDash} />
          ) : null}
        </svg>
      </span>
      <span className="session-row__main">
        <span className="session-row__line">
          <strong className="session-row__name">{name}</strong>
          <small className="session-row__channel">{channel}</small>
          <em className="session-row__state"><i aria-hidden="true" /><span>{state}</span></em>
        </span>
        <span className="session-row__line session-row__line--meta">
          <span
            className={`session-row__model ${runtimeKnown ? modelProviderClass(modelId, runtimeName) : 'is-muted'}`}
            title={runtimeKnown ? `${runtimeName} · ${modelProviderLabel(modelId, runtimeName)}` : `${runtimeName}（Cursor 当前 Composer 运行配置）`}
          >
            <i aria-hidden="true" /><span>{runtimeName}</span>
          </span>
          <span className="session-row__metrics">
            <b
              className={`session-row__context${sky ? ` is-${sky}` : ''}${percent === undefined ? ' is-unknown' : ''}`}
              title={percent === undefined ? '上下文用量待读取' : `上下文 ${formatContextUsage(session.contextUsage)}`}
            >
              {percent === undefined ? '—' : `${Math.round(percent)}%`}
            </b>
            {session.changes ? (
              <span
                className="session-row__changes"
                title={`Cursor 当前 Composer 实时代码变更：新增 ${session.changes.additions} 行，删除 ${session.changes.deletions} 行`}
                aria-label={`实时变更，新增 ${session.changes.additions} 行，删除 ${session.changes.deletions} 行`}
              >
                <b>+{session.changes.additions}</b><em>−{session.changes.deletions}</em>
              </span>
            ) : null}
            {lastSeen ? (
              <time className="session-row__seen" dateTime={new Date(lastSeen).toISOString()} title={`最近活性 ${formatFullClock(lastSeen)}`}>
                {formatRelativeClock(lastSeen, now)}
              </time>
            ) : null}
            {session.queueDepth > 0 ? (
              <span className="session-row__queue" title="排队等待 Agent 处理的消息">排队 {session.queueDepth}</span>
            ) : null}
          </span>
        </span>
      </span>
    </button>
  )
}

/** memo 红利依赖 App 侧快照结构共享（session 引用不变即跳过重渲染）。 */
export const SessionRailCard = memo(SessionRailCardView)
