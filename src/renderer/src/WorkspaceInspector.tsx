import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import type { ConversationEntry, ProcessBlock } from '../../domain/conversation-entry'
import type {
  WorkspaceReviewFileDiff,
  WorkspaceReviewFileStatus,
  WorkspaceReviewSummary
} from '../../domain/workspace-review'
import type { LiveProcessState } from '../../shared/desktop-api'
import { RefreshIcon } from './UiIcons'

export type WorkspaceInspectorTab = 'review' | 'todos'

interface WorkspaceInspectorProps {
  session: AgentSession
  entries: ConversationEntry[]
  liveProcess?: LiveProcessState
  workspaceId?: string
  workspaceName?: string
  onClose: () => void
}

export interface CursorTodoItem {
  content: string
  status: string
}

const INSPECTOR_TAB_KEY = 'qingtian-team.inspector:active-tab'

function initialInspectorTab(): WorkspaceInspectorTab {
  try {
    return localStorage.getItem(INSPECTOR_TAB_KEY) === 'todos' ? 'todos' : 'review'
  } catch {
    return 'review'
  }
}

function latestTodoBlock(blocks: readonly ProcessBlock[] | undefined): CursorTodoItem[] | undefined {
  if (!blocks?.length) return undefined
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block?.kind === 'tool' && block.toolKind === 'todo' && block.todos?.length) {
      return block.todos.map((todo) => ({ ...todo }))
    }
  }
  return undefined
}

/** 最新 Cursor 原生 Todo：直播帧优先，回合结束后回落到最近一条持久化过程。 */
function currentCursorTodos(
  entries: readonly ConversationEntry[],
  liveProcess?: LiveProcessState
): CursorTodoItem[] {
  if (liveProcess) return latestTodoBlock(liveProcess.blocks) ?? []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const historical = latestTodoBlock(entries[index]?.processBlocks)
    if (historical) return historical
  }
  return []
}

function todoTone(status: string): 'completed' | 'running' | 'pending' | 'cancelled' {
  if (status === 'completed') return 'completed'
  if (status === 'in_progress' || status === 'running') return 'running'
  if (status === 'pending') return 'pending'
  return 'cancelled'
}

const STATUS_LABELS: Record<WorkspaceReviewFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!'
}

function FileDiffView({ diff }: { diff: WorkspaceReviewFileDiff }): React.JSX.Element {
  if (diff.state === 'binary') return <p className="review-file__empty">二进制文件已变化</p>
  if (diff.state === 'missing' || diff.state === 'error') {
    return <p className="review-file__empty is-error">{diff.detail || '差异读取失败'}</p>
  }
  if (!diff.hunks.length) return <p className="review-file__empty">文件状态已变化，当前没有可展示的文本差异</p>
  return (
    <div className="review-diff">
      {diff.hunks.map((hunk, hunkIndex) => (
        <div className="review-hunk" key={`${diff.path}:hunk:${hunkIndex}`}>
          {hunk.skippedBefore > 0 ? <div className="review-hunk__skipped">{hunk.skippedBefore} 行未修改</div> : null}
          <div className="review-hunk__header">{hunk.header}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div className={`review-line is-${line.kind}`} key={`${hunkIndex}:${lineIndex}`}>
              <span>{line.oldLine ?? ''}</span>
              <span>{line.newLine ?? ''}</span>
              <pre>{line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : line.kind === 'context' ? ' ' : ''}{line.text}</pre>
            </div>
          ))}
        </div>
      ))}
      {diff.truncated ? <div className="review-diff__truncated">差异过长，已显示前 4,000 行</div> : null}
    </div>
  )
}

