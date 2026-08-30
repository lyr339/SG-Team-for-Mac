export type TaskStatus =
  | 'queued'
  | 'leased'
  | 'running'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'

export type AttemptStatus = 'leased' | 'running' | 'review' | 'done' | 'failed' | 'cancelled'
export type TaskReviewStatus = 'queued' | 'leased' | 'approved' | 'rejected' | 'cancelled'
export type TaskReviewDecision = 'accept' | 'reject'

export interface TeamTask {
  id: string
  runId: string
  key: string
  title: string
  description: string
  acceptance: string
  priority: number
  status: TaskStatus
  dependsOn: string[]
  requiredCapabilities: string[]
  targetSlotId?: string
  maxAttempts: number
  attemptCount: number
  progress: number
  assigneeSessionId?: string
  currentAttemptId?: string
  currentReviewId?: string
  result?: string
  failureReason?: string
  createdAt: number
  updatedAt: number
}

export interface TaskReview {
  id: string
  taskId: string
  attemptId: string
  status: TaskReviewStatus
  reviewerSessionId?: string
  reviewerSlotId?: string
  reviewedBy?: string
  leaseCount: number
  leaseToken?: string
  leaseExpiresAt?: number
  decision?: TaskReviewDecision
  evidence: string
  reason?: string
  createdAt: number
  completedAt?: number
  updatedAt: number
}

export interface TaskAttempt {
  id: string
  taskId: string
  number: number
  agentSessionId: string
  status: AttemptStatus
  leaseToken?: string
  leaseExpiresAt?: number
  progress: number
  summary: string
  output?: string
  error?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  updatedAt: number
}

export interface TaskPoolEvent {
  seq: number
  type: string
  taskId: string
  attemptId?: string
  agentSessionId?: string
  detail?: string
  at: number
}

export interface TaskPoolState {
  schemaVersion: 3
  revision: number
  seq: number
  tasks: Record<string, TeamTask>
  taskOrder: string[]
  attempts: Record<string, TaskAttempt>
  reviews: Record<string, TaskReview>
  reviewOrder: string[]
  events: TaskPoolEvent[]
}

export interface TaskPoolSnapshot extends TaskPoolState {
  workspaceId?: string
  runId?: string
  scopeRevision: number
}

export interface PlanTaskInput {
  key: string
  title: string
  description?: string
  acceptance?: string
  priority?: number
  dependsOn?: string[]
  requiredCapabilities?: string[]
  targetSlotId?: string
  maxAttempts?: number
}

export interface LeaseNextInput {
  runId: string
  agentSessionId: string
  slotId?: string
  capabilities?: string[]
  ttlMs?: number
}

export interface LeaseResult {
  task: TeamTask
  attempt: TaskAttempt
  leaseToken: string
  leaseExpiresAt: number
}

export interface LeaseReviewInput {
  runId: string
  agentSessionId: string
  slotId: string
  taskId?: string
  ttlMs?: number
}

export interface ReviewLeaseResult {
  task: TeamTask
  attempt: TaskAttempt
  review: TaskReview
  leaseToken: string
  leaseExpiresAt: number
}

export interface TaskPoolDependencies {
  now?: () => number
  taskId?: () => string
  attemptId?: () => string
  leaseToken?: () => string
  reviewId?: () => string
  reviewLeaseToken?: () => string
}

const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1_000
const MIN_LEASE_TTL_MS = 5_000
const MAX_LEASE_TTL_MS = 10 * 60 * 1_000
const DEFAULT_MAX_ATTEMPTS = 3
const EVENT_CAP = 2_000

function runtimeUuid(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('当前运行环境缺少 crypto.randomUUID，请注入 ID factory')
  }
  return globalThis.crypto.randomUUID()
}

export class TaskPoolError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'TaskPoolError'
  }
}

export function emptyTaskPoolState(): TaskPoolState {
  return {
    schemaVersion: 3,
    revision: 0,
    seq: 0,
    tasks: {},
    taskOrder: [],
    attempts: {},
    reviews: {},
    reviewOrder: [],
    events: []
  }
}

export function emptyTaskPoolSnapshot(): TaskPoolSnapshot {
  return {
    ...emptyTaskPoolState(),
    scopeRevision: 0
  }
}

export function newestTaskPoolSnapshot(
  previous: TaskPoolSnapshot,
  incoming: TaskPoolSnapshot
): TaskPoolSnapshot {
  if (incoming.scopeRevision > previous.scopeRevision) return incoming
  if (incoming.scopeRevision < previous.scopeRevision) return previous
  if (incoming.workspaceId !== previous.workspaceId || incoming.runId !== previous.runId) return previous
  return incoming.revision >= previous.revision ? incoming : previous
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value as number) : fallback
  return Math.max(min, Math.min(max, normalized))
}

