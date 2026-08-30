import { useState } from 'react'
import type { TeamHandoffOptions } from '../../../domain/team-handoff'
import { AgentAvatar } from '../AgentAvatar'

interface ManualHandoffDialogProps {
  options: TeamHandoffOptions
  busy: boolean
  error: string
  onClose: () => void
  onConfirm: (agentSessionId: string) => Promise<void>
}

export function ManualHandoffDialog({ options, busy, error, onClose, onConfirm }: ManualHandoffDialogProps): React.JSX.Element {
  const eligible = options.candidates.filter((candidate) => candidate.eligible)
  const [selected, setSelected] = useState(eligible[0]?.agentSessionId ?? '')
  return (
    <div className="handoff-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <section className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <header>
          <div><strong id="handoff-title">交接 {options.sourceRoleName}</strong><span>CH-{options.sourceChannelId} 已离线</span></div>
          <button disabled={busy} aria-label="关闭交接窗口" onClick={onClose}>×</button>
        </header>
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
              <em>{candidate.kind === 'standby'
                ? '备用'
                : candidate.mode === 'lead_authority' && candidate.eligible
                  ? '接管主控'
                  : candidate.eligible ? '可交接' : '不可用'}</em>
            </label>
          ))}
          {!options.candidates.length ? <p>当前没有仍在线的候选 Agent。</p> : null}
        </div>
        {error ? <p className="handoff-dialog-error">{error}</p> : null}
        <footer><button disabled={busy} onClick={onClose}>取消</button><button disabled={busy || !selected} onClick={() => void onConfirm(selected)}>{busy ? '交接中…' : '确认交接'}</button></footer>
      </section>
    </div>
  )
}
