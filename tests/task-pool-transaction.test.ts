import { describe, expect, it } from 'vitest'
import {
  TaskPoolConflictError,
  transactTaskPool,
  type TaskPoolRepository
} from '../src/application/task-pool-transaction'
import { emptyTaskPoolState, type TaskPoolState } from '../src/domain/task-pool'
import { InMemoryTaskPoolRepository } from '../src/infrastructure/task-pool/in-memory-task-pool-repository'

describe('transactTaskPool', () => {
  it('commits aggregate changes through compare-and-swap', () => {
    const repository = new InMemoryTaskPoolRepository()
    const tasks = transactTaskPool(repository, (pool) =>
      pool.plan('run-1', [{ key: 'first', title: '第一条任务' }])
    )

    expect(tasks).toHaveLength(1)
    expect(repository.load().revision).toBe(1)
    expect(repository.load().taskOrder).toHaveLength(1)
  })

  it('retries a conflict against the latest state', () => {
    let state = emptyTaskPoolState()
    let firstSwap = true
    const repository: TaskPoolRepository = {
      load: () => structuredClone(state),
      compareAndSwap: (expectedRevision, nextState) => {
        if (firstSwap) {
          firstSwap = false
          state = { ...state, revision: state.revision + 1 }
          return false
        }
        if (state.revision !== expectedRevision) return false
        state = structuredClone(nextState)
        return true
      }
    }

    transactTaskPool(repository, (pool) =>
      pool.plan('run-1', [{ key: 'retry', title: '冲突后重试' }])
    )
    expect(state.taskOrder).toHaveLength(1)
    expect(state.revision).toBe(2)
  })

  it('fails cleanly when every compare-and-swap conflicts', () => {
    const state: TaskPoolState = emptyTaskPoolState()
    const repository: TaskPoolRepository = {
      load: () => structuredClone(state),
      compareAndSwap: () => false
    }

    expect(() => transactTaskPool(
      repository,
      (pool) => pool.plan('run-1', [{ key: 'never', title: '无法提交' }]),
      { maxRetries: 2 }
    )).toThrowError(TaskPoolConflictError)
  })

  it('does not commit partial aggregate changes when an operation throws', () => {
    const repository = new InMemoryTaskPoolRepository()

    expect(() => transactTaskPool(repository, (pool) => {
      pool.plan('run-1', [{ key: 'partial', title: '不应提交' }])
      throw new Error('operation_failed')
    })).toThrowError('operation_failed')
    expect(repository.load().taskOrder).toEqual([])
    expect(repository.load().revision).toBe(0)
  })
})
