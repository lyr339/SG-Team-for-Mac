import { useEffect, useState } from 'react'
import type { TeamRunStatus } from '../../../domain/team-control'
import { PlayIcon } from '../UiIcons'
import { FlowStatusIcon } from './FlowStatusIcon'

export interface LobbyHeroStep {
  label: string
  state: 'done' | 'current' | 'todo'
}

interface LobbyHeroProps {
  workspaceName: string
  runName: string
  goal: string
  status: TeamRunStatus
  steps: readonly LobbyHeroStep[]
  goalLocked: boolean
  busy: boolean
  autoStartOnGoalSave: boolean
  primaryLabel: string
  primaryTitle?: string
  /** 下一步行动的一句人话指引（如「全部就绪，一键开跑」）。 */
  primaryHint: string
  runStateLabel?: string
  runStateKind?: 'launching' | 'active' | 'paused' | 'offline'
  runStateHint?: string
  allowCreateNextRun?: boolean
  onSaveGoal: (goal: string) => Promise<void>
  onReconfigure: () => void
  onPrimary: () => void
  onCreateNextRun: () => void
}

function compactRunLabel(runName: string, workspaceName: string): string {
  const cleanRunName = runName.trim()
  const cleanWorkspaceName = workspaceName.trim()
  if (!cleanRunName) return '主运行'
  if (!cleanWorkspaceName) return cleanRunName

  const prefixes = [
    `${cleanWorkspaceName} · `,
    `${cleanWorkspaceName} / `,
    `${cleanWorkspaceName} - `
  ]
  const matchedPrefix = prefixes.find((prefix) => cleanRunName.startsWith(prefix))
  return matchedPrefix ? cleanRunName.slice(matchedPrefix.length).trim() || '主运行' : cleanRunName
}

export function LobbyHero({
  workspaceName,
  runName,
  goal,
  status,
  steps,
  goalLocked,
  busy,
  autoStartOnGoalSave,
  primaryLabel,
  primaryTitle,
  primaryHint,
  runStateLabel,
  runStateKind,
  runStateHint,
  allowCreateNextRun = false,
  onSaveGoal,
  onReconfigure,
  onPrimary,
  onCreateNextRun
}: LobbyHeroProps): React.JSX.Element {
  const [draft, setDraft] = useState(goal)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const goalMissing = !goal.trim()

  useEffect(() => {
    setDraft(goal)
    setEditing(false)
  }, [goal, runName])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSaveGoal(draft)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  const action = status === 'completed' ? (
    <button className="lobby-command__primary" disabled={busy} onClick={onCreateNextRun}>
      <PlayIcon />开始新一轮
    </button>
  ) : runStateLabel ? (
    <>
      <span className={`lobby-command__state is-${runStateKind ?? 'active'}`}>
        <i />{runStateLabel}
      </span>
      {allowCreateNextRun ? (
        <button className="lobby-command__restart" disabled={busy} onClick={onCreateNextRun}>
          <PlayIcon />结束本轮并新建
        </button>
      ) : null}
    </>
  ) : goalMissing && !editing ? (
    <button className="lobby-command__primary" disabled={busy} onClick={() => setEditing(true)}>
      <PlayIcon />填写团队目标
    </button>
  ) : (
    <button className="lobby-command__primary" disabled={busy || goalMissing} title={primaryTitle} onClick={onPrimary}>
      <PlayIcon />{primaryLabel}
    </button>
  )

  const hint = status === 'completed'
    ? '本轮已验收完成，随时开启下一段协作'
    : runStateLabel
      ? runStateHint ?? (runStateKind === 'paused' ? '团队已暂停，可在会话侧继续推进' : '团队运转中，可在下方补齐资源或查看状态')
      : goalMissing
        ? '一句话说清要做什么，团队才能开跑'
        : primaryHint
  const runLabel = compactRunLabel(runName, workspaceName)

  return (
    <section className={`lobby-command ${editing ? 'is-editing' : ''}`} aria-label="大厅控制台">
      <div className="lobby-command__project">
        <span className="lobby-command__beacon"><i />当前工程</span>
        <strong title={workspaceName}>{workspaceName}</strong>
        <small title={runName}>{runLabel}</small>
      </div>

      <div className="lobby-command__goal">
        <span>目标</span>
        {editing ? (
          <div className="lobby-command__editor">
            <textarea
              autoFocus
              value={draft}
              maxLength={8_000}
              placeholder="写清目标、关键约束和最终验收结果…"
              aria-label="团队目标"
              onChange={(event) => setDraft(event.target.value)}
            />
            <footer>
              <button onClick={() => { setDraft(goal); setEditing(false) }}>取消</button>
              <button
                disabled={busy || saving || !draft.trim() || draft.trim() === goal}
                onClick={() => void save()}
              >{saving ? '保存中…' : autoStartOnGoalSave ? '保存并启动' : '保存并继续'}</button>
            </footer>
          </div>
        ) : (
          <strong className={goalMissing ? 'is-empty' : ''} title={goal}>{goal || '尚未设置团队目标'}</strong>
        )}
      </div>

      <ol className="lobby-command__steps" aria-label="团队流程进度">
        {steps.map((step, index) => (
          <li
            key={step.label}
            className={`is-${step.state}`}
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            <span><FlowStatusIcon state={step.state} index={index + 1} /></span>
            <b>{step.label}</b>
          </li>
        ))}
      </ol>

      <div className="lobby-command__action">
        <div className="lobby-command__action-row">
          {action}
          {!goalLocked ? (
            <span className="lobby-command__tools">
              {!editing ? <button className="lobby-command__ghost" onClick={() => setEditing(true)}>编辑目标</button> : null}
              <button className="lobby-command__ghost" disabled={busy} onClick={onReconfigure}>调整团队</button>
            </span>
          ) : null}
        </div>
        <small>{hint}</small>
      </div>
    </section>
  )
}