export class TaskPoolAggregate {
  private state: TaskPoolState
  private readonly now: () => number
  private readonly nextTaskId: () => string
  private readonly nextAttemptId: () => string
  private readonly nextLeaseToken: () => string
  private readonly nextReviewId: () => string
  private readonly nextReviewLeaseToken: () => string

  constructor(initialState: TaskPoolState = emptyTaskPoolState(), dependencies: TaskPoolDependencies = {}) {
    this.state = structuredClone(initialState)
    this.now = dependencies.now ?? Date.now
    this.nextTaskId = dependencies.taskId ?? (() => `task-${runtimeUuid()}`)
    this.nextAttemptId = dependencies.attemptId ?? (() => `attempt-${runtimeUuid()}`)
    this.nextLeaseToken = dependencies.leaseToken ?? runtimeUuid
    this.nextReviewId = dependencies.reviewId ?? (() => `review-${runtimeUuid()}`)
    this.nextReviewLeaseToken = dependencies.reviewLeaseToken ?? runtimeUuid
  }

  snapshot(): TaskPoolState {
    return structuredClone(this.state)
  }

  plan(runId: string, inputs: PlanTaskInput[]): TeamTask[] {
    const normalizedRunId = runId.trim()
    if (!normalizedRunId) throw new TaskPoolError('missing_run_id', 'runId 不能为空')
    if (!inputs.length) throw new TaskPoolError('empty_plan', '任务计划不能为空')

    const existingTasksForRun = Object.values(this.state.tasks).filter((task) => task.runId === normalizedRunId)
    const existingKeys = new Set(existingTasksForRun.map((task) => task.key))
    const batchKeys = new Set<string>()
    for (const input of inputs) {
      const key = input.key.trim()
      if (!key) throw new TaskPoolError('missing_task_key', '每条任务都必须有稳定 key')
      if (existingKeys.has(key) || batchKeys.has(key)) {
        throw new TaskPoolError('duplicate_task_key', `任务 key 重复：${key}`)
      }
      if (!input.title.trim()) throw new TaskPoolError('missing_task_title', `任务 ${key} 缺少标题`)
      batchKeys.add(key)
    }

    const idByKey = new Map<string, string>()
    for (const input of inputs) idByKey.set(input.key.trim(), this.nextTaskId())
    const existingIdByKey = new Map(existingTasksForRun.map((task) => [task.key, task.id]))
    const at = this.now()

    const planned = inputs.map((input): TeamTask => {
      const key = input.key.trim()
      const dependencies = uniqueStrings(input.dependsOn).map((dependency) => {
        const id = idByKey.get(dependency) ?? existingIdByKey.get(dependency)
        if (!id) throw new TaskPoolError('missing_dependency', `任务 ${key} 的依赖不存在：${dependency}`)
        return id
      })
      return {
        id: idByKey.get(key)!,
        runId: normalizedRunId,
        key,
        title: input.title.trim(),
        description: input.description?.trim() ?? '',
        acceptance: input.acceptance?.trim() ?? '',
        priority: boundedInteger(input.priority, 2, 0, 3),
        status: 'queued',
        dependsOn: dependencies,
        requiredCapabilities: uniqueStrings(input.requiredCapabilities),
        targetSlotId: input.targetSlotId?.trim() || undefined,
        maxAttempts: boundedInteger(input.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, 10),
        attemptCount: 0,
        progress: 0,
        createdAt: at,
        updatedAt: at
      }
    })

    const graph = new Map<string, string[]>([
      ...Object.values(this.state.tasks).map((task) => [task.id, task.dependsOn] as const),
      ...planned.map((task) => [task.id, task.dependsOn] as const)
    ])
    const cycle = findDependencyCycle(graph)
    if (cycle.length) {
      throw new TaskPoolError('dependency_cycle', `任务依赖成环：${cycle.join(' → ')}`)
    }

    for (const task of planned) {
      this.state.tasks[task.id] = task
      this.state.taskOrder.push(task.id)
      this.note('task.planned', task.id)
    }
    this.bumpRevision()
    return structuredClone(planned)
  }

