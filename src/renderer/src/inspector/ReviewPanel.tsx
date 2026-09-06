import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  WorkspaceDiffHunk,
  WorkspaceReviewAction,
  WorkspaceReviewFileDiff,
  WorkspaceReviewFileStatus,
  WorkspaceReviewFileSummary,
  WorkspaceReviewScope,
  WorkspaceReviewSummary
} from '../../../domain/workspace-review'
import { fileActionAvailability, hunkActionAvailability } from '../../../domain/workspace-review'
import { RefreshIcon } from '../UiIcons'
import { Collapsible } from './Collapsible'
import { inspectorDesktopApi } from './desktop-api'
import { hunkInlineSegments, type InlineSegment } from './inline-diff'
import { ChevronIcon, CollapseAllIcon, CopyIcon, DiffIcon, ExpandAllIcon, FolderIcon, OpenExternalIcon, QuoteIcon, RevertIcon, StageIcon, UnstageIcon } from './InspectorIcons'
import { InspectorSkeleton, InspectorState, InspectorToast, useTransientFeedback } from './InspectorState'
import { fileTouchedBy, filterSummaryToPaths, REVIEW_SCOPE_LABELS, type ReviewScopeId } from './review-scope'
import { useWorkspaceFileActions } from './use-workspace-file-actions'

export interface ReviewPanelProps {
  /** 工作区身份变化时重置全部状态。 */
  workspaceKey: string
  /** 本轮（最近一条已投递用户消息之后）改动过的路径；「本轮」范围据此过滤。 */
  turnPaths: readonly string[]
  /** 把一段引用写进输入框（反馈给 Agent）。缺省不显示该动作。 */
  onQuote?: (text: string) => void
  /** 摘要更新回调（供产物面板复用同一份数据，不重复拉取）。 */
  onSummary?: (summary: WorkspaceReviewSummary | undefined) => void
  /**
   * 右栏收起但仍挂载：停掉兜底轮询，主进程推送只记一个「待刷新」标记；
   * 重新展开时补拉一次。展开状态与已加载的差异原样保留。
   */
  paused?: boolean
  /** 测试注入：轮询间隔。 */
  pollIntervalMs?: { live: number; fallback: number }
}

const STATUS_LABELS: Record<WorkspaceReviewFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!'
}

const STATUS_TITLES: Record<WorkspaceReviewFileStatus, string> = {
  modified: '已修改',
  added: '新增',
  deleted: '已删除',
  renamed: '已重命名',
  untracked: '未跟踪',
  conflicted: '有冲突'
}

const SCOPE_ORDER: ReviewScopeId[] = ['uncommitted', 'turn', 'branch']
const SCOPE_TITLES: Record<ReviewScopeId, string> = {
  uncommitted: '工作树相对 HEAD 的全部未提交变更',
  turn: '最近一条用户消息之后 Agent 改动过的文件',
  branch: '当前分支相对基线分支的全部变更（含已提交）'
}
const SCOPE_STORAGE_KEY = 'qingtian-team.inspector:review-scope'
const DEFAULT_POLL = { live: 15_000, fallback: 2_000 }
const KEYBOARD_HINT = 'j / k 切换文件 · n / p 切换代码块'

function readStoredScope(): ReviewScopeId {
  try {
    const stored = localStorage.getItem(SCOPE_STORAGE_KEY)
    return SCOPE_ORDER.includes(stored as ReviewScopeId) ? stored as ReviewScopeId : 'uncommitted'
  } catch {
    return 'uncommitted'
  }
}

function gitScopeOf(scope: ReviewScopeId): WorkspaceReviewScope {
  return scope === 'branch' ? 'branch' : 'uncommitted'
}

/**
 * 路径拆成目录 / 文件名主干 / 扩展名三段：目录从头部截断，主干从尾部截断，扩展名永不截断——
 * 窄栏里 `workspace-inspector…` 会变成 `workspace-insp….css`，类型信息不丢。
 * 点开头的隐藏文件（.gitignore）与无扩展名文件整体视为主干。
 */
