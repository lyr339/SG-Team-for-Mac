export type WorkspaceReviewState = 'ready' | 'clean' | 'not_git' | 'unavailable' | 'error'

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
  additions?: number
  deletions?: number
  binary?: boolean
}

export interface WorkspaceReviewSummary {
  state: WorkspaceReviewState
  workspaceName: string
  files: WorkspaceReviewFileSummary[]
  additions: number
  deletions: number
  revision: string
  updatedAt: number
  detail?: string
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