  leaseNext(input: LeaseNextInput): LeaseResult | null {
    const runId = input.runId.trim()
    const agentSessionId = input.agentSessionId.trim()
    if (!runId) throw new TaskPoolError('missing_run_id', 'runId 不能为空')
    if (!agentSessionId) throw new TaskPoolError('missing_agent_session', 'agentSessionId 不能为空')
    this.reclaimExpired()
    if (this.hasActiveAttempt(agentSessionId)) {
      throw new TaskPoolError('agent_busy', '这个 AgentSession 已经持有一条执行中的任务')
    }

    const capabilities = new Set(uniqueStrings(input.capabilities))
    const task = this.state.taskOrder
      .map((id) => this.state.tasks[id])
      .filter((candidate): candidate is TeamTask => Boolean(candidate))
      .filter((candidate) => candidate.runId === runId)
      .filter((candidate) => candidate.status === 'queued')
      .filter((candidate) => candidate.dependsOn.every((id) => this.state.tasks[id]?.status === 'done'))
      .filter((candidate) => candidate.requiredCapabilities.every((item) => capabilities.has(item)))
      .filter((candidate) => !candidate.targetSlotId || candidate.targetSlotId === input.slotId)
      .sort((left, right) => left.priority - right.priority || left.createdAt - right.createdAt)[0]
    if (!task) return null

    return this.createLease(task, agentSessionId, input.ttlMs)
  }

  leaseTask(taskId: string, input: LeaseNextInput): LeaseResult {
    const runId = input.runId.trim()
    const agentSessionId = input.agentSessionId.trim()
    if (!runId) throw new TaskPoolError('missing_run_id', 'runId 不能为空')
    if (!agentSessionId) throw new TaskPoolError('missing_agent_session', 'agentSessionId 不能为空')
    this.reclaimExpired()
    if (this.hasActiveAttempt(agentSessionId)) {
      throw new TaskPoolError('agent_busy', '这个 AgentSession 已经持有一条执行中的任务')
    }
    const task = this.taskOf(taskId)
    if (task.runId !== runId) throw new TaskPoolError('task_run_mismatch', '任务不属于当前 run')
    if (task.status !== 'queued') throw new TaskPoolError('task_not_queued', '任务当前不可领取')
    if (!task.dependsOn.every((id) => this.state.tasks[id]?.status === 'done')) {
      throw new TaskPoolError('dependencies_not_done', '任务的前置依赖尚未完成')
    }
    const capabilities = new Set(uniqueStrings(input.capabilities))
    const missing = task.requiredCapabilities.filter((item) => !capabilities.has(item))
    if (missing.length) throw new TaskPoolError('capability_mismatch', `Agent 缺少能力：${missing.join('、')}`)
    if (task.targetSlotId && task.targetSlotId !== input.slotId) {
      throw new TaskPoolError('task_reserved_for_other_slot', '任务已指定给其他 AgentSlot')
    }
    return this.createLease(task, agentSessionId, input.ttlMs)
  }

  private createLease(task: TeamTask, agentSessionId: string, ttlValue?: number): LeaseResult {

    const at = this.now()
    const ttlMs = boundedInteger(ttlValue, DEFAULT_LEASE_TTL_MS, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS)
    const leaseToken = this.nextLeaseToken()
    const leaseExpiresAt = at + ttlMs
    const attempt: TaskAttempt = {
      id: this.nextAttemptId(),
      taskId: task.id,
      number: task.attemptCount + 1,
      agentSessionId,
      status: 'leased',
      leaseToken,
      leaseExpiresAt,
      progress: 0,
      summary: '',
      createdAt: at,
      updatedAt: at
    }
    this.state.attempts[attempt.id] = attempt
    task.status = 'leased'
    task.attemptCount = attempt.number
    task.assigneeSessionId = agentSessionId
    task.currentAttemptId = attempt.id
    task.failureReason = undefined
    task.updatedAt = at
    this.note('task.leased', task.id, attempt.id, agentSessionId)
    this.bumpRevision()
    return {
      task: structuredClone(task),
      attempt: structuredClone(attempt),
      leaseToken,
      leaseExpiresAt
    }
  }

  startAttempt(attemptId: string, leaseToken: string): TaskAttempt {
    const { task, attempt } = this.activeLease(attemptId, leaseToken)
    if (attempt.status !== 'leased') throw new TaskPoolError('invalid_attempt_state', '只有 leased attempt 可以开始')
    const at = this.now()
    attempt.status = 'running'
    attempt.startedAt = at
    attempt.updatedAt = at
    task.status = 'running'
    task.updatedAt = at
    this.note('task.started', task.id, attempt.id, attempt.agentSessionId)
    this.bumpRevision()
    return structuredClone(attempt)
  }

  renewLease(attemptId: string, leaseToken: string, ttlMs = DEFAULT_LEASE_TTL_MS): number {
    const { task, attempt } = this.activeLease(attemptId, leaseToken)
    const at = this.now()
    attempt.leaseExpiresAt = at + boundedInteger(ttlMs, DEFAULT_LEASE_TTL_MS, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS)
    attempt.updatedAt = at
    task.updatedAt = at
    this.note('lease.renewed', task.id, attempt.id, attempt.agentSessionId)
    this.bumpRevision()
    return attempt.leaseExpiresAt
  }

