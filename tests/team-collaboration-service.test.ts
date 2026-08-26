import { describe, expect, it } from 'vitest'
import { TeamCollaborationService, type TeamCollaborationTeamSource } from '../src/application/team-collaboration-service'
import type { TeamCollaborationRepository } from '../src/application/team-collaboration-repository'
import { emptyTeamCollaborationSnapshot, type TeamCollaborationSnapshot, type TeamMessage } from '../src/domain/team-collaboration'
import { emptyTeamControlSnapshot, type TeamControlSnapshot, type TeamRun } from '../src/domain/team-control'

class FakeTeamSource implements TeamCollaborationTeamSource {
  constructor(private readonly snapshot: TeamControlSnapshot) {}
  getSnapshot(): TeamControlSnapshot { return structuredClone(this.snapshot) }
  subscribe(): () => void { return () => undefined }
}

class FakeCollaborationRepository implements TeamCollaborationRepository {
  loadRun(runId: string): TeamCollaborationSnapshot {
    return emptyTeamCollaborationSnapshot(runId)
  }
  revision(): number { return 0 }
  resolveAuthorizedAgent(): never { throw new Error('unused') }
  listRunMembers(): [] { return [] }
  clearRun(): boolean { return false }
  createMessage(): never { throw new Error('should not create messages before launch') }
  markNotificationSending(): never { throw new Error('unused') }
  markNotificationResult(): never { throw new Error('unused') }
  markRead(): never { throw new Error('unused') }
  acknowledge(): never { throw new Error('unused') }
  listPendingNotifications(): [] { return [] }
  recoverStaleSending(): number { return 0 }
  recordLiveness(): void {}
  getLiveness(): undefined { return undefined }
  listLiveness(): [] { return [] }
  close(): void {}
}

function snapshot(status: TeamRun['status']): TeamControlSnapshot {
  const base = emptyTeamControlSnapshot()
  return {
    ...base,
    activeWorkspaceId: 'workspace:alpha',
    workspaces: [{ id: 'workspace:alpha', name: 'alpha', path: '/workspace/alpha', createdAt: 1_000, updatedAt: 1_000 }],
    activeRun: {
      id: 'run:alpha',
      workspaceId: 'workspace:alpha',
      name: 'alpha',
      goal: 'goal',
      templateId: 'software-core-v1',
      status,
      createdAt: 1_000,
      updatedAt: 1_000
    },
    members: [{
      slot: { id: 'slot:builder', runId: 'run:alpha', roleId: 'role:builder', name: '实现席', avatarId: 'architect', channelId: '2', order: 0, createdAt: 1_000, updatedAt: 1_000 },
      role: { id: 'role:builder', runId: 'run:alpha', key: 'builder', templateKey: 'builder', name: '架构实现', mission: '', instructions: '', capabilities: ['code'], skills: [], accent: 'periwinkle', order: 0 },
      readiness: 'ready'
    }]
  }
}

describe('TeamCollaborationService', () => {
  it.each(['draft', 'ready'] as const)('rejects operator messages while the run is %s', (status) => {
    const service = new TeamCollaborationService(
      new FakeCollaborationRepository(),
      new FakeTeamSource(snapshot(status))
    )

    expect(() => service.send({
      recipientSlotId: 'slot:builder',
      kind: 'directive',
      content: 'before launch'
    })).toThrowError(/尚未启动/)
  })
})
