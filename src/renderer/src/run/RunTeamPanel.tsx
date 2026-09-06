import { useEffect, useState } from 'react'
import { FlowStatusIcon } from '../lobby/FlowStatusIcon'
import { PlayIcon } from '../UiIcons'
import type { RunFlowStep, RunView, TeamPrimaryAction } from './run-view'

interface RunTeamPanelProps {
  view: RunView
  primary: TeamPrimaryAction
  steps: RunFlowStep[]
  busy: boolean
  /** 页面要求打开目标编辑器（主按钮「填写团队目标」）。 */
  editingGoal: boolean
  onEditingGoalChange: (editing: boolean) => void
  onSaveGoal: (goal: string) => Promise<void>
  onPrimary: () => void
  onReconfigure: () => void
  /** 执行中但全部离线：允许结束本轮并开新一轮。 */
  allowNewRound: boolean
  onNewRound: () => void
}

/**
 * 团队模式专属区：目标（可编辑）→ 四步流程 → 主按钮。
 * 主按钮由 preflight 决定唯一的下一步；破坏性的「结束本轮并新建」是次要样式。
 */
export function RunTeamPanel({
  view,
  primary,
  steps,
  busy,
  editingGoal,
  onEditingGoalChange,
  onSaveGoal,
  onPrimary,
  onReconfigure,
  allowNewRound,
  onNewRound
}: RunTeamPanelProps): React.JSX.Element {
  const run = view.run
  const goal = run?.goal ?? ''
  const [draft, setDraft] = useState(goal)
  const [saving, setSaving] = useState(false)
  const goalLocked = view.phase !== 'prelaunch'
  const goalMissing = !goal.trim()

  useEffect(() => {
    setDraft(goal)
  }, [goal, run?.id])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSaveGoal(draft)
      onEditingGoalChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="run-panel run-panel--team" aria-label="团队运行">
      <header className="run-section-head">
        <strong>目标</strong>
        {!goalLocked && !editingGoal ? (
          <button type="button" className="run-link" disabled={busy} onClick={() => onEditingGoalChange(true)}>
            {goalMissing ? '填写' : '编辑'}
          </button>
        ) : null}
      </header>

      {editingGoal ? (
        <div className="run-goal-editor">
          <textarea
            autoFocus
            value={draft}
            maxLength={8_000}
            placeholder="写清目标、关键约束和最终验收结果…"
            aria-label="团队目标"
            onChange={(event) => setDraft(event.target.value)}
          />
          <footer>
            <button type="button" className="secondary-button" disabled={saving} onClick={() => { setDraft(goal); onEditingGoalChange(false) }}>取消</button>
            <button
              type="button"
              className="primary-button"
              disabled={busy || saving || !draft.trim() || draft.trim() === goal}
              onClick={() => void save()}
            >{saving ? '保存中…' : '保存目标'}</button>
          </footer>
        </div>
      ) : (
        <p className={`run-goal${goalMissing ? ' is-empty' : ''}`} title={goal}>{goal || '尚未设置团队目标'}</p>
      )}

      <ol className="run-steps" aria-label="团队流程进度">
        {steps.map((step, index) => (
          <li key={step.label} className={`is-${step.state}`} aria-current={step.state === 'current' ? 'step' : undefined}>
            <FlowStatusIcon state={step.state} index={index + 1} />
            <span>{step.label}</span>
          </li>
        ))}
      </ol>

      {view.gates.length ? (
        <ul className="run-gates" aria-label="待处理事项">
          {view.gates.map((gate) => (
            <li key={gate.label} title={gate.detail}><i aria-hidden="true" /><span>{gate.label}</span><small>{gate.detail}</small></li>
          ))}
        </ul>
      ) : null}

      <footer className="run-panel__actions">
        {primary.kind !== 'none' ? (
          <button
            type="button"
            className="primary-button run-primary"
            disabled={busy || (primary.kind === 'launch' && goalMissing)}
            onClick={onPrimary}
          ><PlayIcon />{primary.label}</button>
        ) : allowNewRound ? (
          <button type="button" className="secondary-button" disabled={busy} onClick={onNewRound}>结束本轮并新建</button>
        ) : null}
        {!goalLocked ? (
          <button type="button" className="run-link" disabled={busy} onClick={onReconfigure}>调整团队</button>
        ) : null}
        {primary.hint ? <small className="run-panel__hint">{primary.hint}</small> : null}
      </footer>
    </section>
  )
}