  reportProgress(attemptId: string, leaseToken: string, progress: number, summary = ''): TaskAttempt {
    const { task, attempt } = this.activeLease(attemptId, leaseToken)
    if (attempt.status !== 'running') throw new TaskPoolError('invalid_attempt_state', '只有 running attempt 可以汇报进度')
    const at = this.now()
    const normalizedProgress = boundedInteger(progress, attempt.progress, 0, 99)
    attempt.progress = Math.max(attempt.progress, normalizedProgress)
    attempt.summary = summary.trim()
    attempt.updatedAt = at
    task.progress = attempt.progress
    task.updatedAt = at
    this.note('task.progress', task.id, attempt.id, attempt.agentSessionId, attempt.summary)
    this.bumpRevision()
    return structuredClone(attempt)
  }

  submitForReview(attemptId: string, leaseToken: string, output: string): TaskAttempt {
    const { task, attempt } = this.activeLease(attemptId, leaseToken)
    if (attempt.status !== 'running') throw new TaskPoolError('invalid_attempt_state', '只有 running attempt 可以提交验收')
    const normalizedOutput = output.trim()
    if (!normalizedOutput) throw new TaskPoolError('missing_output', '提交验收必须包含交付结果')
    const at = this.now()
    attempt.status = 'review'
    attempt.progress = 100
    attempt.output = normalizedOutput
    attempt.leaseToken = undefined
    attempt.leaseExpiresAt = undefined
    attempt.updatedAt = at
    task.status = 'review'
    task.progress = 100
    const review: TaskReview = {
      id: this.nextReviewId(),
      taskId: task.id,
      attemptId: attempt.id,
      status: 'queued',
      leaseCount: 0,
      evidence: '',
      createdAt: at,
      updatedAt: at
    }
    this.state.reviews[review.id] = review
    this.state.reviewOrder.push(review.id)
    task.currentReviewId = review.id
    task.updatedAt = at
    this.note('task.submitted', task.id, attempt.id, attempt.agentSessionId)
    this.note('review.queued', task.id, attempt.id)
    this.bumpRevision()
    return structuredClone(attempt)
  }

  leaseReview(input: LeaseReviewInput): ReviewLeaseResult | null {
    const runId = input.runId.trim()
    const agentSessionId = input.agentSessionId.trim()
    const slotId = input.slotId.trim()
    if (!runId) throw new TaskPoolError('missing_run_id', 'runId 不能为空')
    if (!agentSessionId) throw new TaskPoolError('missing_agent_session', 'agentSessionId 不能为空')
    if (!slotId) throw new TaskPoolError('missing_reviewer_slot', 'reviewer slotId 不能为空')
    this.reclaimExpired()
    if (this.hasActiveReview(agentSessionId)) {
      throw new TaskPoolError('reviewer_busy', '这个 AgentSession 已经持有一条验收任务')
    }

    const task = input.taskId?.trim()
      ? this.taskOf(input.taskId.trim())
      : this.state.taskOrder
        .map((id) => this.state.tasks[id])
        .filter((candidate): candidate is TeamTask => Boolean(candidate))
        .filter((candidate) => candidate.runId === runId && candidate.status === 'review')
        .filter((candidate) => {
          const review = candidate.currentReviewId ? this.state.reviews[candidate.currentReviewId] : undefined
          return review?.status === 'queued'
        })
        .sort((left, right) => left.priority - right.priority || left.updatedAt - right.updatedAt)[0]
    if (!task) return null
    if (task.runId !== runId) throw new TaskPoolError('task_run_mismatch', '验收任务不属于当前 run')
    if (task.status !== 'review' || !task.currentReviewId) {
      throw new TaskPoolError('task_not_in_review', '任务当前不在验收状态')
    }
    const review = this.state.reviews[task.currentReviewId]
    const attempt = task.currentAttemptId ? this.state.attempts[task.currentAttemptId] : undefined
    if (!review || review.status !== 'queued' || !attempt || attempt.status !== 'review') {
      throw new TaskPoolError('review_not_available', '任务当前没有可领取的验收')
    }
    if (attempt.agentSessionId === agentSessionId) {
      throw new TaskPoolError('review_self_forbidden', '实现者不能验收自己的任务')
    }

    const at = this.now()
    const ttlMs = boundedInteger(input.ttlMs, DEFAULT_LEASE_TTL_MS, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS)
    const leaseToken = this.nextReviewLeaseToken()
    const leaseExpiresAt = at + ttlMs
    review.status = 'leased'
    review.leaseCount += 1
    review.reviewerSessionId = agentSessionId
    review.reviewerSlotId = slotId
    review.leaseToken = leaseToken
    review.leaseExpiresAt = leaseExpiresAt
    review.updatedAt = at
    task.updatedAt = at
    this.note('review.leased', task.id, attempt.id, agentSessionId, slotId)
    this.bumpRevision()
    return {
      task: structuredClone(task),
      attempt: structuredClone(attempt),
      review: structuredClone(review),
      leaseToken,
      leaseExpiresAt
    }
  }

