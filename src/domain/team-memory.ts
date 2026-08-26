import type { TeamMessageActor } from './team-collaboration'

export type TeamMemoryScope = 'run' | 'project'
export type TeamMemoryKind = 'decision' | 'constraint' | 'fact' | 'risk' | 'lesson'
export type TeamMemoryStatus = 'proposed' | 'accepted' | 'superseded' | 'rejected'
export type TeamMemorySourceType = 'message' | 'task' | 'file'

export interface TeamMemorySource {
  type: TeamMemorySourceType
  ref: string
  label: string
}

export interface TeamMemoryItem {
  id: string
  workspaceId: string
  runId: string
  scope: TeamMemoryScope
  kind: TeamMemoryKind
  title: string
  content: string
  status: TeamMemoryStatus
  version: number
  proposedBy: TeamMessageActor
  reviewedBy?: TeamMessageActor
  reviewNote?: string
  acceptedAt?: number
  supersedesId?: string
  supersededById?: string
  sources: TeamMemorySource[]
  createdAt: number
  updatedAt: number
}

export interface TeamMemoryEvent {
  seq: number
  type: string
  workspaceId: string
  runId: string
  memoryId: string
  actor: TeamMessageActor
  detail?: string
  at: number
}

export interface TeamMemorySnapshot {
  schemaVersion: 1
  revision: number
  seq: number
  workspaceId?: string
  runId?: string
  items: Record<string, TeamMemoryItem>
  itemOrder: string[]
  events: TeamMemoryEvent[]
  updatedAt: number
}

export interface ProposeTeamMemoryInput {
  workspaceId: string
  runId: string
  scope: TeamMemoryScope
  kind: TeamMemoryKind
  title: string
  content: string
  proposedBy: TeamMessageActor
  sources: TeamMemorySource[]
  supersedesId?: string
  clientProposalId: string
}

export interface ReviewTeamMemoryInput {
  memoryId: string
  decision: 'accept' | 'reject'
  reviewer: TeamMessageActor
  note?: string
}

export function emptyTeamMemorySnapshot(
  workspaceId?: string,
  runId?: string
): TeamMemorySnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    seq: 0,
    workspaceId,
    runId,
    items: {},
    itemOrder: [],
    events: [],
    updatedAt: Date.now()
  }
}