export function splitPath(path: string): { dir: string; stem: string; ext: string } {
  const index = path.lastIndexOf('/')
  const dir = index < 0 ? '' : path.slice(0, index + 1)
  const name = index < 0 ? path : path.slice(index + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { dir, stem: name, ext: '' }
  return { dir, stem: name.slice(0, dot), ext: name.slice(dot) }
}

function hunkLineRange(hunk: WorkspaceDiffHunk): { from: number; to: number } | undefined {
  const numbers = hunk.lines
    .map((line) => line.newLine ?? line.oldLine)
    .filter((value): value is number => typeof value === 'number')
  if (!numbers.length) return undefined
  return { from: Math.min(...numbers), to: Math.max(...numbers) }
}

/** 引用一个 hunk 给 Agent：路径 + 行区间 + diff 代码块，用户在后面补一句话。 */
export function buildHunkQuote(path: string, hunk: WorkspaceDiffHunk): string {
  const range = hunkLineRange(hunk)
  const where = range ? (range.from === range.to ? `L${range.from}` : `L${range.from}–L${range.to}`) : ''
  const body = hunk.lines
    .filter((line) => line.kind !== 'meta')
    .map((line) => `${line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' '}${line.text}`)
    .slice(0, 120)
  return [`> 关于 \`${path}\`${where ? ` ${where}` : ''}：`, '', '```diff', hunk.header, ...body, '```', ''].join('\n')
}

export function buildFileQuote(file: WorkspaceReviewFileSummary): string {
  const counts = file.binary ? '二进制' : `+${file.additions ?? 0} −${file.deletions ?? 0}`
  return `> 关于 \`${file.path}\`（${STATUS_TITLES[file.status]} · ${counts}）：\n\n`
}

function InlineText({ text, segments }: { text: string; segments?: InlineSegment[] }): React.JSX.Element {
  if (!segments) return <>{text}</>
  return <>{segments.map((segment, index) => segment.changed ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>)}</>
}

interface HunkViewProps {
  path: string
  hunk: WorkspaceDiffHunk
  index: number
  actions: { stage: boolean; unstage: boolean; revert: boolean }
  onQuote?: (text: string) => void
  onAction: (action: WorkspaceReviewAction, hunkHeader: string) => void
}

const HunkView = memo(function HunkView({ path, hunk, index, actions, onQuote, onAction }: HunkViewProps): React.JSX.Element {
  const segments = useMemo(() => hunkInlineSegments(hunk.lines), [hunk.lines])
  const range = hunkLineRange(hunk)
  return (
    <div className="review-hunk" data-hunk-index={index}>
      {hunk.skippedBefore > 0 ? <div className="review-hunk__skipped">{hunk.skippedBefore} 行未修改</div> : null}
      <div className="review-hunk__header" tabIndex={-1}>
        <code>{hunk.header}</code>
        <span className="review-hunk__actions">
          {onQuote ? <button type="button" title="把这段差异引用到输入框，向 Agent 提问或要求修改" aria-label="反馈这段差异给 Agent" onClick={() => onQuote(buildHunkQuote(path, hunk))}><QuoteIcon /></button> : null}
          {actions.stage ? <button type="button" title="暂存这个代码块" aria-label={`暂存代码块 ${range ? `L${range.from}` : index + 1}`} onClick={() => onAction('stage', hunk.header)}><StageIcon /></button> : null}
          {actions.unstage ? <button type="button" title="取消暂存这个代码块" aria-label={`取消暂存代码块 ${range ? `L${range.from}` : index + 1}`} onClick={() => onAction('unstage', hunk.header)}><UnstageIcon /></button> : null}
          {actions.revert ? <button type="button" className="is-danger" title="撤销这个代码块的改动（不可恢复）" aria-label={`撤销代码块 ${range ? `L${range.from}` : index + 1}`} onClick={() => onAction('revert', hunk.header)}><RevertIcon /></button> : null}
        </span>
      </div>
      {hunk.lines.map((line, lineIndex) => (
        <div className={`review-line is-${line.kind}`} key={`${index}:${lineIndex}`}>
          <span>{line.oldLine ?? ''}</span>
          <span>{line.newLine ?? ''}</span>
          <pre><i>{line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' '}</i><InlineText text={line.text} segments={segments[lineIndex]} /></pre>
        </div>
      ))}
    </div>
  )
})

function FileDiffView({ path, diff, actions, onQuote, onAction }: {
  path: string
  diff: WorkspaceReviewFileDiff
  actions: { stage: boolean; unstage: boolean; revert: boolean }
  onQuote?: (text: string) => void
  onAction: (action: WorkspaceReviewAction, hunkHeader: string) => void
}): React.JSX.Element {
  if (diff.state === 'binary') return <p className="review-file__empty">二进制文件已变化</p>
  if (diff.state === 'missing' || diff.state === 'error') {
    return <p className="review-file__empty is-error">{diff.detail || '差异读取失败'}</p>
  }
  if (!diff.hunks.length) return <p className="review-file__empty">文件状态已变化，当前没有可展示的文本差异</p>
  return (
    <div className="review-diff">
      {diff.hunks.map((hunk, index) => (
        <HunkView key={`${path}:${hunk.header}:${index}`} path={path} hunk={hunk} index={index} actions={actions} onQuote={onQuote} onAction={onAction} />
      ))}
      {diff.truncated ? <div className="review-diff__truncated">差异过长，已显示前 4,000 行</div> : null}
    </div>
  )
}

interface PendingConfirm {
  path: string
  hunkHeader?: string
  label: string
}

/**
 * 撤销确认：锚在所属文件行下方的浮层，不挤开列表；Esc 或「取消」关闭，
 * 焦点落在确认按钮上，回车即确认。
 */
function RevertConfirm({ confirm, onCancel, onConfirm }: { confirm: PendingConfirm; onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  return (
    <div className="inspector-confirm" role="alertdialog" aria-label="确认撤销" onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCancel()
      }
    }}>
      <p>{confirm.label}</p>
      <div>
        <button type="button" className="is-secondary" onClick={onCancel}>取消</button>
        <button type="button" className="is-danger" autoFocus onClick={onConfirm}>确认撤销</button>
      </div>
    </div>
  )
}