  renewReview(reviewId: string, leaseToken: string, ttlMs = DEFAULT_LEASE_TTL_MS): number {
    const { task, review } = this.activeReviewLease(reviewId, leaseToken)
    const at = this.now()
    review.leaseExpiresAt = at + boundedInteger(ttlMs, DEFAULT_LEASE_TTL_MS, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS)
    review.updatedAt = at
    task.updatedAt = at
    this.note('review.lease_renewed', task.id, review.attemptId, review.reviewerSessionId)
    this.bumpRevision()
    return review.leaseExpiresAt
  }

  submitReview(
    reviewId: string,
    leaseToken: string,
    decision: TaskReviewDecision,
    evidence: string,
    reason = ''
  ): TeamTask {
    const normalizedEvidence = evidence.trim()
    const normalizedReason = reason.trim()
    if (!normalizedEvidence) throw new TaskPoolError('missing_review_evidence', '验收必须提交验证证据')
    if (decision === 'reject' && !normalizedReason) {
      throw new TaskPoolError('missing_rejection_reason', '打回任务必须说明原因')
    }
    const { task, attempt, review } = this.activeReviewLease(reviewId, leaseToken)
    const reviewer = review.reviewerSessionId!
    return this.completeReview(task, attempt, review, decision, reviewer, normalizedEvidence, normalizedReason)
  }

  approve(taskId: string, reviewer: string): TeamTask {
    const pair = this.reviewPair(taskId)
    const reviewedBy = reviewer.trim() || 'operator'
    return this.completeReview(pair.task, pair.attempt, pair.review, 'accept', reviewedBy, '操作员人工验收')
  }

  reject(taskId: string, reviewer: string, reason: string): TeamTask {
    const normalizedReason = reason.trim()
    if (!normalizedReason) throw new TaskPoolError('missing_rejection_reason', '打回任务必须说明原因')
    const pair = this.reviewPair(taskId)
    return this.completeReview(
      pair.task,
      pair.attempt,
      pair.review,
      'reject',
      reviewer.trim() || 'operator',
      '操作员人工验收',
      normalizedReason
    )
  }

  failAttempt(attemptId: string, leaseToken: string, reason: string): TeamTask {
    const normalizedReason = reason.trim()
    if (!normalizedReason) throw new TaskPoolError('missing_failure_reason', '失败必须说明原因')
    const { task, attempt } = this.activeLease(attemptId, leaseToken)
    const at = this.now()
    attempt.status = 'failed'
    attempt.error = normalizedReason
    attempt.completedAt = at
    attempt.updatedAt = at
    attempt.leaseToken = undefined
    attempt.leaseExpiresAt = undefined
    this.requeueOrFail(task, normalizedReason, at)
    this.note('task.failed', task.id, attempt.id, attempt.agentSessionId, normalizedReason)
    this.bumpRevision()
    return structuredClone(task)
  }

