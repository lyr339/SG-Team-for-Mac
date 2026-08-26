import type {
  ProposeTeamMemoryInput,
  ReviewTeamMemoryInput,
  TeamMemoryItem,
  TeamMemoryKind,
  TeamMemorySnapshot,
  TeamMemoryStatus
} from '../domain/team-memory'

export interface TeamMemorySearchInput {
  workspaceId: string
  runId: string
  query?: string
  kinds?: TeamMemoryKind[]
  statuses?: TeamMemoryStatus[]
  limit?: number
}

export interface TeamMemoryRepository {
  revision(): number
  load(workspaceId: string, runId: string): TeamMemorySnapshot
  search(input: TeamMemorySearchInput): TeamMemoryItem[]
  propose(input: ProposeTeamMemoryInput): TeamMemoryItem
  review(input: ReviewTeamMemoryInput): TeamMemoryItem
  close(): void
}
