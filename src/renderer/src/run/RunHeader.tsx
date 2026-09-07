import type { WorkspaceRunMode } from '../../../domain/team-control'
import { SessionsIcon, StopIcon } from '../UiIcons'
import { RunModeSwitch } from './RunModeSwitch'
import type { RunView } from './run-view'

interface RunHeaderProps {
  view: RunView
  busy: boolean
  /** 正在执行的动作名（页面级），用于在对应按钮上显示进行中文案。 */
  busyAction?: string
  /** 正在为另一种模式做配置（尚未创建）：分段控件显示目标模式；说明与「放弃」在头部下方的横幅里。 */
  composingMode?: WorkspaceRunMode
  onSwitchMode: (to: WorkspaceRunMode) => void
  onEnd: () => void
  onOpenSessions: () => void
}

function compactRunName(runName: string, workspaceName: string): string {
  const clean = runName.trim()
  for (const separator of [' · ', ' / ', ' - ']) {
    const prefix = `${workspaceName.trim()}${separator}`
    if (clean.startsWith(prefix)) return clean.slice(prefix.length).trim() || clean
  }
  return clean
}

/**
 * 运行头部：左侧是"这是什么、跑得怎样"（模式 · 状态 / 工程名 / 运行名 · 提示），
 * 右侧是宽度恒定的控件（模式切换、打开会话、结束）。左侧吸收一切文字长度变化，
 * 右侧控件的位置与头部高度在任何状态下都不动。
 */
export function RunHeader({ view, busy, busyAction, composingMode, onSwitchMode, onEnd, onOpenSessions }: RunHeaderProps): React.JSX.Element {
  const run = view.run
  const mode = view.mode ?? 'team'
  const ended = view.phase === 'completed'
  const ending = busyAction === 'end-run'
  const workspaceName = view.workspace?.name ?? '未绑定工程'
  const runName = run ? compactRunName(run.name, workspaceName) : ''
  const subline = [runName && runName !== workspaceName ? runName : '', view.state.hint ?? ''].filter(Boolean).join(' · ')

  return (
    <header className="run-header" aria-label="运行控制">
      <div className="run-header__identity">
        <div className="run-header__line">
          <span className="run-header__eyebrow">{mode === 'independent' ? '独立批次' : '团队运行'}</span>
          <span className={`run-state-chip is-${view.state.tone}`} title={view.state.hint}>
            <i aria-hidden="true" />{view.state.label}
          </span>
        </div>
        <h1 title={view.workspace?.path}>{workspaceName}</h1>
        <small title={subline}>{subline || '\u00a0'}</small>
      </div>

      <div className="run-header__controls">
        <RunModeSwitch
          compact
          value={composingMode ?? mode}
          disabled={busy}
          onChange={onSwitchMode}
        />
        <div className="run-header__actions">
          <button type="button" className="run-header__ghost" disabled={busy} onClick={onOpenSessions}>
            <SessionsIcon />打开会话
          </button>
          <button
            type="button"
            className="run-header__ghost is-danger"
            disabled={busy || ended || !run}
            aria-busy={ending}
            onClick={onEnd}
          >
            <StopIcon />{ending ? '结束中…' : mode === 'independent' ? '结束批次' : '结束运行'}
          </button>
        </div>
      </div>
    </header>
  )
}