  transferAgentWork(input: {
    fromAgentSessionId: string
    toAgentSessionId: string
    slotId: string
    ttlMs?: number
  }): string[] {
    const fromAgentSessionId = input.fromAgentSessionId.trim()
    const toAgentSessionId = input.toAgentSessionId.trim()
    const slotId = input.slotId.trim()
    if (!fromAgentSessionId || !toAgentSessionId || !slotId || fromAgentSessionId === toAgentSessionId) {
      throw new TaskPoolError('invalid_handover', '任务接替身份无效')
    }
    const hasTransferableWork = Object.values(this.state.attempts).some((attempt) => (
      attempt.agentSessionId === fromAgentSessionId && ['leased', 'running'].includes(attempt.status)
    )) || Object.values(this.state.reviews).some((review) => (
      review.reviewerSessionId === fromAgentSessionId && review.status === 'leased'
    ))
    if (!hasTransferableWork) return []
    if (this.hasActiveAttempt(toAgentSessionId) || this.hasActiveReview(toAgentSessionId)) {
      throw new TaskPoolError('replacement_agent_busy', '备用 Agent 已持有其他活动工作')
    }
    const at = this.now()
    const ttlMs = boundedInteger(input.ttlMs, DEFAULT_LEASE_TTL_MS, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS)
    const transferred = new Set<string>()
    for (const attempt of Object.values(this.state.attempts)) {
      if (attempt.agentSessionId !== fromAgentSessionId || !['leased', 'running'].includes(attempt.status)) continue
      const task = this.state.tasks[attempt.taskId]
      if (!task || task.currentAttemptId !== attempt.id) continue
      attempt.agentSessionId = toAgentSessionId
      attempt.leaseToken = this.nextLeaseToken()
      attempt.leaseExpiresAt = at + ttlMs
      attempt.updatedAt = at
      task.assigneeSessionId = toAgentSessionId
      task.targetSlotId = task.targetSlotId ?? slotId
      task.updatedAt = at
      this.note('lease.transferred', task.id, attempt.id, toAgentSessionId, `from=${fromAgentSessionId}`)
      transferred.add(task.id)
    }
    for (const review of Object.values(this.state.reviews)) {
      if (review.reviewerSessionId !== fromAgentSessionId || review.status !== 'leased') continue
      const task = this.state.tasks[review.taskId]
      if (!task || task.currentReviewId !== review.id || task.status !== 'review') continue
      review.reviewerSessionId = toAgentSessionId
      review.reviewerSlotId = slotId
      review.leaseToken = this.nextReviewLeaseToken()
      review.leaseExpiresAt = at + ttlMs
      review.updatedAt = at
      task.updatedAt = at
      this.note('review.lease_transferred', task.id, review.attemptId, toAgentSessionId, `from=${fromAgentSessionId}`)
      transferred.add(task.id)
    }
    if (transferred.size) this.bumpRevision()
    return [...transferred]
  }

  /**
   * 主控接管专用：目标空闲则直接迁移 lease；目标已有工作时，把原主控工作
   * 安全退回可领取状态并定向到新主控，避免双 lease 或任务永久挂在死会话上。
   */
  recoverAgentWork(input: {
    fromAgentSessionId: string
    toAgentSessionId: string
    targetSlotId: string
    ttlMs?: number
  }): string[] {
    const from = input.fromAgentSessionId.trim()
    const to = input.toAgentSessionId.trim()
    const targetSlotId = input.targetSlotId.trim()
    if (!from || !to || !targetSlotId || from === to) {
      throw new TaskPoolError('invalid_handover', '主控接管身份无效')
    }
    if (!this.hasActiveAttempt(to) && !this.hasActiveReview(to)) {
      return this.transferAgentWork({
        fromAgentSessionId: from,
        toAgentSessionId: to,
        slotId: targetSlotId,
        ttlMs: input.ttlMs
      })
    }
    const at = this.now()
    const recovered = new Set<string>()
    for (const attempt of Object.values(this.state.attempts)) {
      if (attempt.agentSessionId !== from || !['leased', 'running'].includes(attempt.status)) continue
      const task = this.state.tasks[attempt.taskId]
      if (!task || task.currentAttemptId !== attempt.id) continue
      attempt.status = 'cancelled'
      attempt.error = 'lead_handoff_requeued'
      attempt.completedAt = at
      attempt.updatedAt = at
      attempt.leaseToken = undefined
      attempt.leaseExpiresAt = undefined
      task.assigneeSessionId = undefined
      task.currentAttemptId = undefined
      task.currentReviewId = undefined
      task.targetSlotId = targetSlotId
      task.status = task.attemptCount < task.maxAttempts ? 'queued' : 'failed'
      task.progress = 0
      task.failureReason = '原主控离线，任务已交由新主控重新领取'
      task.updatedAt = at
      this.note('lease.handoff_requeued', task.id, attempt.id, to, `from=${from}`)
      recovered.add(task.id)
    }
    for (const review of Object.values(this.state.reviews)) {
      if (review.reviewerSessionId !== from || review.status !== 'leased') continue
      const task = this.state.tasks[review.taskId]
      if (!task || task.currentReviewId !== review.id || task.status !== 'review') continue
      review.status = 'queued'
      review.reviewerSessionId = undefined
      review.reviewerSlotId = undefined
      review.leaseToken = undefined
      review.leaseExpiresAt = undefined
      review.updatedAt = at
      task.updatedAt = at
      this.note('review.handoff_requeued', task.id, review.attemptId, to, `from=${from}`)
      recovered.add(task.id)
    }
    if (recovered.size) this.bumpRevision()
    return [...recovered]
  }

