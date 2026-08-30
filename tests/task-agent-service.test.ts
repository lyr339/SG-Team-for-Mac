import { describe, expect, it } from 'vitest'
import { TaskAgentService } from '../src/application/task-agent-service'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { InMemoryTaskPoolRepository } from '../src/infrastructure/task-pool/in-memory-task-pool-repository'

const allowAllAgents = { assertAgentAuthorized: () => undefined }

function plannedRepository() {
  const repository = new InMemoryTaskPoolRepository()
  const [implementation, verification] = transactTaskPool(repository, (pool) =>
    pool.plan('run-1', [
      { key: 'impl', title: '实现', requiredCapabilities: ['code'] },
      { key: 'verify', title: '验证', requiredCapabilities: ['qa'], dependsOn: ['impl'] }
    ])
  )
  return { repository, implementation: implementation!, verification: verification! }
}

describe('TaskAgentService', () => {
  it('runs claim, start, renew, progress and review without exposing lease tokens', () => {
    const { repository, implementation, verification } = plannedRepository()
    const developer = new TaskAgentService(repository, {
      agentSessionId: 'workspace:composer-dev:1',
      runId: 'run-1',
      capabilities: ['code']
    }, allowAllAgents)
    const qa = new TaskAgentService(repository, {
      agentSessionId: 'workspace:composer-qa:1',
      runId: 'run-1',
      slotId: 'slot-qa',
      capabilities: ['qa']
    }, allowAllAgents)

    expect(developer.listAvailable().map((task) => task.id)).toEqual([implementation.id])
    expect(qa.listAvailable()).toEqual([])
    const assignment = developer.claim()
    expect(assignment?.task.id).toBe(implementation.id)
    expect(JSON.stringify(assignment)).not.toContain('leaseToken')
    expect(developer.claim()?.attemptId).toBe(assignment?.attemptId)

    developer.start(implementation.id)
    expect(developer.start(implementation.id).task.status).toBe('running')
    developer.renew(implementation.id, 120_000)
    developer.report(implementation.id, 60, '核心实现完成')
    const submitted = developer.submit(implementation.id, 'diff + test evidence')
    expect(submitted.task.status).toBe('review')
    expect(developer.submit(implementation.id, '重试提交不应创建新 Attempt').task.status).toBe('review')
    expect(repository.load().tasks[implementation.id]?.attemptCount).toBe(1)
    expect(JSON.stringify(developer.listMine())).not.toContain('leaseToken')

    expect(qa.listReviews()).toEqual([
      expect.objectContaining({ task: expect.objectContaining({ id: implementation.id }) })
    ])
    const review = qa.claimReview(implementation.id)
    expect(review?.task.id).toBe(implementation.id)
    expect(JSON.stringify(review)).not.toContain('leaseToken')
    qa.renewReview(implementation.id, 120_000)
    expect(qa.submitReview(implementation.id, 'accept', '复跑测试并检查验收标准').status).toBe('done')
    expect(qa.submitReview(implementation.id, 'accept', '复跑测试并检查验收标准').status).toBe('done')
    expect(() => qa.submitReview(implementation.id, 'reject', '不同证据', '试图覆盖'))
      .toThrowError(/不能用不同结论覆盖/)
    expect(qa.listAvailable().map((task) => task.id)).toEqual([verification.id])
  })

  it('does not let another AgentSession operate an owned attempt', () => {
    const { repository, implementation } = plannedRepository()
    const owner = new TaskAgentService(repository, {
      agentSessionId: 'workspace:composer-dev:1',
      runId: 'run-1',
      capabilities: ['code']
    }, allowAllAgents)
    const intruder = new TaskAgentService(repository, {
      agentSessionId: 'workspace:composer-dev:2',
      runId: 'run-1',
      capabilities: ['code']
    }, allowAllAgents)
    owner.claim(implementation.id)
    owner.start(implementation.id)

    expect(() => intruder.report(implementation.id, 90, '伪造进度')).toThrowError(/没有匹配/)
    expect(repository.load().tasks[implementation.id]?.progress).toBe(0)
  })

  it('can resume through a new MCP process only when the bound identity is unchanged', () => {
    const { repository, implementation } = plannedRepository()
    const identity = {
      agentSessionId: 'workspace:composer-dev:7',
      runId: 'run-1',
      capabilities: ['code']
    }
    const firstProcess = new TaskAgentService(repository, identity, allowAllAgents)
    firstProcess.claim(implementation.id)

    const restartedProcess = new TaskAgentService(repository, identity, allowAllAgents)
    expect(restartedProcess.start(implementation.id).task.status).toBe('running')
  })

  it('rejects invalid process-bound identities before reading state', () => {
    const repository = new InMemoryTaskPoolRepository()
    expect(() => new TaskAgentService(repository, {
      agentSessionId: '../../escape',
      runId: 'run-1',
      capabilities: []
    }, allowAllAgents)).toThrowError(/agentSessionId）无效/)
  })

  it('re-checks authorization on every operation so a revoked process stops immediately', () => {
    const { repository } = plannedRepository()
    let active = true
    const service = new TaskAgentService(repository, {
      agentSessionId: 'workspace:composer-dev:9',
      runId: 'run-1',
      capabilities: ['code']
    }, {
      assertAgentAuthorized: () => {
        if (!active) throw new Error('revoked')
      }
    })

    expect(service.listAvailable()).toHaveLength(1)
    active = false
    expect(() => service.listAvailable()).toThrowError('revoked')
  })
})
