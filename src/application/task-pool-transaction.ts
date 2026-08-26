import {
  TaskPoolAggregate,
  type TaskPoolDependencies,
  type TaskPoolState
} from '../domain/task-pool'

export interface TaskPoolRepository {
  load(): TaskPoolState
  compareAndSwap(expectedRevision: number, nextState: TaskPoolState): boolean
}

export class TaskPoolConflictError extends Error {
  constructor(message = '任务池并发更新冲突，请重试') {
    super(message)
    this.name = 'TaskPoolConflictError'
  }
}

export function transactTaskPool<Result>(
  repository: TaskPoolRepository,
  operation: (aggregate: TaskPoolAggregate) => Result,
  options: {
    maxRetries?: number
    dependencies?: TaskPoolDependencies
  } = {}
): Result {
  const maxRetries = Math.max(1, Math.min(10, options.maxRetries ?? 3))

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const before = repository.load()
    const aggregate = new TaskPoolAggregate(before, options.dependencies)
    const result = operation(aggregate)
    const after = aggregate.snapshot()
    if (after.revision === before.revision) return result
    if (repository.compareAndSwap(before.revision, after)) return result
  }

  throw new TaskPoolConflictError()
}