/** 以 `.is-revealed` 短暂高亮一个元素（与时间线定位同一视觉语言）。 */
function flashElement(element: HTMLElement): void {
  element.classList.add('is-revealed')
  window.setTimeout(() => element.classList.remove('is-revealed'), 1_400)
}

export function ReviewPanel({ workspaceKey, turnPaths, onQuote, onSummary, paused = false, pollIntervalMs = DEFAULT_POLL }: ReviewPanelProps): React.JSX.Element {
  const [scope, setScope] = useState<ReviewScopeId>(readStoredScope)
  const [summary, setSummary] = useState<WorkspaceReviewSummary>()
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [diffs, setDiffs] = useState<Record<string, WorkspaceReviewFileDiff | 'loading'>>({})
  const [confirm, setConfirm] = useState<PendingConfirm>()
  const [busyPath, setBusyPath] = useState('')
  const [feedback, flash] = useTransientFeedback()
  const fileActions = useWorkspaceFileActions(flash)
  const requestId = useRef(0)
  const summaryInFlight = useRef(false)
  const revisionRef = useRef('')
  const initializedWorkspace = useRef('')
  const listRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(paused)
  /** 收起期间收到过主进程推送：展开时补拉。 */
  const refreshWhenResumed = useRef(false)

  useEffect(() => {
    try { localStorage.setItem(SCOPE_STORAGE_KEY, scope) } catch { /* 当前窗口仍保持选择。 */ }
  }, [scope])

  const loadSummary = useCallback(async (showBusy = false): Promise<void> => {
    if (summaryInFlight.current) return
    summaryInFlight.current = true
    const id = ++requestId.current
    if (showBusy) setRefreshing(true)
    try {
      const api = inspectorDesktopApi()
      if (!api?.getWorkspaceReview) throw new Error('当前环境没有桌面 API，无法读取工作区变更')
      const next = await api.getWorkspaceReview({ scope: gitScopeOf(scope) })
      if (id !== requestId.current) return
      // IPC 返回空值（主进程尚未注册该通道 / 预览环境未 mock）按读取失败处理，不让空对象进入投影。
      if (!next || typeof next !== 'object' || typeof next.state !== 'string') throw new Error('工作区变更摘要不可用')
      setError('')
      setSummary((current) => current?.revision === next.revision && current.state === next.state && current.scope === next.scope
        ? { ...current, updatedAt: next.updatedAt, detail: next.detail, liveUpdates: next.liveUpdates, headCommit: next.headCommit }
        : next)
    } catch (reason) {
      if (id === requestId.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (id === requestId.current && showBusy) setRefreshing(false)
      summaryInFlight.current = false
    }
  }, [scope])

  /**
   * 读取单文件差异。`keepStale`（revision 刷新时）让旧差异留在屏幕上直到新差异到达——
   * Agent 连续写文件时监听会高频推送，若每次都先切回骨架屏，已展开的差异会不停闪动。
   * 首次展开没有旧差异，仍显示骨架。
   */
  const loadDiff = useCallback(async (path: string, revision: string, options: { keepStale?: boolean } = {}): Promise<void> => {
    setDiffs((current) => (
      options.keepStale && current[path] !== undefined && current[path] !== 'loading'
        ? current
        : { ...current, [path]: 'loading' }
    ))
    try {
      const api = inspectorDesktopApi()
      if (!api?.getWorkspaceReviewFile) throw new Error('当前环境没有桌面 API')
      const diff = await api.getWorkspaceReviewFile({ path, scope: gitScopeOf(scope) })
      if (revisionRef.current !== revision) return
      setDiffs((current) => ({ ...current, [path]: diff }))
    } catch (reason) {
      if (revisionRef.current !== revision) return
      setDiffs((current) => ({
        ...current,
        [path]: { state: 'error', path, hunks: [], truncated: false, detail: reason instanceof Error ? reason.message : String(reason) }
      }))
    }
  }, [scope])

  // 工作区 / 范围切换：清空并重新拉取；订阅主进程推送；兜底轮询频率随监听状态调整。
  useEffect(() => {
    requestId.current += 1
    summaryInFlight.current = false
    revisionRef.current = ''
    initializedWorkspace.current = ''
    setSummary(undefined)
    setError('')
    setExpanded(new Set())
    setDiffs({})
    setConfirm(undefined)
    void loadSummary()
    const unsubscribe = inspectorDesktopApi()?.onWorkspaceReviewChanged?.(() => {
      if (pausedRef.current) refreshWhenResumed.current = true
      else void loadSummary()
    }) ?? (() => {})
    return () => {
      requestId.current += 1
      summaryInFlight.current = false
      unsubscribe()
    }
  }, [loadSummary, workspaceKey])

  // 收起 → 展开：补拉一次（收起期间的推送只记了标记，兜底轮询也停了）。
  useEffect(() => {
    const wasPaused = pausedRef.current
    pausedRef.current = paused
    if (paused || !wasPaused) return
    refreshWhenResumed.current = false
    void loadSummary()
  }, [loadSummary, paused])

  const liveUpdates = summary?.liveUpdates === true
  useEffect(() => {
    if (paused) return
    const interval = liveUpdates ? pollIntervalMs.live : pollIntervalMs.fallback
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadSummary()
    }, interval)
    return () => window.clearInterval(timer)
  }, [liveUpdates, loadSummary, paused, pollIntervalMs.fallback, pollIntervalMs.live])

  const visible = useMemo(() => (
    summary && scope === 'turn' ? filterSummaryToPaths(summary, turnPaths) : summary
  ), [scope, summary, turnPaths])

  useEffect(() => {
    onSummary?.(summary)
  }, [onSummary, summary])

  // revision 变化 → 已展开文件的差异就地重拉（旧差异保留到新差异到达），
  // 不再出现在摘要里的文件才丢缓存；首次加载默认展开第一个文件。
  useEffect(() => {
    if (!visible?.revision || visible.state !== 'ready') return
    const revisionChanged = revisionRef.current !== visible.revision
    const firstForWorkspace = initializedWorkspace.current !== workspaceKey
    if (!revisionChanged && !firstForWorkspace) return
    revisionRef.current = visible.revision
    let open = expanded
    if (firstForWorkspace) {
      initializedWorkspace.current = workspaceKey
      open = visible.files[0] ? new Set([visible.files[0].path]) : new Set()
      setExpanded(open)
    }
    // 只有正展开着的文件才值得保留旧差异（避免闪动）；收起的文件下次展开时重新读取。
    const listed = new Set(visible.files.map((file) => file.path))
    setDiffs((current) => {
      const kept = Object.entries(current).filter(([path]) => listed.has(path) && open.has(path))
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept)
    })
    for (const file of visible.files) {
      if (open.has(file.path)) void loadDiff(file.path, visible.revision, { keepStale: true })
    }
  }, [expanded, loadDiff, visible, workspaceKey])

  const ensureDiff = (path: string): void => {
    if (visible && diffs[path] === undefined) void loadDiff(path, visible.revision)
  }

  const toggleFile = (file: WorkspaceReviewFileSummary): void => {
    const next = new Set(expanded)
    if (next.has(file.path)) next.delete(file.path)
    else {
      next.add(file.path)
      ensureDiff(file.path)
    }
    setExpanded(next)
  }

  const files = visible?.state === 'ready' ? visible.files : []
  const allExpanded = files.length > 0 && files.every((file) => expanded.has(file.path))
  const toggleAll = (): void => {
    if (allExpanded) {
      setExpanded(new Set())
      return
    }
    for (const file of files) ensureDiff(file.path)
    setExpanded(new Set(files.map((file) => file.path)))
  }

  const runAction = async (path: string, action: WorkspaceReviewAction, hunkHeader?: string): Promise<void> => {
    setBusyPath(path)
    try {
      const api = inspectorDesktopApi()
      if (!api?.applyWorkspaceReviewAction) throw new Error('当前环境不支持 Git 操作')
      const result = await api.applyWorkspaceReviewAction({ path, action, ...(hunkHeader ? { hunkHeader } : {}) })
      flash(result.message)
      if (result.ok) void loadSummary()
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyPath('')
    }
  }

  const requestAction = (file: WorkspaceReviewFileSummary, action: WorkspaceReviewAction, hunkHeader?: string): void => {
    if (action === 'revert') {
      const inHead = !(file.status === 'untracked' || file.status === 'added')
      setConfirm({
        path: file.path,
        hunkHeader,
        label: hunkHeader
          ? `撤销 ${file.path} 中这个代码块的改动？该操作直接改写工作树文件，无法从拾光恢复。`
          : inHead
            ? `撤销 ${file.path} 的全部未提交改动？文件会恢复到 HEAD 版本，无法从拾光恢复。`
            : `${file.path} 尚未进入任何提交。撤销会把它移到系统回收站。`
      })
      return
    }
    void runAction(file.path, action, hunkHeader)
  }

  // j / k 在文件间移动焦点；n / p 在已展开的代码块间跳转（滚动到块头并短暂高亮）。
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    const list = listRef.current
    if (!list) return
    if (event.key === 'j' || event.key === 'k') {
      const heads = Array.from(list.querySelectorAll<HTMLButtonElement>('.review-file__head'))
      if (!heads.length) return
      const index = heads.findIndex((head) => head === document.activeElement || head.contains(document.activeElement))
      const next = event.key === 'j' ? Math.min(heads.length - 1, index + 1) : Math.max(0, index - 1)
      event.preventDefault()
      heads[next]?.focus()
      heads[next]?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (event.key === 'n' || event.key === 'p') {
      const headers = Array.from(list.querySelectorAll<HTMLElement>('.inspector-collapsible.is-open .review-hunk__header'))
      if (!headers.length) return
      // 以列表视口上沿为基准：n 找第一个还在下方的块头，p 找最后一个已在上方的块头。
      const top = list.getBoundingClientRect().top + 48
      const offsets = headers.map((header) => header.getBoundingClientRect().top - top)
      const index = event.key === 'n'
        ? offsets.findIndex((offset) => offset > 8)
        : offsets.reduce((found, offset, candidate) => offset < -8 ? candidate : found, -1)
      const next = headers[index < 0 ? (event.key === 'n' ? headers.length - 1 : 0) : index]
      if (!next) return
      event.preventDefault()
      next.scrollIntoView({ block: 'start' })
      next.focus({ preventScroll: true })
      flashElement(next)
    }
  }

  const branch = summary?.branch
  const branchLabel = branch
    ? branch.base && !branch.onBase ? `${branch.current} → ${branch.base}` : branch.current
    : ''
  const highlightTurn = scope !== 'turn' && turnPaths.length > 0

  return (
    <section className="inspector-review" aria-label="工作区代码审查">
      <header className="inspector-review__summary">
        <div className="inspector-review__scope" role="group" aria-label="审查范围">
          {SCOPE_ORDER.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={candidate === scope ? 'is-active' : ''}
              aria-pressed={candidate === scope}
              title={SCOPE_TITLES[candidate]}
              onClick={() => setScope(candidate)}
            >
              {REVIEW_SCOPE_LABELS[candidate]}
              {candidate === 'turn' && turnPaths.length ? <b>{turnPaths.length}</b> : null}
            </button>
          ))}
        </div>
        <div className="inspector-review__totals" aria-label={visible?.state === 'ready' ? `新增 ${visible.additions} 行，删除 ${visible.deletions} 行` : undefined}>
          {/* 只有真有变更时才显示合计；干净 / 出错态的 +0 −0 是噪音。 */}
          {visible?.state === 'ready' ? <><b>+{visible.additions}</b><em>−{visible.deletions}</em></> : null}
          <button type="button" className={`inspector-icon-button${refreshing ? ' is-spinning' : ''}`} aria-label="刷新工作区变更" title={liveUpdates ? '正在实时监听工作区；点击立即刷新' : '刷新'} onClick={() => void loadSummary(true)}>
            <RefreshIcon />
          </button>
        </div>
      </header>
      <div className="inspector-review__meta">
        <span className="inspector-review__workspace" title={summary?.workspaceName}>{summary?.workspaceName || '等待识别工程'}</span>
        {branchLabel ? <code className="inspector-review__branch" title={branch?.base ? `基线分支：${branch.base}` : '当前分支'}>{branchLabel}</code> : null}
        {liveUpdates ? <span className="inspector-review__live" title="主进程正在监听文件系统变化，改动会即时出现"><i /><b>实时</b></span> : null}
        {visible?.state === 'ready' ? (
          <span className="inspector-review__count">
            {visible.files.length} 个文件
            {files.length > 1 ? (
              <button type="button" className="inspector-icon-button" aria-label={allExpanded ? '收起全部文件' : '展开全部文件'} title={`${allExpanded ? '收起全部' : '展开全部'} · ${KEYBOARD_HINT}`} onClick={toggleAll}>
                {allExpanded ? <CollapseAllIcon /> : <ExpandAllIcon />}
              </button>
            ) : null}
          </span>
        ) : null}
      </div>

      {error ? <InspectorState tone="error" title="读取工作区变更失败" hint={error} compact /> : null}
      {!summary && !error ? <InspectorSkeleton rows={4} /> : null}
      {visible?.state === 'clean' ? (
        <InspectorState
          icon={<DiffIcon />}
          title={scope === 'turn' ? '本轮尚未修改文件' : scope === 'branch' ? '分支相对基线没有变更' : '工作区干净'}
          hint={scope === 'turn'
            ? 'Agent 在这一轮里执行的 edit / write 会让文件出现在这里'
            : summary?.headCommit
              ? <>当前没有未提交变更 · 最近提交 <code>{summary.headCommit.short}</code> {summary.headCommit.subject}</>
              : '当前没有未提交变更'}
          action={scope === 'turn'
            ? <button type="button" className="inspector-link" onClick={() => setScope('uncommitted')}>查看全部未提交变更</button>
            : undefined}
        />
      ) : null}
      {summary?.state === 'not_git' || summary?.state === 'unavailable' || summary?.state === 'error' ? (
        <InspectorState
          icon={<DiffIcon />}
          tone={summary.state === 'error' ? 'error' : 'neutral'}
          title={summary.state === 'not_git' ? '当前工程未启用 Git' : summary.state === 'error' ? '读取变更出错' : '变更暂未就绪'}
          hint={summary.detail}
          action={summary.state === 'error' ? <button type="button" className="inspector-link" onClick={() => void loadSummary(true)}>重试</button> : undefined}
        />
      ) : null}
      {summary?.detail && summary.state === 'ready' ? <p className="inspector-review__note">{summary.detail}</p> : null}

      {visible?.state === 'ready' ? (
        <div className="review-files" ref={listRef} onKeyDown={onListKeyDown} title={KEYBOARD_HINT}>
          {visible.files.map((file) => {
            const open = expanded.has(file.path)
            const diff = diffs[file.path]
            const { dir, stem, ext } = splitPath(file.path)
            const availability = fileActionAvailability(file)
            const hunkActions = scope === 'branch' ? { stage: false, unstage: false, revert: false } : hunkActionAvailability(file)
            const busy = busyPath === file.path
            const confirming = confirm?.path === file.path
            const touchedThisTurn = highlightTurn && fileTouchedBy(file, turnPaths)
            const stateLabel = file.committed ? '已提交' : file.staged && file.unstaged ? '部分暂存' : file.staged ? '已暂存' : ''
            const gitActions = scope !== 'branch'
            const headTitle = [
              file.previousPath ? `${file.previousPath} → ${file.path}` : file.path,
              STATUS_TITLES[file.status],
              stateLabel
            ].filter(Boolean).join(' · ')
            return (
              <article className={`review-file is-${file.status}${open ? ' is-open' : ''}${busy ? ' is-busy' : ''}${confirming ? ' is-confirming' : ''}${touchedThisTurn ? ' is-turn' : ''}`} key={file.path}>
                <div className="review-file__row">
                  <button className="review-file__head" type="button" onClick={() => toggleFile(file)} aria-expanded={open} title={headTitle}>
                    <i title={STATUS_TITLES[file.status]}>{STATUS_LABELS[file.status]}</i>
                    <span className="review-file__path">
                      {dir ? <small><bdi>{dir}</bdi></small> : null}
                      <strong><span>{stem}</span>{ext ? <b>{ext}</b> : null}</strong>
                      {touchedThisTurn ? <em className="is-turn" title="本轮 Agent 改动过这个文件">本轮</em> : null}
                      {stateLabel ? <em className="review-file__state">{stateLabel}</em> : null}
                    </span>
                    <span className="review-file__counts">
                      {file.binary ? <small>BIN</small> : <><b>+{file.additions ?? 0}</b><em>−{file.deletions ?? 0}</em></>}
                    </span>
                    <ChevronIcon open={open} />
                  </button>
                  {/* 动作簇分三组：查看 / 引用 ｜ 暂存 ｜ 撤销（危险，独立成组）。 */}
                  <span className="review-file__actions" role="group" aria-label={`${file.path} 的操作`}>
                    <span className="review-file__action-group">
                      <button type="button" title="在 Cursor 中打开" aria-label={`在编辑器中打开 ${file.path}`} onClick={() => void fileActions.openFile(file.path)}><OpenExternalIcon /></button>
                      <button type="button" title="复制路径" aria-label={`复制路径 ${file.path}`} onClick={() => void fileActions.copyPath(file.path)}><CopyIcon /></button>
                      {file.status !== 'deleted' ? <button type="button" title="在文件管理器中显示" aria-label={`在文件管理器中显示 ${file.path}`} onClick={() => void fileActions.revealFile(file.path)}><FolderIcon /></button> : null}
                      {onQuote ? <button type="button" title="引用这个文件到输入框，向 Agent 提问或要求修改" aria-label={`反馈 ${file.path} 给 Agent`} onClick={() => onQuote(buildFileQuote(file))}><QuoteIcon /></button> : null}
                    </span>
                    {gitActions && (availability.stage || availability.unstage) ? (
                      <span className="review-file__action-group">
                        {availability.stage ? <button type="button" disabled={busy} title="暂存整个文件" aria-label={`暂存 ${file.path}`} onClick={() => requestAction(file, 'stage')}><StageIcon /></button> : null}
                        {availability.unstage ? <button type="button" disabled={busy} title="取消暂存整个文件" aria-label={`取消暂存 ${file.path}`} onClick={() => requestAction(file, 'unstage')}><UnstageIcon /></button> : null}
                      </span>
                    ) : null}
                    {gitActions && availability.revert ? (
                      <span className="review-file__action-group">
                        <button type="button" className="is-danger" disabled={busy} title="撤销整个文件的改动" aria-label={`撤销 ${file.path}`} onClick={() => requestAction(file, 'revert')}><RevertIcon /></button>
                      </span>
                    ) : null}
                  </span>
                  {confirming && confirm ? (
                    <RevertConfirm
                      confirm={confirm}
                      onCancel={() => setConfirm(undefined)}
                      onConfirm={() => {
                        const pending = confirm
                        setConfirm(undefined)
                        void runAction(pending.path, 'revert', pending.hunkHeader)
                      }}
                    />
                  ) : null}
                </div>
                <Collapsible open={open}>
                  {diff === 'loading' || diff === undefined
                    ? <div className="review-file__loading"><InspectorSkeleton rows={3} mono /></div>
                    : <FileDiffView path={file.path} diff={diff} actions={hunkActions} onQuote={onQuote} onAction={(action, hunkHeader) => requestAction(file, action, hunkHeader)} />}
                </Collapsible>
              </article>
            )
          })}
        </div>
      ) : null}
      <InspectorToast message={feedback} />
    </section>
  )
}
