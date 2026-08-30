import { transactTaskPool, type TaskPoolRepository } from './task-pool-transaction'
import {
  type PlanTaskInput,
  TaskPoolError,
  type TaskAttempt,
  type TaskReview,
  type TaskReviewDecision,
  type TeamTask
} from '../domain/task-pool'
import type { AgentAuthorizer, AgentAuthorizationIdentity } from './agent-authorization'
import type { AgentCheckInReceipt, AgentPresenceStore } from './agent-presence'

export interface AgentIdentity extends AgentAuthorizationIdentity {}

export interface AgentAssignment {
  task: TeamTask
  attemptId: string
  attemptNumber: number
  status: TaskAttempt['status']
  leaseExpiresAt: number
}

export interface AgentTaskView {
  task: TeamTask
  attempt?: Omit<TaskAttempt, 'leaseToken'>
}

export interface AgentReviewView {
  task: TeamTask
  attempt: Omit<TaskAttempt, 'leaseToken'>
  review: Omit<TaskReview, 'leaseToken'>
}

export interface AgentReviewAssignment extends AgentReviewView {
  leaseExpiresAt: number
}

function sanitizedAttempt(attempt: TaskAttempt): Omit<TaskAttempt, 'leaseToken'> {
  const { leaseToken: _leaseToken, ...safe } = attempt
  return safe
}

function sanitizedReview(review: TaskReview): Omit<TaskReview, 'leaseToken'> {
  const { leaseToken: _leaseToken, ...safe } = review
  return safe
}

export class TaskAgentService {
  readonly identity: AgentIdentity

  constructor(
    private readonly repository: TaskPoolRepository,
    identity: AgentIdentity,
    private readonly authorizer: AgentAuthorizer,
    private readonly presenceStore?: AgentPresenceStore
  ) {
    const agentSessionId = identity.agentSessionId.trim()
    const runId = identity.runId.trim()
    if (!/^[a-zA-Z0-9:_-]{3,200}$/.test(agentSessionId)) {
      throw new Error('Agent 会话标识（agentSessionId）无效')
    }
    if (!/^[a-zA-Z0-9:_-]{3,200}$/.test(runId)) {
      throw new Error('TeamRun 标识（runId）无效')
    }
    this.identity = {
      agentSessionId,
      runId,
      slotId: identity.slotId?.trim(),
      capabilities: [...new Set(identity.capabilities.map((item) => item.trim()).filter(Boolean))]
    }
    if (this.identity.slotId !== undefined && !/^[a-zA-Z0-9:_-]{3,240}$/.test(this.identity.slotId)) {
      throw new Error('Agent 槽位标识（slotId）无效')
    }
  }

  checkIn(note = ''): AgentCheckInReceipt {
    this.ensureAuthorized()
    if (!this.presenceStore) {
      throw new TaskPoolError('presence_store_unavailable', '当前 MCP 尚未接入外置 Team Presence Store')
    }
    return this.presenceStore.recordAgentCheckIn(this.identity, note)
  }

  listAvailable(): TeamTask[] {
    this.ensureAuthorized()
    const state = this.repository.load()
    const capabilities = new Set(this.identity.capabilities)
    return state.taskOrder
      .map((id) => state.tasks[id])
      .filter((task): task is TeamTask => Boolean(task))
      .filter((task) => task.runId === this.identity.runId && task.status === 'queued')
      .filter((task) => task.dependsOn.every((id) => state.tasks[id]?.status === 'done'))
      .filter((task) => task.requiredCapabilities.every((capability) => capabilities.has(capability)))
      .filter((task) => !task.targetSlotId || task.targetSlotId === this.identity.slotId)
      .sort((left, right) => left.priority - right.priority || left.createdAt - right.createdAt)
      .map((task) => structuredClone(task))
  }

  listMine(): AgentTaskView[] {
    this.ensureAuthorized()
    const state = this.repository.load()
    return state.taskOrder
      .map((id) => state.tasks[id])
      .filter((task): task is TeamTask => Boolean(task))
      .filter((task) => task.runId === this.identity.runId && task.assigneeSessionId === this.identity.agentSessionId)
      .map((task) => ({
        task: structuredClone(task),
        attempt: task.currentAttemptId && state.attempts[task.currentAttemptId]
          ? sanitizedAttempt(structuredClone(state.attempts[task.currentAttemptId]!))
          : undefined
      }))
  }