function ReviewPanel({ workspaceKey }: { workspaceKey: string }): React.JSX.Element {
  const [summary, setSummary] = useState<WorkspaceReviewSummary>()
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [diffs, setDiffs] = useState<Record<string, WorkspaceReviewFileDiff | 'loading'>>({})
  const requestId = useRef(0)
  const summaryInFlight = useRef(false)
  const revisionRef = useRef('')
  const initializedWorkspace = useRef('')

  const loadSummary = useCallback(async (showBusy = false): Promise<void> => {
    if (summaryInFlight.current) return
    summaryInFlight.current = true
    const id = ++requestId.current
    if (showBusy) setRefreshing(true)
    try {
      const next = await window.qingtianDesktop.getWorkspaceReview()
      if (id !== requestId.current) return
      setError('')
      setSummary((current) => current?.revision === next.revision && current.state === next.state
        ? { ...current, updatedAt: next.updatedAt, detail: next.detail }
        : next)
    } catch (reason) {
      if (id === requestId.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (id === requestId.current && showBusy) setRefreshing(false)
      summaryInFlight.current = false
    }
  }, [])

  const loadDiff = useCallback(async (
    file: WorkspaceReviewSummary['files'][number],
    revision: string
  ): Promise<void> => {
    setDiffs((current) => ({ ...current, [file.path]: 'loading' }))
    try {
      const diff = await window.qingtianDesktop.getWorkspaceReviewFile({
        path: file.path
      })
      if (revisionRef.current !== revision) return
      setDiffs((current) => ({ ...current, [file.path]: diff }))
    } catch (reason) {
      if (revisionRef.current !== revision) return
      setDiffs((current) => ({
        ...current,
        [file.path]: {
          state: 'error', path: file.path, previousPath: file.previousPath,
          hunks: [], truncated: false,
          detail: reason instanceof Error ? reason.message : String(reason)
        }
      }))
    }
  }, [])

  useEffect(() => {
    requestId.current += 1
    summaryInFlight.current = false
    revisionRef.current = ''
    initializedWorkspace.current = ''
    setSummary(undefined)
    setError('')
    setExpanded(new Set())
    setDiffs({})
    void loadSummary()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadSummary()
    }, 2_000)
    return () => {
      requestId.current += 1
      summaryInFlight.current = false
      window.clearInterval(timer)
    }
  }, [loadSummary, workspaceKey])

  useEffect(() => {
    if (!summary?.revision || summary.state !== 'ready') return
    const revisionChanged = revisionRef.current !== summary.revision
    revisionRef.current = summary.revision
    if (revisionChanged) setDiffs({})
    let open = expanded
    if (initializedWorkspace.current !== workspaceKey) {
      initializedWorkspace.current = workspaceKey
      open = summary.files[0] ? new Set([summary.files[0].path]) : new Set()
      setExpanded(open)
    }
    if (!revisionChanged && Object.keys(diffs).length) return
    for (const file of summary.files) {
      if (open.has(file.path)) void loadDiff(file, summary.revision)
    }
  }, [diffs, expanded, loadDiff, summary, workspaceKey])

  const toggleFile = (file: WorkspaceReviewSummary['files'][number]): void => {
    const next = new Set(expanded)
    if (next.has(file.path)) next.delete(file.path)
    else {
      next.add(file.path)
      if (summary && diffs[file.path] === undefined) void loadDiff(file, summary.revision)
    }
    setExpanded(next)
  }

  return (
    <section className="inspector-review" role="tabpanel" aria-label="工作区代码审查">
      <header className="inspector-review__summary">
        <div>
          <strong>工作区</strong>
          <span>{summary?.workspaceName || '等待识别工程'}</span>
        </div>
        <div className="inspector-review__totals" aria-label={`新增 ${summary?.additions ?? 0} 行，删除 ${summary?.deletions ?? 0} 行`}>
          <b>+{summary?.additions ?? 0}</b><em>−{summary?.deletions ?? 0}</em>
          <button className={refreshing ? 'is-spinning' : ''} aria-label="刷新工作区变更" title="刷新" onClick={() => void loadSummary(true)}>
            <RefreshIcon />
          </button>
        </div>
      </header>

      {error ? <div className="inspector-state is-error">{error}</div> : null}
      {!summary && !error ? <div className="inspector-state">正在读取工作区变更…</div> : null}
      {summary?.state === 'clean' ? <div className="inspector-state"><strong>工作区干净</strong><span>当前没有未提交变更</span></div> : null}
      {summary?.state === 'not_git' || summary?.state === 'unavailable' || summary?.state === 'error' ? (
        <div className={`inspector-state ${summary.state === 'error' ? 'is-error' : ''}`}>
          <strong>{summary.state === 'not_git' ? '当前工程未启用 Git' : '变更暂未就绪'}</strong>
          <span>{summary.detail}</span>
        </div>
      ) : null}
      {summary?.detail && summary.state === 'ready' ? <p className="inspector-review__note">{summary.detail}</p> : null}

      {summary?.state === 'ready' ? (
        <div className="review-files">
          {summary.files.map((file) => {
            const open = expanded.has(file.path)
            const diff = diffs[file.path]
            return (
              <article className={`review-file is-${file.status}`} key={file.path}>
                <button className="review-file__head" onClick={() => toggleFile(file)} aria-expanded={open}>
                  <i>{STATUS_LABELS[file.status]}</i>
                  <span title={file.path}>{file.path}</span>
                  <span className="review-file__counts">
                    {file.binary ? <small>BIN</small> : <><b>+{file.additions ?? 0}</b><em>−{file.deletions ?? 0}</em></>}
                  </span>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d={open ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" /></svg>
                </button>
                {open ? (
                  diff === 'loading' || diff === undefined
                    ? <div className="review-file__empty">正在读取差异…</div>
                    : <FileDiffView diff={diff} />
                ) : null}
              </article>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

function TodosPanel({ todos }: { todos: CursorTodoItem[] }): React.JSX.Element {
  const completed = todos.filter((todo) => todoTone(todo.status) === 'completed').length
  return (
    <section className="inspector-todos" role="tabpanel" aria-label="Cursor 任务清单">
      <header>
        <div><strong>Cursor Todos</strong><span>来自当前 Composer 的原生任务状态</span></div>
        <b>{completed}/{todos.length}</b>
      </header>
      {todos.length ? (
        <>
          <div className="inspector-todos__progress" role="progressbar" aria-valuemin={0} aria-valuemax={todos.length} aria-valuenow={completed}>
            <i style={{ width: `${Math.round((completed / todos.length) * 100)}%` }} />
          </div>
          <ol>
            {todos.map((todo, index) => {
              const tone = todoTone(todo.status)
              return (
                <li className={`is-${tone}`} key={`${index}:${todo.content}`}>
                  <i aria-hidden="true">{tone === 'completed' ? '✓' : ''}</i>
                  <span>{todo.content}</span>
                  {tone === 'running' ? <em>进行中</em> : null}
                </li>
              )
            })}
          </ol>
        </>
      ) : <div className="inspector-state"><strong>暂无任务清单</strong><span>Cursor 创建 Todo 后会在这里实时出现</span></div>}
    </section>
  )
}

export function WorkspaceInspector({
  session,
  entries,
  liveProcess,
  workspaceId,
  workspaceName,
  onClose
}: WorkspaceInspectorProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<WorkspaceInspectorTab>(initialInspectorTab)
  const todos = useMemo(() => currentCursorTodos(entries, liveProcess), [entries, liveProcess])
  const workspaceKey = workspaceId || workspaceName || session.id
  useEffect(() => {
    try { localStorage.setItem(INSPECTOR_TAB_KEY, activeTab) } catch { /* 当前窗口仍保持选择。 */ }
  }, [activeTab])
  return (
    <aside className="workspace-inspector" aria-label="会话辅助工作区">
      <header className="workspace-inspector__tabs" role="tablist" aria-label="辅助工作区标签">
        <button className={activeTab === 'review' ? 'is-active' : ''} role="tab" aria-selected={activeTab === 'review'} onClick={() => setActiveTab('review')}>
          <span className="inspector-tab-icon">±</span><span>Review</span>
        </button>
        <button className={activeTab === 'todos' ? 'is-active' : ''} role="tab" aria-selected={activeTab === 'todos'} onClick={() => setActiveTab('todos')}>
          <span className="inspector-tab-icon">✓</span><span>Todos</span>{todos.length ? <b>{todos.length}</b> : null}
        </button>
        <button className="workspace-inspector__close" aria-label="收起右侧工作区" title="收起右侧工作区" onClick={onClose}>×</button>
      </header>
      <div className="workspace-inspector__body">
        {activeTab === 'review'
          ? <ReviewPanel workspaceKey={workspaceKey} />
          : <TodosPanel todos={todos} />}
      </div>
    </aside>
  )
}