  reclaimExpired(): string[] {
    const at = this.now()
    const reclaimed = new Set<string>()
    for (const attempt of Object.values(this.state.attempts)) {
      if (!['leased', 'running'].includes(attempt.status)) continue
      if (!attempt.leaseExpiresAt || attempt.leaseExpiresAt > at) continue
      const task = this.state.tasks[attempt.taskId]
      if (!task || task.currentAttemptId !== attempt.id) continue
      attempt.status = 'failed'
      attempt.error = 'lease_expired'
      attempt.completedAt = at
      attempt.updatedAt = at
      attempt.leaseToken = undefined
      attempt.leaseExpiresAt = undefined
      this.requeueOrFail(task, 'lease_expired', at)
      this.note('lease.expired', task.id, attempt.id, attempt.agentSessionId)
      reclaimed.add(task.id)
    }
    for (const review of Object.values(this.state.reviews)) {
      if (review.status !== 'leased') continue
      if (!review.leaseExpiresAt || review.leaseExpiresAt > at) continue
      const task = this.state.tasks[review.taskId]
      if (!task || task.currentReviewId !== review.id || task.status !== 'review') continue
      const previousReviewer = review.reviewerSessionId
      review.status = 'queued'
      review.reviewerSessionId = undefined
      review.reviewerSlotId = undefined
      review.leaseToken = undefined
      review.leaseExpiresAt = undefined
      review.updatedAt = at
      task.updatedAt = at
      this.note('review.lease_expired', task.id, review.attemptId, previousReviewer)
      reclaimed.add(task.id)
    }
    if (reclaimed.size) this.bumpRevision()
    return [...reclaimed]
  }

  cancel(taskId: string, reason: string): TeamTask {
    const task = this.taskOf(taskId)
    if (['done', 'failed', 'cancelled'].includes(task.status)) {
      throw new TaskPoolError('terminal_task', '终态任务不能再次取消')
    }
    const at = this.now()
    const attempt = task.currentAttemptId ? this.state.attempts[task.currentAttemptId] : undefined
    if (attempt && ['leased', 'running', 'review'].includes(attempt.status)) {
      attempt.status = 'cancelled'
      attempt.error = reason.trim() || 'cancelled'
      attempt.completedAt = at
      attempt.updatedAt = at
      attempt.leaseToken = undefined
      attempt.leaseExpiresAt = undefined
    }
    const review = task.currentReviewId ? this.state.reviews[task.currentReviewId] : undefined
    if (review && ['queued', 'leased'].includes(review.status)) {
      review.status = 'cancelled'
      review.leaseToken = undefined
      review.leaseExpiresAt = undefined
      review.completedAt = at
      review.updatedAt = at
    }
    task.status = 'cancelled'
    task.failureReason = reason.trim() || 'cancelled'
    task.updatedAt = at
    this.note('task.cancelled', task.id, attempt?.id, undefined, task.failureReason)
    this.bumpRevision()
    return structuredClone(task)
  }

  private hasActiveAttempt(agentSessionId: string): boolean {
    return Object.values(this.state.attempts).some(
      (attempt) => attempt.agentSessionId === agentSessionId && ['leased', 'running'].includes(attempt.status)
    )
  }

  private hasActiveReview(agentSessionId: string): boolean {
    return Object.values(this.state.reviews).some(
      (review) => review.reviewerSessionId === agentSessionId && review.status === 'leased'
    )
  }

  private activeLease(attemptId: string, leaseToken: string): { task: TeamTask; attempt: TaskAttempt } {
    const attempt = this.state.attempts[attemptId]
    if (!attempt) throw new TaskPoolError('attempt_not_found', `Attempt 不存在：${attemptId}`)
    const task = this.taskOf(attempt.taskId)
    if (!['leased', 'running'].includes(attempt.status) || task.currentAttemptId !== attempt.id) {
      throw new TaskPoolError('stale_attempt', 'Attempt 已失效，不能继续写入')
    }
    if (!attempt.leaseToken || attempt.leaseToken !== leaseToken) {
      throw new TaskPoolError('invalid_lease_token', 'Lease token 不匹配')
    }
    if (!attempt.leaseExpiresAt || attempt.leaseExpiresAt <= this.now()) {
      throw new TaskPoolError('lease_expired', 'Lease 已过期，等待调度器回收任务')
    }
    return { task, attempt }
  }

