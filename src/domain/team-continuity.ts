import type { TeamMessageActor, TeamMessageKind, TeamMessageReceiptStage } from './team-collaboration'
import type { TeamMemoryKind } from './team-memory'
import type { TaskStatus } from './task-pool'

export interface TeamCheckpointMember {
  slotId: string
  roleKey: string
  roleName: string
  channelId?: string
  workingFiles: string[]
}

export interface TeamCheckpointTask {
  id: string
  title: string
  status: TaskStatus
  targetSlotId?: string
  assigneeSessionId?: string
  progress: number
  summary?: string
}

export interface TeamCheckpointMessage {
  id: string
  sender: TeamMessageActor
  recipient: TeamMessageActor
  kind: TeamMessageKind
  content: string
  stage: TeamMessageReceiptStage
}

export interface TeamCheckpointMemory {
  id: string
  kind: TeamMemoryKind
  title: string
  content: string
  version: number
}

export interface TeamCheckpointCapsule {
  schemaVersion: 1
  goal: string
  runName: string
  runStatus: string
  members: TeamCheckpointMember[]
  activeTasks: TeamCheckpointTask[]
  pendingMessages: TeamCheckpointMessage[]
  sharedMemory: TeamCheckpointMemory[]
  capturedAt: number
}

export interface TeamCheckpoint {
  id: string
  workspaceId: string
  runId: string
  reason: 'automatic' | 'before_restore'
  digest: string
  capsule: TeamCheckpointCapsule
  createdAt: number
}

export type TeamRestoreMemberState =
  | 'queued'
  | 'notified'
  | 'read'
  | 'restored'
  | 'attention'

export interface TeamRestoreMember {
  slotId: string
  roleName: string
  messageId?: string
  state: TeamRestoreMemberState
  detail: string
}

export interface TeamRestoreOperation {
  id: string
  workspaceId: string
  runId: string
  checkpointId: string
  status: 'preparing' | 'waiting' | 'completed' | 'attention'
  members: TeamRestoreMember[]
  createdAt: number
  updatedAt: number
}

export interface TeamContinuitySnapshot {
  schemaVersion: 1
  revision: number
  workspaceId?: string
  runId?: string
  checkpoints: TeamCheckpoint[]
  activeRestore?: TeamRestoreOperation
  updatedAt: number
}

export interface TeamTakeoverCapsule {
  checkpointId: string
  taskIds: string[]
  content: string
}

export function emptyTeamContinuitySnapshot(
  workspaceId?: string,
  runId?: string
): TeamContinuitySnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    workspaceId,
    runId,
    checkpoints: [],
    updatedAt: Date.now()
  }
}
