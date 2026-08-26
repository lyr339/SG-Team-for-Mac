import type {
  TeamCheckpoint,
  TeamCheckpointCapsule,
  TeamRestoreOperation
} from '../domain/team-continuity'

export interface StoredRestoreOperation extends Omit<TeamRestoreOperation, 'members' | 'status'> {
  status: 'preparing' | 'waiting'
  members: Array<{ slotId: string; roleName: string; messageId?: string }>
}

export interface TeamContinuityRepository {
  revision(): number
  listCheckpoints(workspaceId: string, runId: string, limit?: number): TeamCheckpoint[]
  saveCheckpoint(input: {
    workspaceId: string
    runId: string
    reason: TeamCheckpoint['reason']
    digest: string
    capsule: TeamCheckpointCapsule
  }): TeamCheckpoint
  getCheckpoint(checkpointId: string): TeamCheckpoint | undefined
  beginRestore(input: {
    id: string
    workspaceId: string
    runId: string
    checkpointId: string
    members: Array<{ slotId: string; roleName: string }>
  }): StoredRestoreOperation
  attachRestoreMessage(restoreId: string, slotId: string, messageId: string): void
  latestRestore(runId: string): StoredRestoreOperation | undefined
  close(): void
}
