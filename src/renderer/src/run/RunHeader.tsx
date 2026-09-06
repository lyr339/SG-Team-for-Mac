import type { WorkspaceRunMode } from '../../../domain/team-control'
import { SessionsIcon, StopIcon } from '../UiIcons'
import { RunModeSwitch, RUN_MODE_LABEL } from './RunModeSwitch'
import type { RunView } from './run-view'

interface RunHeaderProps {
  view: RunView
  busy: boolean
  /** 正在执行的动作名（页面级），用于在对应按钮上显示进行中文案。 */
  busyAction?: string
  /** 正在为另一种模式做配置（尚未创建）：分段控件预选它并提示后果。 */
  composingMode?: WorkspaceRunMode
  onSwitchMode: (to: WorkspaceRunMode) => void
  onCancelCompose?: () => void
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
 * 运行头部：工程 → 模式 → 状态 → 动作。不管哪种模式，这一条都在同一位置，
 * 用同一套词汇；模式切换只有这一个入口。
 */
export function RunHeader({ view, busy, busyAction, composingMode, onSwitchMode, onCancelCompose, onEnd, onOpenSessions }: RunHeaderProps): React.JSX.Element {
  const run = view.run
  const mode = view.mode ?? 'team'
  const ended = view.phase === 'completed'
  const ending = busyAction === 'end-run'
  const workspaceName = view.workspace?.name ?? '未绑定工程'
  const runName = run ? compactRunName(run.name, workspaceName) : ''

  return (
    <header className="run-header" aria-label="运行控制">
      <div className="run-header__identity">
        <span className="run-header__eyebrow">{mode === 'independent' ? '独立批次' : '团队运行'}</span>
        <h1 title={view.workspace?.path}>{workspaceName}</h1>
        {runName && runName !== workspaceName ? <small title={run?.name}>{runName}</small> : null}
      </div>

      <div className="run-header__mode">
        <RunModeSwitch
          compact
          value={composingMode ?? mode}
          disabled={busy}
          onChange={onSwitchMode}
        />
        {composingMode ? (
          <span className="run-header__composing" role="status">
            正在配置{RUN_MODE_LABEL[composingMode]}模式
            {!ended ? `，创建后当前${mode === 'independent' ? '独立批次' : '团队运行'}结束` : ''}
            {onCancelCompose ? <button type="button" disabled={busy} onClick={onCancelCompose}>放弃</button> : null}
          </span>
        ) : null}
      </div>

      <div className="run-header__status">
        <span className={`run-state-chip is-${view.state.tone}`} title={view.state.hint}>
          <i aria-hidden="true" />{view.state.label}
        </span>
        {view.state.hint ? <small>{view.state.hint}</small> : null}
      </div>

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
    </header>
  )
}