  canReviewTasks(): boolean {
    return this.identity.capabilities.includes('qa')
  }

  listReviews(): AgentReviewView[] {
    this.ensureReviewer()
    const state = this.repository.load()
    return state.reviewOrder
      .map((id) => state.reviews[id])
      .filter((review): review is TaskReview => Boolean(review))
      .filter((review) => ['queued', 'leased'].includes(review.status))
      .filter((review) => !review.reviewerSessionId || review.reviewerSessionId === this.identity.agentSessionId)
      .map((review) => {
        const task = state.tasks[review.taskId]
        const attempt = state.attempts[review.attemptId]
        if (!task || !attempt || task.runId !== this.identity.runId) return undefined
        if (attempt.agentSessionId === this.identity.agentSessionId) return undefined
        return {
          task: structuredClone(task),
          attempt: sanitizedAttempt(structuredClone(attempt)),
          review: sanitizedReview(structuredClone(review))
        }
      })
      .filter((view): view is AgentReviewView => Boolean(view))
  }

  claim(taskId?: string): AgentAssignment | null {
    this.ensureAuthorized()
    const existing = this.currentOwnedAttempt(taskId, ['leased', 'running'])
    if (existing?.leaseExpiresAt) {
      return {
        task: this.repository.load().tasks[existing.taskId]!,
        attemptId: existing.id,
        attemptNumber: existing.number,
        status: existing.status,
        leaseExpiresAt: existing.leaseExpiresAt
      }
    }
    const leased = transactTaskPool(this.repository, (pool) =>
      taskId?.trim()
        ? pool.leaseTask(taskId.trim(), this.identity)
        : pool.leaseNext(this.identity)
    )
    if (!leased) return null
    return {
      task: leased.task,
      attemptId: leased.attempt.id,
      attemptNumber: leased.attempt.number,
      status: leased.attempt.status,
      leaseExpiresAt: leased.leaseExpiresAt
    }
  }

  start(taskId?: string): AgentTaskView {
    this.ensureAuthorized()
    const running = this.currentOwnedAttempt(taskId, ['running'])
    if (running) {
      const state = this.repository.load()
      return { task: structuredClone(state.tasks[running.taskId]!), attempt: sanitizedAttempt(running) }
    }
    return transactTaskPool(this.repository, (pool) => {
      const active = this.ownedActiveAttempt(pool.snapshot(), taskId, ['leased'])
      const attempt = pool.startAttempt(active.id, active.leaseToken!)
      return { task: pool.snapshot().tasks[attempt.taskId]!, attempt: sanitizedAttempt(attempt) }
    })
  }

  renew(taskId?: string, ttlMs?: number): number {
    this.ensureAuthorized()
    return transactTaskPool(this.repository, (pool) => {
      const active = this.ownedActiveAttempt(pool.snapshot(), taskId, ['leased', 'running'])
      return pool.renewLease(active.id, active.leaseToken!, ttlMs)
    })
  }

  report(taskId: string | undefined, progress: number, summary = ''): AgentTaskView {
    this.ensureAuthorized()
    return transactTaskPool(this.repository, (pool) => {
      const active = this.ownedActiveAttempt(pool.snapshot(), taskId, ['running'])
      const attempt = pool.reportProgress(active.id, active.leaseToken!, progress, summary)
      return { task: pool.snapshot().tasks[attempt.taskId]!, attempt: sanitizedAttempt(attempt) }
    })
  }

  submit(taskId: string | undefined, output: string): AgentTaskView {
    this.ensureAuthorized()
    const review = this.currentOwnedAttempt(taskId, ['review'])
    if (review) {
      const state = this.repository.load()
      return { task: structuredClone(state.tasks[review.taskId]!), attempt: sanitizedAttempt(review) }
    }
    return transactTaskPool(this.repository, (pool) => {
      const active = this.ownedActiveAttempt(pool.snapshot(), taskId, ['running'])
      const attempt = pool.submitForReview(active.id, active.leaseToken!, output)
      return { task: pool.snapshot().tasks[attempt.taskId]!, attempt: sanitizedAttempt(attempt) }
    })
  }

