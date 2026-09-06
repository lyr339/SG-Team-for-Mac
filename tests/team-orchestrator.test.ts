import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryReviewCoordinator } from '../src/application/memory-review-coordinator'
import { TaskAgentService } from '../src/application/task-agent-service'
import { TaskDispatcher } from '../src/application/task-dispatcher'
import { TaskPoolService } from '../src/application/task-pool-service'
import { TeamControlService, type TeamControlBridge } from '../src/application/team-control-service'
import { TeamMemoryAgentService } from '../src/application/team-memory-agent-service'
import { TeamMemoryService } from '../src/application/team-memory-service'
import { TeamOrchestrator } from '../src/application/team-orchestrator'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { createDefaultTeamBundle } from '../src/domain/team-control'
import type { DesktopSnapshot, SendMessageAccepted, SendMessageInput } from '../src/shared/desktop-api'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'

class QuietBridge implements TeamControlBridge {
  private readonly listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  private readonly snapshot: DesktopSnapshot = {
    connection: { state: 'disconnected', endpoint: '', attempt: 0, lastError: '' },
    sessions: [],
    conversations: {},
    protocolIssues: [],
    updatedAt: 1
  }

  getSnapshot(): DesktopSnapshot { return structuredClone(this.snapshot) }
  sendMessage(_input: SendMessageInput): SendMessageAccepted { throw new Error('not used') }
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }
}

function fixture(started = true) {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-orchestrator-')), 'team.sqlite3')
  const controlRepository = new SqliteTeamControlRepository(path)
  const bundle = createDefaultTeamBundle({
    workspaceId: 'alpha',
    workspaceName: 'alpha',
    workspacePath: '/workspace/alpha',
    channelIds: ['1', '2', '3'],
    runKey: 'run-orchestrator',
    now: 100
  })
  controlRepository.upsertWorkspaceTeam(bundle)
  controlRepository.updateRunGoal(bundle.run.id, '实现、验证并交付自动团队闭环')
  controlRepository.recordInstallation({
    workspaceId: bundle.workspace.id,
    runId: bundle.run.id,
    generation: 'generation123',
    agents: bundle.slots.map((slot) => ({
      agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
      workspaceId: bundle.workspace.id,
      channelId: slot.channelId!,
      generation: 'generation123',
      runId: bundle.run.id,
      capabilities: bundle.roles.find((role) => role.id === slot.roleId)!.capabilities
    }))
  })
  if (started) {
    controlRepository.beginLaunch(bundle.run.id, 150, 'binding-key-123')
    for (const slot of bundle.slots) {
      const role = bundle.roles.find((candidate) => candidate.id === slot.roleId)!
      controlRepository.recordAgentCheckIn({
        agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
        runId: bundle.run.id,
        slotId: slot.id,
        capabilities: [...role.capabilities]
      }, 'ready')
    }
  }
  const tasksRepository = new SqliteTaskPoolRepository(path)
  const collaboration = new SqliteTeamCollaborationRepository(path)
  const memoryRepository = new SqliteTeamMemoryRepository(path)
  const team = new TeamControlService(controlRepository, new QuietBridge())
  const tasks = new TaskPoolService(tasksRepository, team)
  const memory = new TeamMemoryService(memoryRepository, team)
  const role = (key: string) => bundle.roles.find((candidate) => candidate.key === key)!
  const slot = (key: string) => bundle.slots.find((candidate) => candidate.roleId === role(key).id)!
  const identity = (key: string) => ({
    agentSessionId: `alpha:ch-${slot(key).channelId}:generation123`,
    runId: bundle.run.id,
    slotId: slot(key).id,
    capabilities: [...role(key).capabilities]
  })
  const taskAgent = (key: string) => new TaskAgentService(
    tasksRepository,
    identity(key),
    tasksRepository,
    controlRepository
  )
  const memoryAgent = (key: string) => new TeamMemoryAgentService(
    memoryRepository,
    collaboration,
    identity(key)
  )
  const close = () => {
    memory.dispose()
    team.dispose()
    memoryRepository.close()
    collaboration.close()
    tasksRepository.close()
    controlRepository.close()
  }
  return {
    bundle, controlRepository, tasksRepository, collaboration, memoryRepository,
    team, tasks, memory, role, slot, identity, taskAgent, memoryAgent, close
  }
}

