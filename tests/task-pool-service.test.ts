import { describe, expect, it } from 'vitest'
import { TaskPoolService } from '../src/application/task-pool-service'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { emptyTaskPoolSnapshot, newestTaskPoolSnapshot } from '../src/domain/task-pool'
import { InMemoryTaskPoolRepository } from '../src/infrastructure/task-pool/in-memory-task-pool-repository'

describe('TaskPoolService', () => {
  const runProvider = { getActiveRunId: () => 'workspace-run' }

  it('persists real create and cancel operations and broadcasts snapshots', () => {
    const repository = new InMemoryTaskPoolRepository()
    const service = new TaskPoolService(repository, runProvider)
    const revisions: number[] = []
    const unsubscribe = service.subscribe((snapshot) => revisions.push(snapshot.revision))

    const task = service.createTask({
      title: '实现任务池页面',
      description: '不是占位页面',
      acceptance: '重启后仍存在',
      priority: 1,
      maxAttempts: 3
    })
    expect(service.getSnapshot().tasks[task.id]).toMatchObject({
      runId: 'workspace-run',
      status: 'queued',
      priority: 1,
      maxAttempts: 3
    })

    service.cancelTask(task.id, '测试取消')
    expect(service.getSnapshot().tasks[task.id]).toMatchObject({
      status: 'cancelled',
      failureReason: '测试取消'
    })
    expect(revisions).toEqual([0, 1, 2])
    unsubscribe()
  })

  it('validates user-controlled text before touching the repository', () => {
    const repository = new InMemoryTaskPoolRepository()
    const service = new TaskPoolService(repository, runProvider)

    expect(() => service.createTask({ title: '  ' })).toThrowError(/标题不能为空/)
    expect(repository.load().revision).toBe(0)
  })

  it('detects commits made by an external MCP process through revision polling', () => {
    const repository = new InMemoryTaskPoolRepository()
    const service = new TaskPoolService(repository, runProvider)
    const revisions: number[] = []
    service.subscribe((snapshot) => revisions.push(snapshot.revision))

    transactTaskPool(repository, (pool) => pool.plan('workspace-run', [{ key: 'external', title: 'MCP 写入' }]))
    expect(service.pollExternalChanges()).toBe(true)
    expect(service.pollExternalChanges()).toBe(false)
    expect(revisions).toEqual([0, 1])
  })

  it('never exposes or mutates tasks from another workspace run', () => {
    const repository = new InMemoryTaskPoolRepository()
    transactTaskPool(repository, (pool) => pool.plan('other-run', [{ key: 'secret', title: '其他工程任务' }]))
    const service = new TaskPoolService(repository, runProvider)

    expect(service.getSnapshot().taskOrder).toEqual([])
    const foreignTaskId = repository.load().taskOrder[0]!
    expect(() => service.cancelTask(foreignTaskId)).toThrowError(/不属于当前 TeamRun/)
  })

  it('scopes every snapshot and rejects a late snapshot from the previous workspace', () => {
    let scope = { workspaceId: 'alpha', runId: 'run-alpha', scopeRevision: 10 }
    const provider = {
      getActiveRunId: () => scope.runId,
      getActiveTaskScope: () => scope
    }
    const repository = new InMemoryTaskPoolRepository()
    transactTaskPool(repository, (pool) => {
      pool.plan('run-alpha', [{ key: 'a', title: 'Alpha' }])
      pool.plan('run-beta', [{ key: 'b', title: 'Beta' }])
    })
    const service = new TaskPoolService(repository, provider)
    const alpha = service.getSnapshot()
    expect(alpha).toMatchObject({ workspaceId: 'alpha', runId: 'run-alpha', scopeRevision: 10 })
    expect(alpha.taskOrder).toHaveLength(1)

    scope = { workspaceId: 'beta', runId: 'run-beta', scopeRevision: 11 }
    const beta = service.getSnapshot()
    expect(beta).toMatchObject({ workspaceId: 'beta', runId: 'run-beta', scopeRevision: 11 })
    expect(beta.taskOrder).toHaveLength(1)

    const lateAlpha = { ...alpha, revision: beta.revision + 100 }
    expect(newestTaskPoolSnapshot(beta, lateAlpha)).toBe(beta)
    expect(newestTaskPoolSnapshot(emptyTaskPoolSnapshot(), alpha)).toBe(alpha)
  })

  it('cancels every unfinished task when a run closes while preserving history', () => {
    const repository = new InMemoryTaskPoolRepository()
    transactTaskPool(repository, (pool) => {
      pool.plan('workspace-run', [
        { key: 'one', title: '未开始任务' },
        { key: 'two', title: '另一条任务' }
      ])
    })
    const service = new TaskPoolService(repository, runProvider)
    const cancelled = service.closeRun('workspace-run', '全员离线，本轮结束')

    expect(cancelled).toHaveLength(2)
    expect(service.getSnapshot().taskOrder).toHaveLength(2)
    expect(Object.values(service.getSnapshot().tasks)).toEqual([
      expect.objectContaining({ status: 'cancelled', failureReason: '全员离线，本轮结束' }),
      expect.objectContaining({ status: 'cancelled', failureReason: '全员离线，本轮结束' })
    ])
    expect(service.closeRun('workspace-run')).toEqual([])
  })

  it('rejects task mutations after the active run has completed', () => {
    const repository = new InMemoryTaskPoolRepository()
    const service = new TaskPoolService(repository, {
      getActiveRunId: () => 'workspace-run',
      getActiveRunStatus: () => 'completed'
    })
    expect(() => service.createTask({ title: '不应创建' })).toThrowError(/本轮团队已经结束/)
  })
})
