import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { TaskAgentService } from '../src/application/task-agent-service'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { InMemoryTaskPoolRepository } from '../src/infrastructure/task-pool/in-memory-task-pool-repository'
import { ChannelMessageService } from '../src/application/channel-message-service'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { createUnifiedChannelServer } from '../src/mcp/unified-channel-server'
import type { TeamCollaborationAgentService } from '../src/application/team-collaboration-agent-service'
import type { TeamMemoryAgentService } from '../src/application/team-memory-agent-service'

// S4 单服务器适配：固定运行时 + channel_id 由调用注入。
function createTaskMcpServer(
  service: TaskAgentService,
  _communication?: unknown,
  collaboration?: TeamCollaborationAgentService,
  memory?: TeamMemoryAgentService,
  opts: { exposeAllRoleTools?: boolean; refreshIdentity?: () => void } = {}
) {
  return createUnifiedChannelServer({
    runtimeFor: () => ({ service, collaboration, memory }),
    channelServiceFor: () => new ChannelMessageService(new SqliteChannelMessageRepository(':memory:')),
    refreshIdentity: opts.refreshIdentity ? () => opts.refreshIdentity!() : undefined
  })
}

const allowAllAgents = { assertAgentAuthorized: () => undefined }

describe('Qunshu task MCP', () => {
  it('keeps a standby runtime fenced until dynamic AgentSlot assignment is available', async () => {
    const repository = new InMemoryTaskPoolRepository()
    const [task] = transactTaskPool(repository, (pool) => pool.plan('run-1', [{
      key: 'standby-takeover', title: '接替后继续任务', requiredCapabilities: ['code']
    }]))
    const service = new TaskAgentService(repository, {
      agentSessionId: 'workspace:standby:1',
      runId: 'run-1',
      slotId: 'standby-slot:3',
      capabilities: ['coordination', 'planning', 'qa', 'code']
    }, allowAllAgents)
    let assigned = false
    const server = createTaskMcpServer(service, undefined, undefined, undefined, {
      exposeAllRoleTools: true,
      refreshIdentity: () => {
        if (!assigned) throw new Error('当前通道处于备用状态，尚未接替任何 AgentSlot')
        Object.assign(service.identity, { slotId: 'slot-builder', capabilities: ['code'] })
      }
    })
    const client = new Client({ name: 'qingtian-team-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const toolNames = (await client.listTools()).tools.map((tool) => tool.name)
      expect(toolNames).toHaveLength(37)
      expect(toolNames).toContain('record_process')
      const fenced = await client.callTool({ name: 'team_list_available', arguments: { channel_id: '1' } })
      expect(fenced).toMatchObject({ isError: true })
      expect(JSON.stringify(fenced)).toContain('备用状态')

      assigned = true
      const available = await client.callTool({ name: 'team_list_available', arguments: { channel_id: '1' } })
      expect(available.isError).not.toBe(true)
      expect(available.structuredContent).toMatchObject({
        tasks: [expect.objectContaining({ id: task!.id })]
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('uses an explicit check-in receipt as the only agent launch acknowledgement', async () => {
    const repository = new InMemoryTaskPoolRepository()
    const recordAgentCheckIn = vi.fn(() => ({
      workspaceId: 'workspace',
      runId: 'run-1',
      slotId: 'slot-lead',
      roleName: '主控协调',
      acknowledgedAt: 123
    }))
    const service = new TaskAgentService(repository, {
      agentSessionId: 'workspace:composer-dev:1',
      runId: 'run-1',
      capabilities: ['planning']
    }, allowAllAgents, { recordAgentCheckIn })
    const server = createTaskMcpServer(service)
    const client = new Client({ name: 'qingtian-team-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({
        name: 'team_check_in',
        arguments: { channel_id: '1',  note: '已读取目标与角色边界' }
      })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({
        receipt: { slotId: 'slot-lead', roleName: '主控协调', acknowledgedAt: 123 }
      })
      expect(recordAgentCheckIn).toHaveBeenCalledWith(
        expect.objectContaining({ agentSessionId: 'workspace:composer-dev:1', runId: 'run-1' }),
        '已读取目标与角色边界'
      )
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('executes the real agent workflow while keeping lease tokens server-side', async () => {
    const repository = new InMemoryTaskPoolRepository()
    const [task] = transactTaskPool(repository, (pool) => pool.plan('run-1', [
      {
        key: 'bridge',
        title: '实现 Bridge v1',
        description: '输出有序事件',
        acceptance: '重连可续传',
        requiredCapabilities: ['code']
      }
    ]))
    const service = new TaskAgentService(repository, {
      agentSessionId: 'workspace:composer-dev:1',
      runId: 'run-1',
      capabilities: ['code']
    }, allowAllAgents)
    const server = createTaskMcpServer(service, {
      channelId: '2',
      communicationServerName: 'qunshu'
    })
    const client = new Client({ name: 'qingtian-team-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const listed = await client.listTools()
      // S4 单服务器：团队基础工具 + 角色超集 + 协作/记忆 + 通信四工具
      const names = listed.tools.map((tool) => tool.name)
      for (const name of [
        'team_check_in', 'team_list_available', 'team_list_mine', 'team_get_task',
        'team_claim_task', 'team_start_task', 'team_renew_lease', 'team_report_progress',
        'team_submit_for_review', 'team_fail_task', 'check_messages', 'record_reply',
        'qingtian', 'wait_messages'
      ]) {
        expect(names).toContain(name)
      }

      const claim = await client.callTool({ name: 'team_claim_task', arguments: { channel_id: '1', taskId: task!.id } })
      expect(claim.isError).not.toBe(true)
      expect(JSON.stringify(claim)).not.toContain('leaseToken')

      await client.callTool({ name: 'team_start_task', arguments: { channel_id: '1', taskId: task!.id } })
      await client.callTool({
        name: 'team_report_progress',
        arguments: { channel_id: '1', taskId: task!.id, progress: 65, summary: '事件流已完成' }
      })
      await client.callTool({
        name: 'team_renew_lease',
        arguments: { channel_id: '1', taskId: task!.id, ttlSeconds: 120 }
      })
      const submit = await client.callTool({
        name: 'team_submit_for_review',
        arguments: { channel_id: '1', taskId: task!.id, output: '实现、测试与重连证据' }
      })
      expect(submit.isError).not.toBe(true)
      expect(submit.structuredContent).toMatchObject({
        nextAction: {
          type: 'enter_channel_wait',
          channelId: '1',
          communicationServer: 'qunshu'
        }
      })
      const submitJson = JSON.stringify(submit.structuredContent)
      expect(submitJson).toContain('qunshu.check_messages')
      expect(submitJson).toContain('isRetryable:false')
      expect(submitJson).toContain('禁止快速、并发或无限重试')
      expect(submitJson).toContain('工具返回后的静默待命动作')
      expect(submitJson).not.toContain('先用 qunshu.record_reply')
      expect(submitJson).not.toContain('保活/超时续期时静默继续')
      expect(repository.load().tasks[task!.id]).toMatchObject({
        status: 'review',
        progress: 100
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('directs an idle agent back to the paired communication wait loop', async () => {
    const repository = new InMemoryTaskPoolRepository()
    const service = new TaskAgentService(repository, {
      agentSessionId: 'workspace:composer-dev:1',
      runId: 'run-1',
      capabilities: []
    }, allowAllAgents)
    const server = createTaskMcpServer(service, {
      channelId: '2',
      communicationServerName: 'qunshu'
    })
    const client = new Client({ name: 'qingtian-team-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({ name: 'team_list_available', arguments: { channel_id: '1' } })
      expect(result.structuredContent).toMatchObject({
        tasks: [],
        nextAction: {
          type: 'enter_channel_wait',
          communicationServer: 'qunshu'
        }
      })
      const claim = await client.callTool({ name: 'team_claim_task', arguments: { channel_id: '1' } })
      expect(claim.structuredContent).toMatchObject({
        assignment: null,
        nextAction: { communicationServer: 'qunshu' }
      })
      expect(JSON.stringify(claim.structuredContent)).not.toContain('先用 qunshu.record_reply')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('exposes independent review tools only to QA and completes the task without leaking review tokens', async () => {
    const repository = new InMemoryTaskPoolRepository()
    const [task] = transactTaskPool(repository, (pool) => pool.plan('run-1', [{
      key: 'reviewed-work', title: '需要独立验收的实现'
    }]))
    const developerService = new TaskAgentService(repository, {
      agentSessionId: 'workspace:composer-dev:review',
      runId: 'run-1',
      slotId: 'slot-dev',
      capabilities: ['code']
    }, allowAllAgents)
    const reviewerService = new TaskAgentService(repository, {
      agentSessionId: 'workspace:composer-qa:review',
      runId: 'run-1',
      slotId: 'slot-qa',
      capabilities: ['qa']
    }, allowAllAgents)
    const developerServer = createTaskMcpServer(developerService)
    const reviewerServer = createTaskMcpServer(reviewerService)
    const developer = new Client({ name: 'developer', version: '1.0.0' })
    const reviewer = new Client({ name: 'reviewer', version: '1.0.0' })
    const [developerClientTransport, developerServerTransport] = InMemoryTransport.createLinkedPair()
    const [reviewerClientTransport, reviewerServerTransport] = InMemoryTransport.createLinkedPair()
    await developerServer.connect(developerServerTransport)
    await reviewerServer.connect(reviewerServerTransport)
    await developer.connect(developerClientTransport)
    await reviewer.connect(reviewerClientTransport)
    try {
      // S4 单服务器暴露角色超集；权限按每次调用的能力围栏收口
      expect((await developer.listTools()).tools.map((tool) => tool.name)).toContain('team_claim_review')
      expect((await reviewer.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'team_list_reviews',
        'team_claim_review',
        'team_renew_review',
        'team_submit_review'
      ]))

      await developer.callTool({ name: 'team_claim_task', arguments: { channel_id: '1', taskId: task!.id } })
      await developer.callTool({ name: 'team_start_task', arguments: { channel_id: '1', taskId: task!.id } })
      await developer.callTool({
        name: 'team_submit_for_review',
        arguments: { channel_id: '1', taskId: task!.id, output: '实现与测试证据' }
      })
      const fencedReview = await developer.callTool({
        name: 'team_claim_review',
        arguments: { channel_id: '1', taskId: task!.id }
      })
      expect(fencedReview.isError).toBe(true)
      const listed = await reviewer.callTool({ name: 'team_list_reviews', arguments: { channel_id: '1' } })
      expect(listed.structuredContent).toMatchObject({
        reviews: [expect.objectContaining({ task: expect.objectContaining({ id: task!.id }) })]
      })
      const claimed = await reviewer.callTool({
        name: 'team_claim_review',
        arguments: { channel_id: '1', taskId: task!.id }
      })
      expect(claimed.isError).not.toBe(true)
      expect(JSON.stringify(claimed)).not.toContain('leaseToken')
      const completed = await reviewer.callTool({
        name: 'team_submit_review',
        arguments: { channel_id: '1', 
          taskId: task!.id,
          decision: 'accept',
          evidence: '重新运行测试并核对失败路径，结果通过'
        }
      })
      expect(completed.structuredContent).toMatchObject({ task: { status: 'done' } })
    } finally {
      await developer.close()
      await reviewer.close()
      await developerServer.close()
      await reviewerServer.close()
    }
  })

  it('returns structured MCP errors instead of throwing protocol failures', async () => {
    const repository = new InMemoryTaskPoolRepository()
    const service = new TaskAgentService(repository, {
      agentSessionId: 'workspace:composer-dev:1',
      runId: 'run-1',
      capabilities: []
    }, allowAllAgents)
    const server = createTaskMcpServer(service)
    const client = new Client({ name: 'qingtian-team-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({
        name: 'team_report_progress',
        arguments: { channel_id: '1',  progress: 50, summary: '没有任务却汇报' }
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        ok: false,
        code: 'active_attempt_not_found'
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('requeues a failed attempt and stops after maxAttempts through MCP tools', async () => {
    const repository = new InMemoryTaskPoolRepository()
    const [task] = transactTaskPool(repository, (pool) => pool.plan('run-1', [
      { key: 'retry', title: '验证失败预算', maxAttempts: 2 }
    ]))
    const service = new TaskAgentService(repository, {
      agentSessionId: 'workspace:composer-dev:1',
      runId: 'run-1',
      capabilities: []
    }, allowAllAgents)
    const server = createTaskMcpServer(service)
    const client = new Client({ name: 'qingtian-team-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      for (const reason of ['第一次失败', '第二次失败']) {
        await client.callTool({ name: 'team_claim_task', arguments: { channel_id: '1', taskId: task!.id } })
        await client.callTool({ name: 'team_start_task', arguments: { channel_id: '1', taskId: task!.id } })
        await client.callTool({ name: 'team_fail_task', arguments: { channel_id: '1', taskId: task!.id, reason } })
      }
      expect(repository.load().tasks[task!.id]).toMatchObject({
        status: 'failed',
        attemptCount: 2,
        failureReason: '第二次失败'
      })
      expect(Object.values(repository.load().attempts).map((attempt) => attempt.status)).toEqual([
        'failed',
        'failed'
      ])
    } finally {
      await client.close()
      await server.close()
    }
  })
})
