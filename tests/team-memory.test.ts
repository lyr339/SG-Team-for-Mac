import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamMemoryAgentService } from '../src/application/team-memory-agent-service'
import { TeamMemoryService } from '../src/application/team-memory-service'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { createDefaultTeamBundle, type TeamControlSnapshot } from '../src/domain/team-control'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-memory-')), 'team.sqlite3')
  const team = new SqliteTeamControlRepository(path)
  const bundle = createDefaultTeamBundle({
    workspaceId: 'alpha',
    workspaceName: 'alpha',
    workspacePath: '/workspace/alpha',
    channelIds: ['1', '2', '3'],
    now: 100
  })
  team.upsertWorkspaceTeam(bundle)
  team.recordInstallation({
    workspaceId: 'alpha',
    runId: bundle.run.id,
    generation: 'generation123',
    agents: bundle.slots.map((slot) => ({
      agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
      workspaceId: 'alpha',
      channelId: slot.channelId!,
      generation: 'generation123',
      runId: bundle.run.id,
      capabilities: bundle.roles.find((role) => role.id === slot.roleId)!.capabilities
    }))
  })
  const tasks = new SqliteTaskPoolRepository(path)
  const [task] = transactTaskPool(tasks, (pool) => pool.plan(bundle.run.id, [{
    key: 'gateway',
    title: '重构鉴权网关'
  }]))
  const collaboration = new SqliteTeamCollaborationRepository(path)
  const role = (key: string) => bundle.roles.find((candidate) => candidate.key === key)!
  const slot = (key: string) => bundle.slots.find((candidate) => candidate.roleId === role(key).id)!
  const message = collaboration.createMessage({
    runId: bundle.run.id,
    sender: { type: 'agent', slotId: slot('lead').id },
    recipient: { type: 'agent', slotId: slot('builder').id },
    kind: 'directive',
    content: '认证统一由网关层负责。',
    clientMessageId: 'memory-source-message-01'
  })
  const memory = new SqliteTeamMemoryRepository(path)
  const identity = (key: string) => ({
    agentSessionId: `alpha:ch-${slot(key).channelId}:generation123`,
    runId: bundle.run.id,
    slotId: slot(key).id,
    capabilities: [...role(key).capabilities]
  })
  const agent = (key: string) => new TeamMemoryAgentService(memory, collaboration, identity(key))
  return { team, tasks, collaboration, memory, bundle, task: task!, message, role, slot, agent }
}

