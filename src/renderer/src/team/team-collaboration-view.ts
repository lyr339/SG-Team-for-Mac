import type { TeamCollaborationSnapshot } from '../../../domain/team-collaboration'
import { emptyTeamCollaborationSnapshot } from '../../../domain/team-collaboration'
import type { TeamRun } from '../../../domain/team-control'

type ActiveRunForCollaboration = Pick<TeamRun, 'id' | 'status'> | undefined

const COLLABORATION_VISIBLE_STATUSES = new Set<TeamRun['status']>([
  'launching',
  'running',
  'attention',
  'paused'
])

export interface TeamCollaborationSummary {
  operatorUnread: number
  pendingAgentReplies: number
  threadCount: number
}

export function shouldShowCollaborationForRun(
  collaboration: TeamCollaborationSnapshot,
  activeRun: ActiveRunForCollaboration
): boolean {
  return Boolean(activeRun && COLLABORATION_VISIBLE_STATUSES.has(activeRun.status) && collaboration.runId === activeRun.id)
}

export function visibleTeamCollaborationSnapshot(
  collaboration: TeamCollaborationSnapshot,
  activeRun: ActiveRunForCollaboration
): TeamCollaborationSnapshot {
  return shouldShowCollaborationForRun(collaboration, activeRun)
    ? collaboration
    : emptyTeamCollaborationSnapshot(activeRun?.id)
}

export function summarizeTeamCollaborationForRun(
  collaboration: TeamCollaborationSnapshot,
  activeRun: ActiveRunForCollaboration
): TeamCollaborationSummary {
  if (!shouldShowCollaborationForRun(collaboration, activeRun)) {
    return { operatorUnread: 0, pendingAgentReplies: 0, threadCount: 0 }
  }

  return collaboration.messageOrder.reduce<TeamCollaborationSummary>((summary, id) => {
    const message = collaboration.messages[id]
    if (!message) return summary
    if (message.recipient.type === 'operator' && message.receipt.readAt === undefined) {
      summary.operatorUnread += 1
    }
    if (
      message.recipient.type === 'agent'
      && message.receipt.respondedAt === undefined
      && (message.kind === 'directive' || message.kind === 'question')
    ) {
      summary.pendingAgentReplies += 1
    }
    return summary
  }, {
    operatorUnread: 0,
    pendingAgentReplies: 0,
    threadCount: collaboration.threads.length
  })
}