  fail(taskId: string | undefined, reason: string): TeamTask {
    this.ensureAuthorized()
    return transactTaskPool(this.repository, (pool) => {
      const active = this.ownedActiveAttempt(pool.snapshot(), taskId, ['leased', 'running'])
      return pool.failAttempt(active.id, active.leaseToken!, reason)
    })
  }

  claimReview(taskId?: string): AgentReviewAssignment | null {
    this.ensureReviewer()
    const existing = this.currentOwnedReview(taskId)
    if (existing?.leaseExpiresAt) {
      const state = this.repository.load()
      const task = state.tasks[existing.taskId]
      const attempt = state.attempts[existing.attemptId]
      if (!task || !attempt) throw new TaskPoolError('review_record_missing', '验收记录不完整')
      return {
        task: structuredClone(task),
        attempt: sanitizedAttempt(structuredClone(attempt)),
        review: sanitizedReview(structuredClone(existing)),
        leaseExpiresAt: existing.leaseExpiresAt
      }
    }
    const leased = transactTaskPool(this.repository, (pool) => pool.leaseReview({
      runId: this.identity.runId,
      agentSessionId: this.identity.agentSessionId,
      slotId: this.identity.slotId!,
      taskId
    }))
    if (!leased) return null
    return {
      task: leased.task,
      attempt: sanitizedAttempt(leased.attempt),
      review: sanitizedReview(leased.review),
      leaseExpiresAt: leased.leaseExpiresAt
    }
  }

  renewReview(taskId?: string, ttlMs?: number): number {
    this.ensureReviewer()
    return transactTaskPool(this.repository, (pool) => {
      const review = this.ownedActiveReview(pool.snapshot(), taskId)
      return pool.renewReview(review.id, review.leaseToken!, ttlMs)
    })
  }

  submitReview(
    taskId: string | undefined,
    decision: TaskReviewDecision,
    evidence: string,
    reason = ''
  ): TeamTask {
    this.ensureReviewer()
    const completed = this.currentCompletedReview(taskId)
    if (completed) {
      const normalizedEvidence = evidence.trim()
      const normalizedReason = reason.trim()
      if (completed.decision !== decision
        || completed.evidence !== normalizedEvidence
        || (completed.reason ?? '') !== normalizedReason) {
        throw new TaskPoolError('review_already_completed', '验收已经提交，不能用不同结论覆盖')
      }
      const task = this.repository.load().tasks[completed.taskId]
      if (!task) throw new TaskPoolError('task_not_found', '验收对应任务不存在')
      return structuredClone(task)
    }
    return transactTaskPool(this.repository, (pool) => {
      const review = this.ownedActiveReview(pool.snapshot(), taskId)
      return pool.submitReview(review.id, review.leaseToken!, decision, evidence, reason)
    })
  }

  getTask(taskId: string): AgentTaskView {
    this.ensureAuthorized()
    const state = this.repository.load()
    const task = state.tasks[taskId]
    if (!task || task.runId !== this.identity.runId) throw new TaskPoolError('task_not_found', '任务不存在')
    const attempt = task.currentAttemptId ? state.attempts[task.currentAttemptId] : undefined
    return {
      task: structuredClone(task),
      attempt: attempt ? sanitizedAttempt(structuredClone(attempt)) : undefined
    }
  }

  listBoard(): AgentTaskView[] {
    this.ensureCoordinator()
    const state = this.repository.load()
    return state.taskOrder
      .map((id) => state.tasks[id])
      .filter((task): task is TeamTask => Boolean(task && task.runId === this.identity.runId))
      .map((task) => ({
        task: structuredClone(task),
        attempt: task.currentAttemptId && state.attempts[task.currentAttemptId]
          ? sanitizedAttempt(structuredClone(state.attempts[task.currentAttemptId]!))
          : undefined
      }))
  }