describe('SG Team governed memory', () => {
  it('grants run-memory review to the acting lead after real authority transfer', () => {
    const data = fixture()
    try {
      data.team.updateRunGoal(data.bundle.run.id, '验证临时主控记忆权限')
      data.team.beginLaunch(data.bundle.run.id, 200, 'binding-key-memory-lead')
      data.team.setActingLead({ runId: data.bundle.run.id, slotId: data.slot('builder').id, at: 300 })
      const reviewer = data.agent('reviewer')
      const actingIdentity = data.team.resolveAgentRuntimeIdentity(
        `alpha:ch-${data.slot('builder').channelId}:generation123`, data.bundle.run.id
      )
      const demotedIdentity = data.team.resolveAgentRuntimeIdentity(
        `alpha:ch-${data.slot('lead').channelId}:generation123`, data.bundle.run.id
      )
      const actingLead = new TeamMemoryAgentService(
        data.memory, data.collaboration, { ...actingIdentity, slotId: actingIdentity.slotId! }
      )
      const demotedLead = new TeamMemoryAgentService(
        data.memory, data.collaboration, { ...demotedIdentity, slotId: demotedIdentity.slotId! }
      )
      const proposal = reviewer.propose({
        scope: 'run', kind: 'decision', title: '交接后的决策', content: '由临时主控审核。',
        sources: [{ type: 'task', ref: data.task.id, label: '现有任务' }],
        clientProposalId: 'acting-lead-memory-review'
      })

      expect(actingLead.canReview()).toBe(true)
      expect(actingLead.search({ includeProposed: true })).toEqual([
        expect.objectContaining({ id: proposal.id })
      ])
      expect(actingLead.review({ memoryId: proposal.id, decision: 'accept' })).toMatchObject({
        status: 'accepted', reviewedBy: { type: 'agent', slotId: data.slot('builder').id }
      })
      expect(demotedLead.canReview()).toBe(false)
    } finally {
      data.memory.close()
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })

  it('keeps a sourced proposal out of context until an independent reviewer accepts it', () => {
    const data = fixture()
    try {
      const lead = data.agent('lead')
      const reviewer = data.agent('reviewer')
      const builder = data.agent('builder')
      const proposal = lead.propose({
        scope: 'run',
        kind: 'decision',
        title: '认证统一由网关层负责',
        content: '统一鉴权令牌校验由网关层完成，服务不再进行重复校验。',
        sources: [
          { type: 'message', ref: data.message.id, label: '主控给实现席的协作指令' },
          { type: 'task', ref: data.task.id, label: '重构鉴权网关' },
          { type: 'file', ref: 'docs/auth/gateway.md', label: '网关设计文档' }
        ],
        clientProposalId: 'lead-memory-proposal-01'
      })

      expect(proposal.status).toBe('proposed')
      expect(builder.contextBrief()).toMatchObject({ itemCount: 0 })
      expect(() => lead.review({ memoryId: proposal.id, decision: 'accept' }))
        .toThrowError(/不能由提出者自行确认/)
      expect(reviewer.search({ includeProposed: true })).toEqual([
        expect.objectContaining({ id: proposal.id, status: 'proposed' })
      ])

      const accepted = reviewer.review({
        memoryId: proposal.id,
        decision: 'accept',
        note: '来源与失败路径验证充分'
      })
      expect(accepted).toMatchObject({ status: 'accepted', reviewedBy: { type: 'agent', slotId: data.slot('reviewer').id } })
      expect(builder.contextBrief()).toMatchObject({
        itemCount: 1,
        items: [expect.objectContaining({ title: '认证统一由网关层负责' })]
      })
    } finally {
      data.memory.close()
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })

  it('accepts a sourced revision atomically and removes the superseded item from default search', () => {
    const data = fixture()
    try {
      const builder = data.agent('builder')
      const reviewer = data.agent('reviewer')
      const lead = data.agent('lead')
      const original = builder.propose({
        scope: 'run',
        kind: 'constraint',
        title: '接口兼容性必须保留',
        content: '旧接口必须继续兼容一个发布周期。',
        sources: [{ type: 'task', ref: data.task.id, label: '网关重构任务' }],
        clientProposalId: 'builder-memory-original-01'
      })
      lead.review({ memoryId: original.id, decision: 'accept' })

      const revision = builder.propose({
        scope: 'run',
        kind: 'constraint',
        title: '接口兼容性保留两个发布周期',
        content: '旧接口兼容窗口调整为两个发布周期，并在第二周期输出迁移告警。',
        sources: [{ type: 'file', ref: 'docs/api/migration.md', label: '迁移计划' }],
        supersedesId: original.id,
        clientProposalId: 'builder-memory-revision-01'
      })
      reviewer.review({ memoryId: revision.id, decision: 'accept' })

      const snapshot = data.memory.load('alpha', data.bundle.run.id)
      expect(snapshot.items[original.id]).toMatchObject({
        status: 'superseded',
        supersededById: revision.id
      })
      expect(snapshot.items[revision.id]).toMatchObject({
        status: 'accepted',
        version: 2,
        supersedesId: original.id
      })
      expect(data.memory.search({
        workspaceId: 'alpha',
        runId: data.bundle.run.id
      }).map((item) => item.id)).toEqual([revision.id])
    } finally {
      data.memory.close()
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })

  it('lets the operator review any proposal with full authority and pushes the update', () => {
    const data = fixture()
    try {
      const teamSource = {
        getSnapshot: () => ({
          activeWorkspaceId: 'alpha',
          activeRun: data.bundle.run
        } as TeamControlSnapshot),
        subscribe: () => () => {}
      }
      const service = new TeamMemoryService(data.memory, teamSource)
      const proposal = data.agent('lead').propose({
        scope: 'run',
        kind: 'decision',
        title: '发布窗口固定在周四',
        content: '所有生产发布固定在周四上午，避开周五回滚风险。',
        sources: [{ type: 'task', ref: data.task.id, label: '网关重构任务' }],
        clientProposalId: 'lead-memory-operator-01'
      })

      // 操作员仍可处理异常升级，但正常流程由 Agent 独立审核。
      const accepted = service.review(proposal.id, 'accept', '人工确认')
      expect(accepted).toMatchObject({
        status: 'accepted',
        reviewedBy: { type: 'operator' },
        reviewNote: '人工确认'
      })
      expect(service.getSnapshot().items[proposal.id]).toMatchObject({ status: 'accepted' })

      // 已处理的提案不能重复审核。
      expect(() => service.review(proposal.id, 'reject')).toThrowError(/待确认/)
      service.dispose()
    } finally {
      data.memory.close()
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })

  it('rejects unsourced memories and workspace escape paths', () => {
    const data = fixture()
    try {
      expect(() => data.agent('builder').propose({
        scope: 'run',
        kind: 'fact',
        title: '没有来源',
        content: '不应被接受',
        sources: [],
        clientProposalId: 'builder-memory-nosource-01'
      })).toThrowError(/必须包含 1 到 20 个来源/)
      expect(() => data.agent('builder').propose({
        scope: 'run',
        kind: 'risk',
        title: '越界文件',
        content: '不允许引用工作区外文件',
        sources: [{ type: 'file', ref: '../secret.txt', label: '越界' }],
        clientProposalId: 'builder-memory-escape-01'
      })).toThrowError(/工作区内相对路径/)
    } finally {
      data.memory.close()
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })
})
