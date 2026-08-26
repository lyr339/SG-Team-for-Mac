import { useEffect, useMemo, useState } from 'react'
import type { TeamControlSnapshot, TeamRuntimeChannelView } from '../../../domain/team-control'
import type { TeamFailoverRecord, TeamFailoverStatus } from '../../../domain/team-failover'
import { formatDateTime } from '../format'
import { ChevronDownIcon, ShieldIcon } from '../UiIcons'

interface TeamResiliencePanelProps {
  team: TeamControlSnapshot
}

const FAILOVER_STATUS: Record<TeamFailoverStatus, string> = {
  waiting_for_agent: '等待确认',
  completed: '已完成',
  failed: '失败'
}

function standbyState(channel: TeamRuntimeChannelView): string {
  if (!channel.online) return '离线'
  if (channel.waiting && channel.queueDepth === 0) return '可立即接替'
  if (channel.waiting) return `队列 ${channel.queueDepth}`
  return '忙碌'
}

function failoverRoute(record: TeamFailoverRecord): string {
  return record.toChannelId
    ? `CH-${record.fromChannelId} → CH-${record.toChannelId}`
    : `CH-${record.fromChannelId}`
}

export function TeamResiliencePanel({ team }: TeamResiliencePanelProps): React.JSX.Element {
  const records = useMemo(
    () => [...team.failovers].sort((left, right) => right.detectedAt - left.detectedAt),
    [team.failovers]
  )
  const attentionRecords = records.filter((record) => record.status !== 'completed')
  const attentionKey = attentionRecords.map((record) => `${record.id}:${record.status}`).join('|')
  const [expanded, setExpanded] = useState(Boolean(attentionKey))
  useEffect(() => {
    if (attentionKey) setExpanded(true)
  }, [attentionKey])

  const runEnded = team.activeRun?.status === 'completed'
  const onlineMembers = team.members.filter((member) => member.runtime?.online).length
  const readyStandby = team.standbyChannels.filter((channel) => (
    channel.online && channel.waiting && channel.queueDepth === 0
  ))
  const completedCount = records.filter((record) => record.status === 'completed').length
  const state = runEnded
    ? '本轮已结束'
    : attentionRecords.length
      ? `${attentionRecords.length} 项需要处理`
      : readyStandby.length
        ? '自动守护中'
        : '暂无可用备用'

  return (
    <section className={`v2-resilience ${expanded ? 'is-expanded' : ''} ${attentionRecords.length ? 'has-attention' : ''}`}>
      <button
        className="v2-resilience__summary"
        aria-expanded={expanded}
        aria-controls="team-resilience-details"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="v2-resilience__icon"><ShieldIcon /></span>
        <span className="v2-resilience__title"><strong>运行保障</strong><small>{state}</small></span>
        <span className="v2-resilience__metrics">
          <span><b>{onlineMembers}/{team.members.length}</b> 在岗</span>
          <span><b>{readyStandby.length}</b> 备用</span>
          <span><b>{completedCount}</b> 接替</span>
        </span>
        <ChevronDownIcon className="v2-resilience__chevron" />
      </button>

      {expanded ? (
        <div className="v2-resilience__details" id="team-resilience-details">
          <section className="v2-resilience__standby">
            <header><strong>备用 Agent</strong><span>{team.standbyChannels.length}</span></header>
            <div>
              {team.standbyChannels.map((channel) => (
                <article className={channel.online ? '' : 'is-offline'} key={channel.channelId}>
                  <i>CH{channel.channelId}</i>
                  <span><strong>{channel.displayName}</strong><small>未分配职责</small></span>
                  <em>{standbyState(channel)}</em>
                </article>
              ))}
              {!team.standbyChannels.length ? (
                <p>暂无备用 Agent；角色掉线后会保留离线状态，等待用户处理。</p>
              ) : null}
            </div>
          </section>

          <section className="v2-resilience__history">
            <header><strong>最近接替</strong><span>{records.length}</span></header>
            <div>
              {records.slice(0, 5).map((record) => (
                <article className={`is-${record.status}`} key={record.id}>
                  <i>{record.status === 'completed' ? '✓' : record.status === 'failed' ? '!' : '↻'}</i>
                  <span>
                    <strong>{record.roleName}<b>{failoverRoute(record)}</b></strong>
                    <small>{record.reason} · {formatDateTime(record.detectedAt)}</small>
                  </span>
                  <em>{FAILOVER_STATUS[record.status]}</em>
                </article>
              ))}
              {!records.length ? <p>本轮尚未发生接替。</p> : null}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}
