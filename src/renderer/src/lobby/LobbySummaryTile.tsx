import type { TeamControlSnapshot } from '../../../domain/team-control'
import type { TeamCollaborationSnapshot } from '../../../domain/team-collaboration'
import type { TeamDashboardGate } from '../team/team-dashboard-view'
import { summarizeTeamCollaborationForRun } from '../team/team-collaboration-view'

interface LobbySummaryTileProps {
  team: TeamControlSnapshot
  collaboration: TeamCollaborationSnapshot
  /** 启动前/运行中未通过的检查项；空数组表示全部就绪。 */
  gates: TeamDashboardGate[]
}

const RUN_STATUS: Record<string, string> = {
  draft: '待配置',
  ready: '可启动',
  launching: '启动中',
  running: '运行中',
  attention: '需处理',
  paused: '已暂停',
  completed: '已完成'
}

export function LobbySummaryTile({ team, collaboration, gates }: LobbySummaryTileProps): React.JSX.Element {
  const activeRun = team.activeRun
  const workspace = team.workspaces.find((candidate) => candidate.id === team.activeWorkspaceId)
  const onlineMembers = team.members.filter((member) => member.runtime?.online).length
  const waitingMembers = team.members.filter((member) => member.runtime?.online && member.runtime.waiting).length
  const queuedMessages = team.members.reduce((total, member) => total + (member.runtime?.queueDepth ?? 0), 0)
  const collaborationSummary = summarizeTeamCollaborationForRun(collaboration, activeRun)
  const memberCount = team.members.length
  const waitingRatio = memberCount > 0 ? Math.round((waitingMembers / memberCount) * 100) : 0
  const metrics = [
    { label: '在线', value: `${onlineMembers}/${memberCount}` },
    { label: '待命', value: `${waitingMembers}/${memberCount}` },
    { label: '队列', value: queuedMessages, warning: queuedMessages > 0 },
    { label: '未读', value: collaborationSummary.operatorUnread, warning: collaborationSummary.operatorUnread > 0 },
    { label: '待回', value: collaborationSummary.pendingAgentReplies, warning: collaborationSummary.pendingAgentReplies > 0 },
    { label: '线程', value: collaborationSummary.threadCount }
  ]

  return (
    <section className={`lobby-tile lobby-summary ${gates.length ? 'has-gates' : ''}`}>
      <header className="lobby-tile__head lobby-summary__head">
        <strong>运行脉冲</strong>
        <span title={workspace?.path}>{workspace?.name ?? '未绑定'}</span>
        <span className={`team-context-state team-context-state--${activeRun?.status ?? 'draft'}`}>
          <i />{activeRun ? RUN_STATUS[activeRun.status] : '未创建'}
        </span>
      </header>
      <div className="lobby-summary__pulse">
        <span><b>{waitingMembers}/{memberCount}</b><small>待命席位</small></span>
        <i aria-hidden="true"><em style={{ width: `${waitingRatio}%` }} /></i>
      </div>
      <dl className="lobby-summary__grid">
        {metrics.map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd className={metric.warning ? 'is-warning' : ''}>{metric.value}</dd>
          </div>
        ))}
      </dl>
      {gates.length ? (
        <ul className="lobby-summary__gates" aria-label="待处理事项">
          {gates.map((gate) => (
            <li key={gate.label} title={gate.detail}><i /><span>{gate.label}</span></li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
