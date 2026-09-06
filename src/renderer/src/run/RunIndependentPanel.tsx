import { formatFullClock, formatRelativeClock } from '../format'
import type { RunView } from './run-view'

export const INDEPENDENT_MIN_SESSIONS = 1
export const INDEPENDENT_MAX_SESSIONS = 16

interface RunIndependentPanelProps {
  view: RunView
  /** 正在配置新批次（无运行 / 新建批次 / 从团队切换过来）。 */
  composing: boolean
  /** 新批次的目标工程。 */
  targetWorkspace?: { name: string; path: string }
  count: number
  busy: boolean
  onCountChange: (count: number) => void
  onChooseWorkspace: () => void
  onNewBatch: () => void
}

/**
 * 独立模式专属区。配置中：目标工程 + 会话数量；运行中：批次概况 + 新建批次。
 * 创建按钮在席位区底部（与团队模式的「一键创建会话」同一位置）。
 */
export function RunIndependentPanel({
  view,
  composing,
  targetWorkspace,
  count,
  busy,
  onCountChange,
  onChooseWorkspace,
  onNewBatch
}: RunIndependentPanelProps): React.JSX.Element {
  const waiting = view.seats.filter((seat) => seat.state === 'waiting').length
  const working = view.seats.filter((seat) => seat.state === 'working').length
  const ended = view.phase === 'completed'

  if (composing) {
    return (
      <section className="run-panel run-panel--independent" aria-label="独立批次配置">
        <header className="run-section-head">
          <strong>新批次</strong>
          <span>每个会话只处理自己的用户消息，不加入团队任务板</span>
        </header>

        <div className="run-field">
          <span className="run-field__label">目标工程</span>
          <div className="run-field__value">
            <strong>{targetWorkspace?.name ?? '等待识别 Cursor 工程'}</strong>
            <code title={targetWorkspace?.path}>{targetWorkspace?.path ?? '请先在 Cursor 中打开一个工程'}</code>
          </div>
          <button type="button" className="run-link" disabled={busy} onClick={onChooseWorkspace}>选择工程</button>
        </div>

        {view.cursorWorkspaceChanged && view.run && !ended ? (
          <p className="run-callout is-warning">
            Cursor 已切换工程：新批次将创建到「{targetWorkspace?.name}」，当前批次所在的「{view.workspace?.name}」会结束。
          </p>
        ) : null}

        <div className="run-field">
          <span className="run-field__label">会话数量</span>
          <div className="run-field__value"><small>一次创建 {INDEPENDENT_MIN_SESSIONS}–{INDEPENDENT_MAX_SESSIONS} 个，创建后分别对话</small></div>
          <div className="run-stepper" role="group" aria-label="会话数量">
            <button type="button" aria-label="减少" disabled={busy || count <= INDEPENDENT_MIN_SESSIONS} onClick={() => onCountChange(Math.max(INDEPENDENT_MIN_SESSIONS, count - 1))}>−</button>
            <output key={count} aria-live="polite">{count}</output>
            <button type="button" aria-label="增加" disabled={busy || count >= INDEPENDENT_MAX_SESSIONS} onClick={() => onCountChange(Math.min(INDEPENDENT_MAX_SESSIONS, count + 1))}>+</button>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="run-panel run-panel--independent" aria-label="独立批次">
      <header className="run-section-head">
        <strong>批次</strong>
        {view.run ? (
          <span title={formatFullClock(ended ? view.run.updatedAt : view.run.createdAt)}>
            {ended ? '结束于' : '创建于'} {formatRelativeClock(ended ? view.run.updatedAt : view.run.createdAt)}
          </span>
        ) : null}
      </header>

      <div className="run-batch">
        <span className="run-batch__count"><b>{waiting + working}</b><small>/ {view.seats.length} 在岗</small></span>
        <dl className="run-batch__breakdown">
          <div><dt>待命</dt><dd>{waiting}</dd></div>
          <div><dt>执行中</dt><dd>{working}</dd></div>
          <div><dt>离线</dt><dd>{view.seats.filter((seat) => seat.state === 'offline').length}</dd></div>
          {view.seats.some((seat) => seat.state === 'unconfirmed') ? (
            <div><dt>待确认</dt><dd>{view.seats.filter((seat) => seat.state === 'unconfirmed').length}</dd></div>
          ) : null}
        </dl>
      </div>

      {view.cursorWorkspaceChanged ? (
        <p className="run-callout is-warning">
          Cursor 当前打开的不是本批次的工程「{view.workspace?.name}」；补齐会话仍指向本批次工程，新工程请新建批次。
        </p>
      ) : null}

      <footer className="run-panel__actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onNewBatch}>
          {ended ? '新建批次' : '结束并新建批次'}
        </button>
        <small className="run-panel__hint">
          {ended ? '本批次已结束，可以直接开始新批次' : '新批次会替换当前批次；同一工程只保留一个活跃运行'}
        </small>
      </footer>
    </section>
  )
}