describe('TeamOrchestrator', () => {
  it('does not dispatch stale tasks before the run is active', () => {
    const data = fixture(false)
    try {
      transactTaskPool(data.tasksRepository, (pool) => pool.plan(data.bundle.run.id, [{
        key: 'prelaunch-stale-task',
        title: '启动前旧任务',
        targetSlotId: data.slot('builder').id,
        requiredCapabilities: ['code']
      }]))
      const dispatcher = new TaskDispatcher(data.tasks, data.team, data.collaboration)
      dispatcher.reconcile()

      expect(data.team.getSnapshot().activeRun?.status).toBe('ready')
      expect(data.collaboration.loadRun(data.bundle.run.id).messageOrder).toEqual([])
    } finally {
      data.close()
    }
  })

  it('automatically dispatches tasks written by an external MCP process', async () => {
    const data = fixture()
    const dispatcher = new TaskDispatcher(data.tasks, data.team, data.collaboration)
    const externalRepository = new SqliteTaskPoolRepository(data.tasksRepository.path)
    try {
      dispatcher.start()
      data.tasks.startWatcher(25)
      const [task] = transactTaskPool(externalRepository, (pool) => pool.plan(data.bundle.run.id, [{
        key: 'external-process-task',
        title: '外部 MCP 新建任务',
        targetSlotId: data.slot('builder').id,
        requiredCapabilities: ['code']
      }]))
      await new Promise((resolve) => setTimeout(resolve, 350))

      const messages = data.collaboration.loadRun(data.bundle.run.id).messageOrder
        .map((id) => data.collaboration.loadRun(data.bundle.run.id).messages[id]!)
      expect(messages).toEqual([
        expect.objectContaining({
          recipient: { type: 'agent', slotId: data.slot('builder').id },
          content: expect.stringContaining(task!.id)
        })
      ])
    } finally {
      data.tasks.stopWatcher()
      dispatcher.stop()
      externalRepository.close()
      data.close()
    }
  })

  it('dispatches runnable work and routes submitted output to an independent QA lease', () => {
    const data = fixture()
    try {
      const [task] = transactTaskPool(data.tasksRepository, (pool) => pool.plan(data.bundle.run.id, [{
        key: 'implementation',
        title: '实现调度闭环',
        description: '交付可运行代码与测试',
        acceptance: '测试通过并由质量角色独立复核',
        targetSlotId: data.slot('builder').id,
        requiredCapabilities: ['code']
      }]))
      const dispatcher = new TaskDispatcher(data.tasks, data.team, data.collaboration)
      dispatcher.reconcile()
      dispatcher.reconcile()
      const initialMessages = data.collaboration.loadRun(data.bundle.run.id).messageOrder
        .map((id) => data.collaboration.loadRun(data.bundle.run.id).messages[id]!)
      expect(initialMessages).toHaveLength(1)
      expect(initialMessages[0]).toMatchObject({
        recipient: { type: 'agent', slotId: data.slot('builder').id },
        kind: 'directive'
      })
      expect(initialMessages[0]!.content).toContain(task!.id)

      const builder = data.taskAgent('builder')
      builder.claim(task!.id)
      builder.start(task!.id)
      builder.report(task!.id, 90, '实现与单测完成')
      builder.submit(task!.id, '构建成功，单元测试通过')
      dispatcher.reconcile()

      const messages = data.collaboration.loadRun(data.bundle.run.id).messageOrder
        .map((id) => data.collaboration.loadRun(data.bundle.run.id).messages[id]!)
      expect(messages).toHaveLength(2)
      expect(messages[1]).toMatchObject({
        recipient: { type: 'agent', slotId: data.slot('reviewer').id },
        kind: 'directive'
      })
      expect(messages[1]!.content).toContain("team_review({action:'claim'})")

      const reviewer = data.taskAgent('reviewer')
      expect(reviewer.listReviews()).toHaveLength(1)
      reviewer.claimReview(task!.id)
      const completed = reviewer.submitReview(task!.id, 'accept', '复跑构建与边界测试均通过')
      expect(completed.status).toBe('done')
      const state = data.tasksRepository.load()
      expect(state.reviews[state.tasks[task!.id]!.currentReviewId!]).toMatchObject({
        status: 'approved',
        reviewedBy: data.identity('reviewer').agentSessionId
      })
    } finally {
      data.close()
    }
  })

  it('creates a new QA notification after an expired review lease is requeued', () => {
    const data = fixture()
    try {
      const [task] = transactTaskPool(data.tasksRepository, (pool) => pool.plan(data.bundle.run.id, [{
        key: 'review-retry',
        title: '验收重新分配',
        targetSlotId: data.slot('builder').id,
        requiredCapabilities: ['code']
      }]))
      const builder = data.taskAgent('builder')
      builder.claim(task!.id)
      builder.start(task!.id)
      builder.submit(task!.id, '等待验收的产物')
      const dispatcher = new TaskDispatcher(data.tasks, data.team, data.collaboration)
      dispatcher.reconcile()
      const reviewer = data.taskAgent('reviewer')
      reviewer.claimReview(task!.id)

      const before = data.tasksRepository.load()
      const expired = structuredClone(before)
      const review = expired.reviews[expired.tasks[task!.id]!.currentReviewId!]!
      review.leaseExpiresAt = Date.now() - 1
      expired.revision += 1
      expect(data.tasksRepository.compareAndSwap(before.revision, expired)).toBe(true)
      data.tasks.sweepExpiredLeases()
      dispatcher.reconcile()

      const snapshot = data.collaboration.loadRun(data.bundle.run.id)
      const reviewMessages = snapshot.messageOrder
        .map((id) => snapshot.messages[id]!)
        .filter((message) => message.clientMessageId.includes(':review:'))
      expect(reviewMessages).toHaveLength(2)
      expect(reviewMessages.map((message) => message.clientMessageId)).toEqual([
        expect.stringContaining(':0'),
        expect.stringContaining(':1')
      ])
      expect(reviewer.claimReview(task!.id)?.review.leaseCount).toBe(2)
    } finally {
      data.close()
    }
  })

  it('routes every run-scoped context proposal to an independent reviewer', () => {
    const data = fixture()
    try {
      const [sourceTask] = transactTaskPool(data.tasksRepository, (pool) => pool.plan(data.bundle.run.id, [{
        key: 'memory-source', title: '记忆来源'
      }]))
      const coordinator = new MemoryReviewCoordinator(data.memory, data.team, data.collaboration)
      const builderProposal = data.memoryAgent('builder').propose({
        scope: 'run',
        kind: 'decision',
        title: '运行期决策',
        content: '运行期决策交给主控独立确认。',
        sources: [{ type: 'task', ref: sourceTask!.id, label: '来源任务' }],
        clientProposalId: 'builder-memory-auto-review-01'
      })
      const leadProposal = data.memoryAgent('lead').propose({
        scope: 'run',
        kind: 'constraint',
        title: '本轮关键约束',
        content: '本轮约束交给质量角色确认。',
        sources: [{ type: 'task', ref: sourceTask!.id, label: '来源任务' }],
        clientProposalId: 'lead-memory-auto-review-01'
      })
      const reviewerProposal = data.memoryAgent('reviewer').propose({
        scope: 'run',
        kind: 'risk',
        title: '质量角色提出的本轮风险',
        content: '质量角色不能自审，因此交给主控确认。',
        sources: [{ type: 'task', ref: sourceTask!.id, label: '来源任务' }],
        clientProposalId: 'reviewer-memory-escalation-01'
      })
      coordinator.reconcile()
      coordinator.reconcile()

      const snapshot = data.collaboration.loadRun(data.bundle.run.id)
      const messages = snapshot.messageOrder.map((id) => snapshot.messages[id]!)
      expect(messages).toHaveLength(3)
      expect(messages.find((message) => message.content.includes(builderProposal.id))).toMatchObject({
        recipient: { type: 'agent', slotId: data.slot('lead').id }
      })
      expect(messages.find((message) => message.content.includes(leadProposal.id))).toMatchObject({
        recipient: { type: 'agent', slotId: data.slot('reviewer').id }
      })
      expect(messages.find((message) => message.content.includes(reviewerProposal.id))).toMatchObject({
        recipient: { type: 'agent', slotId: data.slot('lead').id }
      })
    } finally {
      data.close()
    }
  })

  it('escalates a memory proposal only after its automatic review times out', () => {
    const data = fixture()
    try {
      const [sourceTask] = transactTaskPool(data.tasksRepository, (pool) => pool.plan(data.bundle.run.id, [{
        key: 'timeout-source', title: '超时来源'
      }]))
      const proposal = data.memoryAgent('builder').propose({
        scope: 'run',
        kind: 'risk',
        title: '自动审核超时风险',
        content: '先交给主控，超过时限后才升级给用户。',
        sources: [{ type: 'task', ref: sourceTask!.id, label: '来源任务' }],
        clientProposalId: 'memory-timeout-escalation-01'
      })
      const coordinator = new MemoryReviewCoordinator(
        data.memory,
        data.team,
        data.collaboration,
        () => undefined,
        () => proposal.createdAt + 30 * 60 * 1_000 + 1
      )
      coordinator.reconcile()
      const snapshot = data.collaboration.loadRun(data.bundle.run.id)
      const messages = snapshot.messageOrder.map((id) => snapshot.messages[id]!)
      expect(messages).toHaveLength(2)
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ recipient: { type: 'agent', slotId: data.slot('lead').id } }),
        expect.objectContaining({ recipient: { type: 'operator' } })
      ]))
    } finally {
      data.close()
    }
  })

  it('does not nudge the lead to plan automatically after check-in to an empty run', () => {
    const data = fixture()
    try {
      expect(data.team.getSnapshot().activeRun?.status).toBe('running')
      const taskDispatcher = new TaskDispatcher(data.tasks, data.team, data.collaboration)
      const memoryCoordinator = new MemoryReviewCoordinator(data.memory, data.team, data.collaboration)
      const orchestrator = new TeamOrchestrator(
        data.team,
        data.tasks,
        data.collaboration,
        taskDispatcher,
        memoryCoordinator
      )
      orchestrator.reconcile()
      orchestrator.reconcile()

      const snapshot = data.collaboration.loadRun(data.bundle.run.id)
      expect(snapshot.messageOrder).toHaveLength(0)
    } finally {
      data.close()
    }
  })
})