  private activeReviewLease(
    reviewId: string,
    leaseToken: string
  ): { task: TeamTask; attempt: TaskAttempt; review: TaskReview } {
    const review = this.state.reviews[reviewId]
    if (!review) throw new TaskPoolError('review_not_found', `Review 不存在：${reviewId}`)
    const task = this.taskOf(review.taskId)
    const attempt = this.state.attempts[review.attemptId]
    if (!attempt || attempt.status !== 'review' || task.currentAttemptId !== attempt.id) {
      throw new TaskPoolError('review_attempt_missing', '验收对应的实现 Attempt 已失效')
    }
    if (review.status !== 'leased' || task.currentReviewId !== review.id || task.status !== 'review') {
      throw new TaskPoolError('stale_review', 'Review Lease 已失效')
    }
    if (!review.leaseToken || review.leaseToken !== leaseToken) {
      throw new TaskPoolError('invalid_review_lease_token', 'Review Lease token 不匹配')
    }
    if (!review.leaseExpiresAt || review.leaseExpiresAt <= this.now()) {
      throw new TaskPoolError('review_lease_expired', 'Review Lease 已过期，等待调度器重新分配')
    }
    return { task, attempt, review }
  }

  private reviewPair(taskId: string): { task: TeamTask; attempt: TaskAttempt; review: TaskReview } {
    const task = this.taskOf(taskId)
    if (task.status !== 'review' || !task.currentAttemptId || !task.currentReviewId) {
      throw new TaskPoolError('task_not_in_review', '任务当前不在验收状态')
    }
    const attempt = this.state.attempts[task.currentAttemptId]
    const review = this.state.reviews[task.currentReviewId]
    if (!attempt || attempt.status !== 'review') {
      throw new TaskPoolError('review_attempt_missing', '任务的验收 Attempt 不存在')
    }
    if (!review || !['queued', 'leased'].includes(review.status) || review.attemptId !== attempt.id) {
      throw new TaskPoolError('review_record_missing', '任务的独立验收记录不存在')
    }
    return { task, attempt, review }
  }

  private completeReview(
    task: TeamTask,
    attempt: TaskAttempt,
    review: TaskReview,
    decision: TaskReviewDecision,
    reviewer: string,
    evidence: string,
    reason = ''
  ): TeamTask {
    const at = this.now()
    review.status = decision === 'accept' ? 'approved' : 'rejected'
    review.decision = decision
    review.reviewedBy = reviewer
    review.evidence = evidence
    review.reason = reason || undefined
    review.leaseToken = undefined
    review.leaseExpiresAt = undefined
    review.completedAt = at
    review.updatedAt = at
    attempt.completedAt = at
    attempt.updatedAt = at
    if (decision === 'accept') {
      attempt.status = 'done'
      task.status = 'done'
      task.result = attempt.output
      task.updatedAt = at
      this.note('review.approved', task.id, attempt.id, reviewer, evidence.slice(0, 1_000))
      this.note('task.approved', task.id, attempt.id, reviewer)
    } else {
      attempt.status = 'failed'
      attempt.error = reason
      this.requeueOrFail(task, reason, at)
      this.note('review.rejected', task.id, attempt.id, reviewer, reason)
      this.note('task.rejected', task.id, attempt.id, reviewer, reason)
    }
    this.bumpRevision()
    return structuredClone(task)
  }

  private requeueOrFail(task: TeamTask, reason: string, at: number): void {
    task.assigneeSessionId = undefined
    task.currentAttemptId = undefined
    task.currentReviewId = undefined
    task.progress = 0
    task.failureReason = reason
    task.updatedAt = at
    task.status = task.attemptCount < task.maxAttempts ? 'queued' : 'failed'
  }

  private taskOf(taskId: string): TeamTask {
    const task = this.state.tasks[taskId]
    if (!task) throw new TaskPoolError('task_not_found', `任务不存在：${taskId}`)
    return task
  }

  private note(
    type: string,
    taskId: string,
    attemptId?: string,
    agentSessionId?: string,
    detail?: string
  ): void {
    this.state.seq += 1
    this.state.events.push({
      seq: this.state.seq,
      type,
      taskId,
      attemptId,
      agentSessionId,
      detail,
      at: this.now()
    })
    if (this.state.events.length > EVENT_CAP) this.state.events.splice(0, this.state.events.length - EVENT_CAP)
  }

  private bumpRevision(): void {
    this.state.revision += 1
  }
}

function findDependencyCycle(graph: Map<string, string[]>): string[] {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const visit = (node: string): string[] => {
    if (visited.has(node)) return []
    if (visiting.has(node)) {
      const index = stack.indexOf(node)
      return [...stack.slice(index), node]
    }
    visiting.add(node)
    stack.push(node)
    for (const dependency of graph.get(node) ?? []) {
      const cycle = visit(dependency)
      if (cycle.length) return cycle
    }
    stack.pop()
    visiting.delete(node)
    visited.add(node)
    return []
  }

  for (const node of graph.keys()) {
    const cycle = visit(node)
    if (cycle.length) return cycle
  }
  return []
}
