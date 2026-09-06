import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { TaskAgentService } from '../src/application/task-agent-service'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { InMemoryTaskPoolRepository } from '../src/infrastructure/task-pool/in-memory-task-pool-repository'
import { ChannelMessageService } from '../src/application/channel-message-service'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { createUnifiedChannelServer } from '../src/mcp/unified-channel-server'
import { TEAM_TOOL_NAMES } from '../src/mcp/team-tools'
import type { TeamCollaborationAgentService } from '../src/application/team-collaboration-agent-service'
import type { TeamMemoryAgentService } from '../src/application/team-memory-agent-service'
import { TaskPoolError } from '../src/domain/task-pool'

// S4 单服务器适配：固定运行时 + channel_id 由调用注入。
function createTaskMcpServer(
  service: TaskAgentService,
  _communication?: unknown,
  collaboration?: TeamCollaborationAgentService,
  memory?: TeamMemoryAgentService,
  opts: { refreshIdentity?: () => void } = {}
) {
  return createUnifiedChannelServer({
    runtimeFor: () => ({ service, collaboration, memory }),
    channelServiceFor: () => new ChannelMessageService(new SqliteChannelMessageRepository(':memory:')),
    refreshIdentity: opts.refreshIdentity ? () => opts.refreshIdentity!() : undefined
  })
}

const allowAllAgents = { assertAgentAuthorized: () => undefined }

describe('SG Team task MCP', () => {

  it('returns solo_channel for every team tool while communication tools remain usable', async () => {
    const repository = new InMemoryTaskPoolRepository()
    const service = new TaskAgentService(repository, {
      agentSessionId: 'solo:ch-8', runId: 'run-1', capabilities: []
    }, allowAllAgents)
    const channelRepository = new SqliteChannelMessageRepository(':memory:')
    const channelService = new ChannelMessageService(channelRepository)
    const server = createUnifiedChannelServer({
      runtimeFor: () => ({ service }),
      channelServiceFor: () => channelService,
      refreshIdentity: () => { throw new TaskPoolError('solo_channel', '独立席位不参与团队协作') },
      keepaliveTimeoutMs: 10
    })
    const client = new Client({ name: 'solo-boundary-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const denied = await client.callTool({ name: 'team_check_in', arguments: { channel_id: '8' } })
      expect(denied.isError).toBe(true)
      expect(denied.structuredContent).toMatchObject({ ok: false, code: 'solo_channel' })

      channelRepository.enqueueOutbound('8', '独立任务：审查这个模块', 1)
      const message = await client.callTool({ name: 'check_messages', arguments: { channel_id: '8' } })
      expect(message.isError).not.toBe(true)
      expect(JSON.stringify(message.content)).toContain('独立任务：审查这个模块')
      const reply = await client.callTool({
        name: 'record_reply', arguments: { channel_id: '8', content: '独立审查已完成' }
      })
      expect(reply.isError).not.toBe(true)
      expect(channelRepository.listUnconsumedReplies().map((item) => item.content)).toEqual(['独立审查已完成'])
    } finally {
      await client.close()
      await server.close()
      channelRepository.close()
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
    const client = new Client({ name: 'sg-team-test', version: '1.0.0' })
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


  it('directs an idle agent back to the paired communication wait loop', async () => {
    const repository = new InMemoryTaskPoolRepository()
    const service = new TaskAgentService(repository, {
      agentSessionId: 'workspace:composer-dev:1',
      runId: 'run-1',
      capabilities: []
    }, allowAllAgents)
    const server = createTaskMcpServer(service, {
      channelId: '2',
      communicationServerName: 'SG Team'
    })
    const client = new Client({ name: 'sg-team-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({ name: 'team_tasks', arguments: { channel_id: '1', view: 'available' } })
      expect(result.structuredContent).toMatchObject({
        view: 'available',
        tasks: [],
        nextAction: {
          type: 'enter_channel_wait',
          communicationServer: 'SG Team'
        }
      })
      const claim = await client.callTool({ name: 'team_task', arguments: { channel_id: '1', action: 'claim' } })
      expect(claim.structuredContent).toMatchObject({
        assignment: null,
        nextAction: { communicationServer: 'SG Team' }
      })
      expect(JSON.stringify(claim.structuredContent)).not.toContain('先用 SG Team.record_reply')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('exposes nine tools in total and completes an independent review without leaking review tokens', async () => {
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
      // 单服务器暴露角色超集（7 个团队工具 + 2 个通信工具）；权限按每次调用的能力围栏收口
      const toolNames = (await developer.listTools()).tools.map((tool) => tool.name).sort()
      expect(toolNames).toEqual(['check_messages', 'record_reply', ...TEAM_TOOL_NAMES].sort())
      expect(toolNames).toHaveLength(9)
      expect((await reviewer.listTools()).tools.map((tool) => tool.name)).toContain('team_review')

      await developer.callTool({ name: 'team_task', arguments: { channel_id: '1', action: 'claim', taskId: task!.id } })
      await developer.callTool({ name: 'team_task', arguments: { channel_id: '1', action: 'start', taskId: task!.id } })
      await developer.callTool({
        name: 'team_task',
        arguments: { channel_id: '1', action: 'submit', taskId: task!.id, output: '实现与测试证据' }
      })
      const fencedReview = await developer.callTool({
        name: 'team_review',
        arguments: { channel_id: '1', action: 'claim', taskId: task!.id }
      })
      expect(fencedReview.isError).toBe(true)
      const listed = await reviewer.callTool({ name: 'team_tasks', arguments: { channel_id: '1', view: 'reviews' } })
      expect(listed.structuredContent).toMatchObject({
        reviews: [expect.objectContaining({ task: expect.objectContaining({ id: task!.id }) })]
      })
      const claimed = await reviewer.callTool({
        name: 'team_review',
        arguments: { channel_id: '1', action: 'claim', taskId: task!.id }
      })
      expect(claimed.isError).not.toBe(true)
      expect(JSON.stringify(claimed)).not.toContain('leaseToken')
      const completed = await reviewer.callTool({
        name: 'team_review',
        arguments: { channel_id: '1',
          action: 'submit',
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
    const client = new Client({ name: 'sg-team-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({
        name: 'team_task',
        arguments: { channel_id: '1', action: 'progress', progress: 50, summary: '没有任务却汇报' }
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        ok: false,
        code: 'active_attempt_not_found'
      })
      // 动作级必填参数缺失：指向具体 action 的结构化错误，而不是协议异常。
      const missing = await client.callTool({ name: 'team_task', arguments: { channel_id: '1', action: 'submit' } })
      expect(missing.isError).toBe(true)
      expect(missing.structuredContent).toMatchObject({ ok: false, code: 'invalid_arguments' })
      expect(String((missing.structuredContent as { message: string }).message)).toContain('output')
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
    const client = new Client({ name: 'sg-team-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      for (const reason of ['第一次失败', '第二次失败']) {
        await client.callTool({ name: 'team_task', arguments: { channel_id: '1', action: 'claim', taskId: task!.id } })
        await client.callTool({ name: 'team_task', arguments: { channel_id: '1', action: 'start', taskId: task!.id } })
        await client.callTool({ name: 'team_task', arguments: { channel_id: '1', action: 'fail', taskId: task!.id, reason } })
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
