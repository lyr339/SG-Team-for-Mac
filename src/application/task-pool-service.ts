import { randomUUID } from 'node:crypto'
import { transactTaskPool, type TaskPoolRepository } from './task-pool-transaction'
import type { PlanTaskInput, TaskPoolSnapshot, TaskPoolState, TeamTask } from '../domain/task-pool'
import type { TeamRunStatus } from '../domain/team-control'

export interface ActiveTaskScope {
  workspaceId?: string
  runId?: string
  scopeRevision: number
}

export interface ActiveRunProvider {
  getActiveRunId(): string | undefined
  getActiveRunStatus?(): TeamRunStatus | undefined
  getActiveTaskScope?(): ActiveTaskScope
}

export interface CreateTaskInput {
  title: string
  description?: string
  acceptance?: string
  priority?: number
  maxAttempts?: number
  dependsOnTaskIds?: string[]
  requiredCapabilities?: string[]
}

type TaskPoolListener = (snapshot: TaskPoolSnapshot) => void

export class TaskPoolService {
  private listeners = new Set<TaskPoolListener>()
  private sweepTimer?: ReturnType<typeof setInterval>
  private watchTimer?: ReturnType<typeof setInterval>
  private lastEmittedRevision: number

  constructor(
    private readonly repository: TaskPoolRepository,
    private readonly runProvider: ActiveRunProvider
  ) {
    this.lastEmittedRevision = repository.load().revision
  }

  getSnapshot(): TaskPoolSnapshot {
    return this.snapshotForActiveRun(this.repository.load(), this.activeScope())
  }

  subscribe(listener: TaskPoolListener): () => void {
    this.listeners.add(listener)
    const snapshot = this.getSnapshot()
    this.lastEmittedRevision = snapshot.revision
    listener(snapshot)
    return () => this.listeners.delete(listener)
  }

  createTask(input: CreateTaskInput): TeamTask {
    const title = input.title.trim()
    if (!title) throw new Error('任务标题不能为空')
    if (title.length > 160) throw new Error('任务标题不能超过 160 个字符')
    const description = input.description?.trim() ?? ''
    const acceptance = input.acceptance?.trim() ?? ''
    if (description.length > 8_000) throw new Error('任务描述不能超过 8000 个字符')
    if (acceptance.length > 4_000) throw new Error('验收标准不能超过 4000 个字符')

    const runId = this.requireMutableRunId()
    const rawState = this.repository.load()
    const dependencyKeys = [...new Set(input.dependsOnTaskIds ?? [])].map((taskId) => {
      const task = rawState.tasks[taskId]
      if (!task || task.runId !== runId) throw new Error('前置任务不属于当前 TeamRun')
      return task.key
    })
    const requiredCapabilities = [...new Set((input.requiredCapabilities ?? [])
      .map((value) => value.trim())
      .filter(Boolean))]
    if (requiredCapabilities.length > 32 || requiredCapabilities.some((value) => value.length > 80)) {
      throw new Error('任务能力配置超出限制')
    }

    const plan: PlanTaskInput = {
      key: `manual-${randomUUID()}`,
      title,
      description,
      acceptance,
      priority: input.priority,
      maxAttempts: input.maxAttempts,
      dependsOn: dependencyKeys,
      requiredCapabilities
    }
    const [task] = transactTaskPool(this.repository, (pool) => pool.plan(runId, [plan]))
    this.emit()
    return task!
  }

  cancelTask(taskId: string, reason = '用户取消'): TeamTask {
    const normalizedTaskId = taskId.trim()
    if (!normalizedTaskId) throw new Error('taskId 不能为空')
    this.assertTaskInActiveRun(normalizedTaskId)
    const task = transactTaskPool(this.repository, (pool) => pool.cancel(normalizedTaskId, reason))
    this.emit()
    return task
  }

  approveTask(taskId: string, reviewer = '用户'): TeamTask {
    const normalizedTaskId = taskId.trim()
    this.assertTaskInActiveRun(normalizedTaskId)
    const task = transactTaskPool(this.repository, (pool) => pool.approve(normalizedTaskId, reviewer))
    this.emit()
    return task
  }

  rejectTask(taskId: string, reason: string, reviewer = '用户'): TeamTask {
    const normalizedTaskId = taskId.trim()
    this.assertTaskInActiveRun(normalizedTaskId)
    const task = transactTaskPool(this.repository, (pool) => pool.reject(normalizedTaskId, reviewer, reason))
    this.emit()
    return task
  }

