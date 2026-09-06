export type WorkspaceReviewState = 'ready' | 'clean' | 'not_git' | 'unavailable' | 'error'

/**
 * 审查范围：
 * - uncommitted：工作树相对 HEAD 的全部未提交变更（含暂存 / 未暂存 / 未跟踪）；
 * - branch：当前分支相对基线分支（merge-base）的全部变更，含已提交与未提交。
 * 「本轮」范围由渲染层用过程块中的文件路径对 uncommitted 结果做过滤，不进主进程。
 */
export type WorkspaceReviewScope = 'uncommitted' | 'branch'

export type WorkspaceReviewFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'

export interface WorkspaceReviewFileSummary {
  path: string
  previousPath?: string
  status: WorkspaceReviewFileStatus
  staged: boolean
  unstaged: boolean
  /** branch 范围：该文件的变更已全部提交，工作树相对 HEAD 干净。 */
  committed?: boolean
  additions?: number
  deletions?: number
  binary?: boolean
}

export interface WorkspaceReviewBranchInfo {
  /** 当前分支名；detached HEAD 时为短 SHA。 */
  current: string
  /** 解析到的基线分支（如 origin/main / main）；缺失表示无法比较。 */
  base?: string
  /** 当前分支就是基线分支：branch 范围与 uncommitted 等价。 */
  onBase?: boolean
}

export interface WorkspaceReviewHeadCommit {
  short: string
  subject: string
}

export interface WorkspaceReviewSummary {
  state: WorkspaceReviewState
  scope: WorkspaceReviewScope
  workspaceName: string
  files: WorkspaceReviewFileSummary[]
  additions: number
  deletions: number
  revision: string
  updatedAt: number
  detail?: string
  branch?: WorkspaceReviewBranchInfo
  /** 工作区干净时给空态引用最近一次提交。 */
  headCommit?: WorkspaceReviewHeadCommit
  /** 主进程正在用文件系统监听推送变更（渲染层可降低兜底轮询频率）。 */
  liveUpdates?: boolean
}

export type WorkspaceDiffLineKind = 'context' | 'addition' | 'deletion' | 'meta'

export interface WorkspaceDiffLine {
  kind: WorkspaceDiffLineKind
  text: string
  oldLine?: number
  newLine?: number
}

export interface WorkspaceDiffHunk {
  header: string
  skippedBefore: number
  lines: WorkspaceDiffLine[]
}

export interface WorkspaceReviewFileDiff {
  state: 'ready' | 'binary' | 'missing' | 'error'
  path: string
  previousPath?: string
  hunks: WorkspaceDiffHunk[]
  truncated: boolean
  detail?: string
}

export type WorkspaceReviewAction = 'stage' | 'unstage' | 'revert'

export interface WorkspaceReviewActionInput {
  path: string
  action: WorkspaceReviewAction
  /**
   * 只对单个 hunk 操作：以展示中的 hunk 头（`@@ -a,b +c,d @@ …`）定位。
   * 仅当文件是「纯未暂存」（stage / revert）或「纯已暂存」（unstage）时可用，
   * 否则展示中的 HEAD→工作树差异与 git 实际操作基准不一致。
   */
  hunkHeader?: string
}

export interface WorkspaceReviewActionResult {
  ok: boolean
  message: string
}

export interface WorkspaceOpenFileResult {
  ok: boolean
  /** editor：Cursor 深链；system：系统默认程序兜底。 */
  method?: 'editor' | 'system'
  message?: string
}

/** hunk 级 Git 动作是否可用（见 WorkspaceReviewActionInput.hunkHeader 注释）。 */
export function hunkActionAvailability(file: Pick<WorkspaceReviewFileSummary, 'status' | 'staged' | 'unstaged' | 'committed' | 'binary'>): {
  stage: boolean
  unstage: boolean
  revert: boolean
} {
  if (file.binary || file.committed || file.status === 'conflicted' || file.status === 'untracked' || file.status === 'renamed') {
    return { stage: false, unstage: false, revert: false }
  }
  const pureUnstaged = file.unstaged && !file.staged
  const pureStaged = file.staged && !file.unstaged
  return { stage: pureUnstaged, unstage: pureStaged, revert: pureUnstaged }
}

/** 文件级 Git 动作是否可用。 */
export function fileActionAvailability(file: Pick<WorkspaceReviewFileSummary, 'status' | 'staged' | 'unstaged' | 'committed'>): {
  stage: boolean
  unstage: boolean
  revert: boolean
} {
  if (file.committed) return { stage: false, unstage: false, revert: false }
  if (file.status === 'conflicted') return { stage: true, unstage: false, revert: false }
  return { stage: file.unstaged, unstage: file.staged, revert: file.staged || file.unstaged }
}
