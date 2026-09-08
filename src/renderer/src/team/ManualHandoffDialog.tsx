import { useState } from 'react'
import type { ManualTeamHandoffOutcome, TeamHandoffCandidate, TeamHandoffOptions } from '../../../domain/team-handoff'
import { AgentAvatar } from '../AgentAvatar'

interface ManualHandoffDialogProps {
  options: TeamHandoffOptions
  busy: boolean
  error: string
  onClose: () => void
  /** 执行迁移；成功返回结果（弹窗据此显示结果页），失败由调用方写入 error 并返回 undefined。 */
  onConfirm: (input: { agentSessionId: string; includeContext: boolean }) => Promise<ManualTeamHandoffOutcome | undefined>
  onOpenSession?: (channelId: string) => void
}

function candidateTag(candidate: TeamHandoffCandidate): string {
  if (candidate.kind === 'standby') return '备用'
  if (candidate.mode === 'lead_authority' && candidate.eligible) return '接管主控'
  return candidate.eligible ? '可交接' : '不可用'
}

/**
 * 离线团队席位的职责迁移弹窗（AgentSlot 换绑 / 主控权限转移）。
 * 「同时交接上下文文档」把原席位的 Cursor 转录与拾光会话记录路径作为一条普通用户消息
 * 排进接手者队列——上下文由主进程在迁移前解析、迁移成功后投递，两者结果分别显示。
 */
export function ManualHandoffDialog({ options, busy, error, onClose, onConfirm, onOpenSession }: ManualHandoffDialogProps): React.JSX.Element {
  const eligible = options.candidates.filter((candidate) => candidate.eligible)
  const [selected, setSelected] = useState(eligible[0]?.agentSessionId ?? '')
  const [includeContext, setIncludeContext] = useState(true)
  const [outcome, setOutcome] = useState<{ candidate: TeamHandoffCandidate; result: ManualTeamHandoffOutcome }>()

  const confirm = async (): Promise<void> => {
    const candidate = options.candidates.find((item) => item.agentSessionId === selected)
    if (!candidate) return
    const result = await onConfirm({ agentSessionId: candidate.agentSessionId, includeContext })
    if (result) setOutcome({ candidate, result })
  }

  return (
    <div className="handoff-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <section className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <header>
          <div><strong id="handoff-title">交接 {options.sourceRoleName}</strong><span>CH-{options.sourceChannelId} 已离线</span></div>
          <button disabled={busy} aria-label="关闭交接窗口" onClick={onClose}>×</button>
        </header>
        {outcome ? (
          <div className="handoff-done" role="status">
            <i aria-hidden="true">✓</i>
            <strong>
              {outcome.result.handoff.mode === 'lead_authority'
                ? `主控权限已转移给 ${outcome.candidate.roleName} · CH-${outcome.candidate.channelId}`
                : `${options.sourceRoleName} 已交给 ${outcome.candidate.roleName} · CH-${outcome.candidate.channelId}`}
            </strong>
            <p>{outcome.candidate.impact}</p>
            {outcome.result.contextHandoff ? (
              outcome.result.contextHandoff.ok ? (
                <>
                  <p>上下文文档已排进 CH-{outcome.result.contextHandoff.result.targetChannelId} 的队列，接手者下一次轮询即会阅读。</p>
                  <dl>
                    <div><dt>上下文文档</dt><dd><code>{outcome.result.contextHandoff.result.transcriptPath}</code></dd></div>
                    {outcome.result.contextHandoff.result.recordPath
                      ? <div><dt>拾光会话记录</dt><dd><code>{outcome.result.contextHandoff.result.recordPath}</code></dd></div>
                      : null}
                  </dl>
                </>
              ) : (
                <p className="is-warning">上下文文档未投递：{outcome.result.contextHandoff.error}。职责迁移不受影响。</p>
              )
            ) : null}
            <footer>
              {onOpenSession ? (
                <button onClick={() => { onOpenSession(outcome.candidate.channelId); onClose() }}>打开 CH-{outcome.candidate.channelId}</button>
              ) : null}
              <button onClick={onClose}>完成</button>
            </footer>
          </div>
        ) : (
          <>
            <div className="handoff-candidates">
              {options.candidates.map((candidate) => (
                <label className={candidate.eligible ? '' : 'is-disabled'} key={candidate.agentSessionId}>
                  <input type="radio" name="handoff-candidate" value={candidate.agentSessionId}
                    checked={selected === candidate.agentSessionId} disabled={!candidate.eligible || busy}
                    onChange={() => setSelected(candidate.agentSessionId)} />
                  {candidate.avatarId
                    ? <AgentAvatar avatarId={candidate.avatarId} name={candidate.roleName} online size="sm" />
                    : <i className="handoff-candidate-channel">CH{candidate.channelId}</i>}
                  <span><strong>{candidate.roleName} · CH-{candidate.channelId}</strong><small>{candidate.blocker || candidate.impact}</small></span>
                  <em>{candidateTag(candidate)}</em>
                </label>
              ))}
              {!options.candidates.length ? <p>当前没有仍在线的候选 Agent。</p> : null}
            </div>
            <label className="handoff-context-option">
              <input type="checkbox" checked={includeContext} disabled={busy} onChange={(event) => setIncludeContext(event.target.checked)} />
              <span>
                <strong>同时交接上下文文档</strong>
                <small>把 CH-{options.sourceChannelId} 的 Cursor 会话转录与拾光会话记录路径作为一条消息排进接手者队列，接手者读完后接续原席位的工作。</small>
              </span>
            </label>
            {error ? <p className="handoff-dialog-error">{error}</p> : null}
            <footer>
              <button disabled={busy} onClick={onClose}>取消</button>
              <button disabled={busy || !selected} onClick={() => void confirm()}>{busy ? '交接中…' : '确认交接'}</button>
            </footer>
          </>
        )}
      </section>
    </div>
  )
}