  plan(inputs: PlanTaskInput[]): TeamTask[] {
    this.ensureCoordinator()
    if (!inputs.length || inputs.length > 30) {
      throw new TaskPoolError('invalid_plan_size', '一次必须规划 1 到 30 条任务')
    }
    return transactTaskPool(this.repository, (pool) => pool.plan(this.identity.runId, inputs))
  }

  recoverLeadWork(fromAgentSessionId: string, targetSlotId: string): string[] {
    this.ensureCoordinator()
    return transactTaskPool(this.repository, (pool) => pool.recoverAgentWork({
      fromAgentSessionId,
      toAgentSessionId: this.identity.agentSessionId,
      targetSlotId
    }))
  }

  private ownedActiveAttempt(
    state: ReturnType<TaskPoolRepository['load']>,
    taskId: string | undefined,
    allowedStatuses: TaskAttempt['status'][]
  ): TaskAttempt {
    const normalizedTaskId = taskId?.trim()
    const matches = Object.values(state.attempts)
      .filter((attempt) => attempt.agentSessionId === this.identity.agentSessionId)
      .filter((attempt) => allowedStatuses.includes(attempt.status))
      .filter((attempt) => !normalizedTaskId || attempt.taskId === normalizedTaskId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const attempt = matches[0]
    if (!attempt) throw new TaskPoolError('active_attempt_not_found', '当前 Agent 没有匹配的活动任务')
    if (!attempt.leaseToken) throw new TaskPoolError('lease_token_missing', '活动任务缺少 Lease token')
    return attempt
  }

  private ensureAuthorized(): void {
    this.authorizer.assertAgentAuthorized(this.identity)
  }

  private ensureCoordinator(): void {
    this.ensureAuthorized()
    const capabilities = new Set(this.identity.capabilities)
    if (!capabilities.has('coordination') || !capabilities.has('planning')) {
      throw new TaskPoolError('coordinator_only', '只有主控协调 Agent 可以规划或查看全局任务板')
    }
  }

  private ensureReviewer(): void {
    this.ensureAuthorized()
    if (!this.identity.slotId || !this.canReviewTasks()) {
      throw new TaskPoolError('reviewer_only', '只有质量验证 Agent 可以领取并提交独立验收')
    }
  }

  private currentOwnedAttempt(
    taskId: string | undefined,
    allowedStatuses: TaskAttempt['status'][]
  ): TaskAttempt | undefined {
    const state = this.repository.load()
    const normalizedTaskId = taskId?.trim()
    return Object.values(state.attempts)
      .filter((attempt) => attempt.agentSessionId === this.identity.agentSessionId)
      .filter((attempt) => allowedStatuses.includes(attempt.status))
      .filter((attempt) => !normalizedTaskId || attempt.taskId === normalizedTaskId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
  }

  private currentOwnedReview(taskId?: string): TaskReview | undefined {
    const state = this.repository.load()
    const normalizedTaskId = taskId?.trim()
    return Object.values(state.reviews)
      .filter((review) => review.reviewerSessionId === this.identity.agentSessionId && review.status === 'leased')
      .filter((review) => !normalizedTaskId || review.taskId === normalizedTaskId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
  }

  private currentCompletedReview(taskId?: string): TaskReview | undefined {
    const state = this.repository.load()
    const normalizedTaskId = taskId?.trim()
    return Object.values(state.reviews)
      .filter((review) => review.reviewedBy === this.identity.agentSessionId)
      .filter((review) => review.status === 'approved' || review.status === 'rejected')
      .filter((review) => !normalizedTaskId || review.taskId === normalizedTaskId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
  }

  private ownedActiveReview(
    state: ReturnType<TaskPoolRepository['load']>,
    taskId?: string
  ): TaskReview {
    const normalizedTaskId = taskId?.trim()
    const review = Object.values(state.reviews)
      .filter((candidate) => candidate.reviewerSessionId === this.identity.agentSessionId)
      .filter((candidate) => candidate.status === 'leased')
      .filter((candidate) => !normalizedTaskId || candidate.taskId === normalizedTaskId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (!review) throw new TaskPoolError('active_review_not_found', '当前 Agent 没有匹配的活动验收')
    if (!review.leaseToken) throw new TaskPoolError('review_lease_token_missing', '活动验收缺少 Lease token')
    return review
  }
}