  closeRun(runId: string, reason = '本轮团队已经结束'): TeamTask[] {
    const normalizedRunId = runId.trim()
    if (!normalizedRunId) throw new Error('runId 不能为空')
    const terminal = new Set(['done', 'failed', 'cancelled'])
    const state = this.repository.load()
    const taskIds = state.taskOrder.filter((taskId) => {
      const task = state.tasks[taskId]
      return task?.runId === normalizedRunId && !terminal.has(task.status)
    })
    if (!taskIds.length) return []
    const cancelled = transactTaskPool(this.repository, (pool) => taskIds.flatMap((taskId) => {
      const task = pool.snapshot().tasks[taskId]
      return task && !terminal.has(task.status) ? [pool.cancel(taskId, reason)] : []
    }))
    if (cancelled.length) this.emit()
    return cancelled
  }

  sweepExpiredLeases(): string[] {
    const reclaimed = transactTaskPool(this.repository, (pool) => pool.reclaimExpired())
    this.pollExternalChanges()
    return reclaimed
  }

  transferAgentWork(input: {
    fromAgentSessionId: string
    toAgentSessionId: string
    slotId: string
    ttlMs?: number
  }): string[] {
    const transferred = transactTaskPool(this.repository, (pool) => pool.transferAgentWork(input))
    this.emit()
    return transferred
  }

  pollExternalChanges(): boolean {
    const revision = this.repository.load().revision
    if (revision === this.lastEmittedRevision) return false
    this.emit()
    return true
  }

  notifyRunChanged(): void {
    this.emit()
  }

  startSweeper(intervalMs = 5_000): void {
    this.stopSweeper()
    this.sweepTimer = setInterval(() => {
      try {
        this.sweepExpiredLeases()
      } catch (error) {
        process.stderr.write(`[task-pool] lease sweep failed: ${String(error)}\n`)
      }
    }, Math.max(1_000, intervalMs))
    this.sweepTimer.unref?.()
  }

  startWatcher(intervalMs = 1_000): void {
    this.stopWatcher()
    this.watchTimer = setInterval(() => {
      try {
        this.pollExternalChanges()
      } catch (error) {
        process.stderr.write(`[task-pool] revision watch failed: ${String(error)}\n`)
      }
    }, Math.max(250, intervalMs))
    this.watchTimer.unref?.()
  }

  stopSweeper(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  stopWatcher(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = undefined
  }

  private emit(snapshot = this.getSnapshot()): void {
    this.lastEmittedRevision = snapshot.revision
    for (const listener of this.listeners) listener(snapshot)
  }

  private requireActiveRunId(): string {
    const runId = this.runProvider.getActiveRunId()?.trim()
    if (!runId) throw new Error('请先在“团队”中选择 Cursor 工作区并创建 TeamRun')
    return runId
  }

  private requireMutableRunId(): string {
    const runId = this.requireActiveRunId()
    const status = this.runProvider.getActiveRunStatus?.()
    if (status === 'completed') throw new Error('本轮团队已经结束，请开始新一轮')
    if (status === 'paused') throw new Error('本轮团队已暂停，当前不能修改任务')
    return runId
  }

  private assertTaskInActiveRun(taskId: string): void {
    const runId = this.requireMutableRunId()
    const task = this.repository.load().tasks[taskId]
    if (!task || task.runId !== runId) throw new Error('任务不属于当前 TeamRun')
  }

  private activeScope(): ActiveTaskScope {
    return this.runProvider.getActiveTaskScope?.() ?? {
      runId: this.runProvider.getActiveRunId(),
      scopeRevision: 0
    }
  }

  private snapshotForActiveRun(state: TaskPoolState, scope: ActiveTaskScope): TaskPoolSnapshot {
    const { runId } = scope
    const taskOrder = runId
      ? state.taskOrder.filter((taskId) => state.tasks[taskId]?.runId === runId)
      : []
    const taskIds = new Set(taskOrder)
    const tasks = Object.fromEntries(taskOrder.map((taskId) => [taskId, state.tasks[taskId]!]))
    const attempts = Object.fromEntries(
      Object.entries(state.attempts).filter(([, attempt]) => taskIds.has(attempt.taskId))
    )
    const events = state.events.filter((event) => taskIds.has(event.taskId))
    const reviews = Object.fromEntries(
      Object.entries(state.reviews).filter(([, review]) => taskIds.has(review.taskId))
    )
    const reviewOrder = state.reviewOrder.filter((reviewId) => Boolean(reviews[reviewId]))
    return structuredClone({
      ...state,
      workspaceId: scope.workspaceId,
      runId,
      scopeRevision: scope.scopeRevision,
      tasks,
      taskOrder,
      attempts,
      reviews,
      reviewOrder,
      events
    })
  }
}
