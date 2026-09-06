import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { TaskPoolAggregate } from '../src/domain/task-pool'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'

function databasePath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `sg-team-${name}-`)), 'task-pool.sqlite3')
}

describe('SqliteTaskPoolRepository', () => {
  it('migrates schema v1 in place and preserves existing tasks', () => {
    const path = databasePath('migration-v1')
    const initial = new SqliteTaskPoolRepository(path)
    transactTaskPool(initial, (pool) => pool.plan('run-1', [{ key: 'legacy', title: '旧任务' }]))
    initial.close()
    const legacy = new DatabaseSync(path)
    legacy.exec('ALTER TABLE tasks DROP COLUMN target_slot_id')
    legacy.exec('UPDATE task_pool_meta SET schema_version = 1 WHERE id = 1')
    legacy.close()

    const migrated = new SqliteTaskPoolRepository(path)
    try {
      expect(migrated.load()).toMatchObject({
        schemaVersion: 3,
        tasks: { [migrated.load().taskOrder[0]!]: { title: '旧任务' } }
      })
      const columns = new DatabaseSync(path, { readOnly: true })
      try {
        expect(columns.prepare('PRAGMA table_info(tasks)').all())
          .toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'target_slot_id' }),
            expect.objectContaining({ name: 'current_review_id' })
          ]))
        expect(columns.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_reviews'").get())
          .toBeDefined()
      } finally {
        columns.close()
      }
    } finally {
      migrated.close()
    }
  })

  it('migrates a schema v2 task already waiting for review into the independent review queue', () => {
    const path = databasePath('migration-v2-review')
    const initial = new SqliteTaskPoolRepository(path)
    const [task] = transactTaskPool(initial, (pool) => pool.plan('run-1', [{ key: 'legacy-review', title: '旧版待验收' }]))
    const implementation = transactTaskPool(initial, (pool) =>
      pool.leaseNext({ runId: 'run-1', agentSessionId: 'dev-1' })
    )!
    transactTaskPool(initial, (pool) => pool.startAttempt(implementation.attempt.id, implementation.leaseToken))
    transactTaskPool(initial, (pool) => pool.submitForReview(
      implementation.attempt.id,
      implementation.leaseToken,
      '旧版交付结果'
    ))
    initial.close()
    const legacy = new DatabaseSync(path)
    legacy.exec('DELETE FROM task_reviews')
    legacy.exec('ALTER TABLE tasks DROP COLUMN current_review_id')
    legacy.exec('UPDATE task_pool_meta SET schema_version = 2 WHERE id = 1')
    legacy.close()

    const migrated = new SqliteTaskPoolRepository(path)
    try {
      const state = migrated.load()
      const currentReviewId = state.tasks[task!.id]?.currentReviewId
      expect(currentReviewId).toBe(`review-migrated-${task!.id}`)
      expect(state.reviews[currentReviewId!]).toMatchObject({
        taskId: task!.id,
        attemptId: implementation.attempt.id,
        status: 'queued'
      })
    } finally {
      migrated.close()
    }
  })

  it('survives close and reopen with tasks, attempts and events intact', () => {
    const path = databasePath('restart')
    const first = new SqliteTaskPoolRepository(path)
    const [planned] = transactTaskPool(first, (pool) =>
      pool.plan('run-1', [{ key: 'persist', title: '持久化任务', requiredCapabilities: ['code'] }])
    )
    const leased = transactTaskPool(first, (pool) =>
      pool.leaseNext({ runId: 'run-1', agentSessionId: 'agent-1', capabilities: ['code'] })
    )
    transactTaskPool(first, (pool) => pool.startAttempt(leased!.attempt.id, leased!.leaseToken))
    first.close()

    const reopened = new SqliteTaskPoolRepository(path)
    const state = reopened.load()
    expect(state.tasks[planned!.id]).toMatchObject({
      title: '持久化任务',
      status: 'running',
      assigneeSessionId: 'agent-1'
    })
    expect(state.attempts[leased!.attempt.id]).toMatchObject({ status: 'running' })
    expect(state.events.map((event) => event.type)).toEqual([
      'task.planned',
      'task.leased',
      'task.started'
    ])
    reopened.close()
  })

  it('persists an independent review lease and final evidence across restart', () => {
    const path = databasePath('review-restart')
    const first = new SqliteTaskPoolRepository(path)
    const [task] = transactTaskPool(first, (pool) => pool.plan('run-1', [{ key: 'review', title: '独立验收' }]))
    const implementation = transactTaskPool(first, (pool) =>
      pool.leaseNext({ runId: 'run-1', agentSessionId: 'dev-1' })
    )!
    transactTaskPool(first, (pool) => pool.startAttempt(implementation.attempt.id, implementation.leaseToken))
    transactTaskPool(first, (pool) => pool.submitForReview(
      implementation.attempt.id,
      implementation.leaseToken,
      '产物与测试'
    ))
    const review = transactTaskPool(first, (pool) => pool.leaseReview({
      runId: 'run-1', agentSessionId: 'qa-1', slotId: 'slot-qa', taskId: task!.id
    }))!
    transactTaskPool(first, (pool) => pool.submitReview(
      review.review.id,
      review.leaseToken,
      'accept',
      '复跑测试、检查边界均通过'
    ))
    first.close()

    const reopened = new SqliteTaskPoolRepository(path)
    try {
      const state = reopened.load()
      expect(state.tasks[task!.id]).toMatchObject({ status: 'done', currentReviewId: review.review.id })
      expect(state.reviews[review.review.id]).toMatchObject({
        status: 'approved',
        decision: 'accept',
        reviewedBy: 'qa-1',
        evidence: '复跑测试、检查边界均通过'
      })
    } finally {
      reopened.close()
    }
  })

  it('rejects stale compare-and-swap writers across two connections', () => {
    const path = databasePath('cas')
    const first = new SqliteTaskPoolRepository(path)
    const second = new SqliteTaskPoolRepository(path)
    const stale = second.load()

    transactTaskPool(first, (pool) => pool.plan('run-1', [{ key: 'first', title: '先提交' }]))
    const staleAggregate = new TaskPoolAggregate(stale)
    staleAggregate.plan('run-2', [{ key: 'stale', title: '陈旧提交' }])

    expect(second.compareAndSwap(stale.revision, staleAggregate.snapshot())).toBe(false)
    expect(second.load().taskOrder).toHaveLength(1)
    first.close()
    second.close()
  })

  it('rolls back the whole transaction when a normalized row is invalid', () => {
    const repository = new SqliteTaskPoolRepository(databasePath('rollback'))
    transactTaskPool(repository, (pool) => pool.plan('run-1', [{ key: 'safe', title: '安全任务' }]))
    const before = repository.load()
    const invalid = structuredClone(before)
    invalid.revision += 1
    invalid.attempts['broken-attempt'] = {
      id: 'broken-attempt',
      taskId: 'missing-task',
      number: 1,
      agentSessionId: 'agent-1',
      status: 'running',
      progress: 0,
      summary: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    expect(() => repository.compareAndSwap(before.revision, invalid)).toThrowError(/不存在的任务/)
    const after = repository.load()
    expect(after.revision).toBe(before.revision)
    expect(after.taskOrder).toEqual(before.taskOrder)
    expect(after.attempts['broken-attempt']).toBeUndefined()
    repository.close()
  })

  it('revokes the previous installed generation and prevents capability escalation', () => {
    const repository = new SqliteTaskPoolRepository(databasePath('agent-auth'))
    const firstIdentity = {
      agentSessionId: 'workspace:ch-1:generation1',
      runId: 'team-run-main',
      capabilities: ['code']
    }
    repository.replaceWorkspaceAgentRegistrations({
      workspaceId: 'workspace',
      generation: 'generation1',
      runId: 'team-run-main',
      agents: [{
        ...firstIdentity,
        workspaceId: 'workspace',
        channelId: '1',
        generation: 'generation1'
      }]
    })
    expect(() => repository.assertAgentAuthorized(firstIdentity)).not.toThrow()
    expect(() => repository.assertAgentAuthorized({
      ...firstIdentity,
      capabilities: ['code', 'devops']
    })).toThrowError(/未注册的能力/)

    const secondIdentity = {
      agentSessionId: 'workspace:ch-1:generation2',
      runId: 'team-run-main',
      capabilities: ['code']
    }
    repository.replaceWorkspaceAgentRegistrations({
      workspaceId: 'workspace',
      generation: 'generation2',
      runId: 'team-run-main',
      agents: [{
        ...secondIdentity,
        workspaceId: 'workspace',
        channelId: '1',
        generation: 'generation2'
      }]
    })
    expect(() => repository.assertAgentAuthorized(firstIdentity)).toThrowError(/已被撤销/)
    expect(() => repository.assertAgentAuthorized(secondIdentity)).not.toThrow()
    repository.close()
  })
})
