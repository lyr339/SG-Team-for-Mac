import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamContinuityService } from '../src/application/team-continuity-service'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { emptyTaskPoolState, type TaskPoolState } from '../src/domain/task-pool'
import { createDefaultTeamBundle, type TeamControlSnapshot } from '../src/domain/team-control'
import { emptyTeamMemorySnapshot, type TeamMemorySnapshot } from '../src/domain/team-memory'
import type { TeamCollaborationSnapshot } from '../src/domain/team-collaboration'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamContinuityRepository } from '../src/infrastructure/team-continuity/sqlite-team-continuity-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'

class MutableSource<T> {
  private readonly listeners = new Set<(snapshot: T) => void>()
  constructor(private snapshot: T) {}
  getSnapshot(): T { return structuredClone(this.snapshot) }
  subscribe(listener: (snapshot: T) => void): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }
  set(snapshot: T): void {
    this.snapshot = structuredClone(snapshot)
    for (const listener of this.listeners) listener(this.getSnapshot())
  }
}

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-team-continuity-')), 'team.sqlite3')
  const teamRepository = new SqliteTeamControlRepository(path)
  const bundle = createDefaultTeamBundle({
    workspaceId: 'alpha',
    workspaceName: 'alpha',
    workspacePath: '/workspace/alpha',
    channelIds: ['1', '2'],
    now: 100
  })
  teamRepository.upsertWorkspaceTeam(bundle)
  teamRepository.updateRunGoal(bundle.run.id, '恢复团队并继续接口重构')
  teamRepository.recordInstallation({
    workspaceId: 'alpha',
    runId: bundle.run.id,
    generation: 'generation123',
    agents: bundle.slots.map((slot) => ({
      agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
      workspaceId: 'alpha',
      channelId: slot.channelId!,
      generation: 'generation123',
      runId: bundle.run.id,
      capabilities: bundle.roles.find((role) => role.id === slot.roleId)!.capabilities
    }))
  })
  const state = teamRepository.loadTeamControl()
  const activeRun = state.runs.find((run) => run.id === bundle.run.id)!
  const members = bundle.slots.map((slot) => ({
    slot,
    role: bundle.roles.find((role) => role.id === slot.roleId)!,
    binding: state.bindings.find((binding) => binding.slotId === slot.id),
    runtime: {
      channelId: slot.channelId!,
      status: 'waiting' as const,
      online: true,
      waiting: true,
      queueDepth: 0,
      healthEvidence: ['verified'],
      workingFiles: []
    },
    readiness: 'ready' as const
  }))
  const teamSnapshot: TeamControlSnapshot = {
    ...state,
    activeRun,
    members,
    runtimeChannels: [],
    standbyChannels: [],
    failovers: [],
    preflight: {
      bridgeConnected: true,
      workspaceBound: true,
      goalDefined: true,
      mcpInstalled: true,
      agentsWaiting: true,
      canLaunch: true,
      blockers: []
    }
  }
  const tasks = new SqliteTaskPoolRepository(path)
  const collaboration = new SqliteTeamCollaborationRepository(path)
  const continuity = new SqliteTeamContinuityRepository(path)
  const teamSource = new MutableSource(teamSnapshot)
  const taskSource = new MutableSource<TaskPoolState>(emptyTaskPoolState())
  const collaborationSource = new MutableSource<TeamCollaborationSnapshot>(
    collaboration.loadRun(bundle.run.id)
  )
  const memorySource = new MutableSource<TeamMemorySnapshot>(
    emptyTeamMemorySnapshot('alpha', bundle.run.id)
  )
  const service = new TeamContinuityService(continuity, collaboration, {
    team: teamSource,
    tasks: taskSource,
    collaboration: collaborationSource,
    memory: memorySource
  })
  return {
    path,
    teamRepository,
    tasks,
    collaboration,
    continuity,
    service,
    bundle,
    teamSource,
    taskSource,
    collaborationSource,
    memorySource
  }
}

describe('SG Team automatic continuity', () => {
  it('deduplicates automatic checkpoints and captures deterministic active work', () => {
    const data = fixture()
    try {
      const first = data.service.capture()!
      const duplicate = data.service.capture()!
      expect(duplicate.id).toBe(first.id)
      expect(data.service.getSnapshot().checkpoints).toHaveLength(1)

      const [task] = transactTaskPool(data.tasks, (pool) => pool.plan(data.bundle.run.id, [{
        key: 'api-layer',
        title: '重构接口层',
        targetSlotId: data.bundle.slots[1]!.id
      }]))
      data.taskSource.set(data.tasks.load())
      const second = data.service.capture()!
      expect(second.id).not.toBe(first.id)
      expect(second.capsule.activeTasks).toEqual([
        expect.objectContaining({ id: task!.id, targetSlotId: data.bundle.slots[1]!.id })
      ])
      expect(data.service.getSnapshot().checkpoints).toHaveLength(2)
    } finally {
      data.service.dispose()
      data.continuity.close()
      data.collaboration.close()
      data.tasks.close()
      data.teamRepository.close()
    }
  })

  it('queues one role-specific recovery capsule and completes only after every Agent explicitly responds', () => {
    const data = fixture()
    try {
      const [task] = transactTaskPool(data.tasks, (pool) => pool.plan(data.bundle.run.id, [{
        key: 'api-layer',
        title: '重构接口层',
        targetSlotId: data.bundle.slots[1]!.id,
        requiredCapabilities: ['code']
      }]))
      data.taskSource.set(data.tasks.load())
      const checkpoint = data.service.capture()!
      const restore = data.service.restore(checkpoint.id)

      expect(restore.members).toHaveLength(2)
      expect(restore.members.every((member) => member.state === 'queued')).toBe(true)
      const collaborationState = data.collaboration.loadRun(data.bundle.run.id)
      const restoreMessages = restore.members.map((member) => collaborationState.messages[member.messageId!]!)
      expect(restoreMessages.every((message) => message.content.includes('拾光恢复胶囊'))).toBe(true)
      expect(restoreMessages.find((message) => (
        message.recipient.type === 'agent'
        && message.recipient.slotId === data.bundle.slots[1]!.id
      ))?.content).toContain(task!.id)
      expect(restoreMessages.find((message) => (
        message.recipient.type === 'agent'
        && message.recipient.slotId === data.bundle.slots[0]!.id
      ))?.content).not.toContain(task!.id)

      for (const message of restoreMessages) {
        if (message.recipient.type !== 'agent') throw new Error('restore recipient must be agent')
        data.collaboration.markRead(message.id, message.recipient)
        data.collaboration.createMessage({
          runId: message.runId,
          sender: message.recipient,
          recipient: { type: 'operator' },
          kind: 'response',
          content: '已恢复，继续执行当前任务。',
          replyToMessageId: message.id,
          threadId: message.threadId,
          clientMessageId: `restore-response:${message.recipient.slotId}`
        })
      }
      data.collaborationSource.set(data.collaboration.loadRun(data.bundle.run.id))
      expect(data.service.getSnapshot().activeRestore).toMatchObject({
        status: 'completed',
        members: [
          expect.objectContaining({ state: 'restored' }),
          expect.objectContaining({ state: 'restored' })
        ]
      })
    } finally {
      data.service.dispose()
      data.continuity.close()
      data.collaboration.close()
      data.tasks.close()
      data.teamRepository.close()
    }
  })
})
