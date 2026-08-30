import { describe, expect, it } from 'vitest'
import { executionMember } from '../src/application/task-dispatcher'
import { selectTaskReviewMember } from '../src/domain/team-orchestration'
import type { TeamControlSnapshot, TeamMemberView } from '../src/domain/team-control'
import type { TaskPoolSnapshot, TaskReview, TeamTask } from '../src/domain/task-pool'

function member(id: string, capabilities: string[], solo = false): TeamMemberView {
  return {
    slot: { id, runId: 'run', roleId: `role-${id}`, name: id, avatarId: 'researcher', solo, order: 0, createdAt: 1, updatedAt: 1 },
    role: { id: `role-${id}`, runId: 'run', key: id, templateKey: solo ? 'solo' : 'builder', name: id, mission: '', instructions: '', capabilities, skills: [], accent: 'sky', order: 0 },
    binding: { id: `binding-${id}`, workspaceId: 'w', runId: 'run', slotId: id, channelId: id, agentSessionId: `session-${id}`, generation: 'g', installedAt: 1, launchStatus: 'acknowledged', launchDetail: '', lastCheckInNote: '', composerBindingKey: 'g' },
    runtime: { channelId: id, status: 'waiting', online: true, waiting: true, queueDepth: 0, lastSeenAt: 1, healthEvidence: [], workingFiles: [] },
    readiness: 'ready'
  }
}

function team(members: TeamMemberView[]): TeamControlSnapshot {
  return {
    schemaVersion: 7, revision: 1, workspaces: [], runs: [], roles: members.map((item) => item.role),
    slots: members.map((item) => item.slot), bindings: members.map((item) => item.binding!), updatedAt: 1,
    members, runtimeChannels: [], standbyChannels: [], failovers: [],
    preflight: { bridgeConnected: true, workspaceBound: true, goalDefined: true, mcpInstalled: true, agentsWaiting: true, canLaunch: true, blockers: [] }
  }
}

const pool = { taskOrder: [], tasks: {}, attempts: {} } as unknown as TaskPoolSnapshot

describe('solo routing isolation', () => {
  it('never selects a solo seat for team task execution even if it is the explicit target', () => {
    const solo = member('3', ['code'], true)
    const builder = member('2', ['code'])
    const task = { status: 'queued', dependsOn: [], targetSlotId: solo.slot.id, requiredCapabilities: ['code'] } as unknown as TeamTask
    expect(executionMember(task, team([solo, builder]), pool)).toBeUndefined()
    expect(executionMember({ ...task, targetSlotId: undefined }, team([solo, builder]), pool)?.slot.id).toBe('2')
  })

  it('never selects a solo seat for independent task review', () => {
    const solo = member('3', ['qa'], true)
    const reviewer = member('2', ['qa'])
    const review = { attemptId: 'attempt' } as TaskReview
    const reviewPool = { ...pool, attempts: { attempt: { agentSessionId: 'implementer' } } } as unknown as TaskPoolSnapshot
    expect(selectTaskReviewMember(review, team([solo, reviewer]), reviewPool)?.slot.id).toBe('2')
    expect(selectTaskReviewMember(review, team([solo]), reviewPool)).toBeUndefined()
  })
})
