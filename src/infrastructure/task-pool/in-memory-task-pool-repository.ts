import type { TaskPoolRepository } from '../../application/task-pool-transaction'
import { emptyTaskPoolState, type TaskPoolState } from '../../domain/task-pool'

export class InMemoryTaskPoolRepository implements TaskPoolRepository {
  private state: TaskPoolState

  constructor(initialState: TaskPoolState = emptyTaskPoolState()) {
    this.state = structuredClone(initialState)
  }

  load(): TaskPoolState {
    return structuredClone(this.state)
  }

  compareAndSwap(expectedRevision: number, nextState: TaskPoolState): boolean {
    if (this.state.revision !== expectedRevision) return false
    this.state = structuredClone(nextState)
    return true
  }
}
