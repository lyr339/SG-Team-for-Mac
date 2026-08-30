export type CursorWorkspaceDetectionState = 'detected' | 'ambiguous' | 'unavailable'
export type CursorWorkspaceDetectionSource = 'running-qingtian-mcp' | 'cursor-recent'
export type CursorWorkspaceDetectionConfidence = 'certain' | 'likely' | 'none'

export interface DetectedCursorWorkspace {
  id: string
  name: string
  path: string
  cursorWorkspaceId?: string
  channelIds: string[]
}

export interface CursorWorkspaceDetection {
  state: CursorWorkspaceDetectionState
  source?: CursorWorkspaceDetectionSource
  confidence: CursorWorkspaceDetectionConfidence
  workspace?: DetectedCursorWorkspace
  candidates: DetectedCursorWorkspace[]
  detail: string
  observedAt: number
}

const ACTIVE_RUN_STATUSES = new Set(['launching', 'running', 'attention', 'paused'])

/**
 * Only a unique live MCP process is strong enough to move the app without a
 * click. A running team is never silently abandoned; the detected workspace
 * remains visible in the header and the operator can explicitly switch.
 *
 * Fresh-install exception: S4 global MCP registration made 'certain'
 * (workspaceStorage runtime process) architecturally unreachable, so a brand
 * new install would sit on the empty state forever. When nothing is bound
 * yet, recent-only ('likely') evidence is accepted — once something is bound,
 * the stricter original policy applies unchanged.
 */
export function shouldAutoFollowCursorWorkspace(input: {
  detection: CursorWorkspaceDetection
  activeWorkspaceId?: string
  activeRunStatus?: string
}): boolean {
  const { detection, activeWorkspaceId, activeRunStatus } = input
  if (
    detection.state !== 'detected'
    || !detection.workspace
    || detection.workspace.id === activeWorkspaceId
  ) return false
  if (activeRunStatus && ACTIVE_RUN_STATUSES.has(activeRunStatus)) return false
  // 已绑定工程时维持原策略：recent 级证据不足以无点击切换；
  // 全新装机（未绑定任何工程）例外——否则首启永远停在「选择工程」空态。
  if (detection.confidence !== 'certain' && activeWorkspaceId !== undefined) return false
  return true
}
