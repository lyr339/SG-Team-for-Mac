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
 */
export function shouldAutoFollowCursorWorkspace(input: {
  detection: CursorWorkspaceDetection
  activeWorkspaceId?: string
  activeRunStatus?: string
}): boolean {
  const { detection, activeWorkspaceId, activeRunStatus } = input
  if (
    detection.state !== 'detected'
    || detection.confidence !== 'certain'
    || !detection.workspace
    || detection.workspace.id === activeWorkspaceId
  ) return false
  return !activeRunStatus || !ACTIVE_RUN_STATUSES.has(activeRunStatus)
}
