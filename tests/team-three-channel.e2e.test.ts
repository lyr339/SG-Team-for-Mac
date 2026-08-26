import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { ChannelMessageRelay } from '../src/application/channel-message-relay'
import { ChannelMessageService } from '../src/application/channel-message-service'
import { LocalSessionBridge } from '../src/application/local-session-bridge'
import { MemoryReviewCoordinator } from '../src/application/memory-review-coordinator'
import { TaskAgentService } from '../src/application/task-agent-service'
import { TaskDispatcher } from '../src/application/task-dispatcher'
import { TaskPoolService } from '../src/application/task-pool-service'
import { TeamCollaborationAgentService } from '../src/application/team-collaboration-agent-service'
import { TeamControlService } from '../src/application/team-control-service'
import { TeamMemoryAgentService } from '../src/application/team-memory-agent-service'
import { TeamMemoryService } from '../src/application/team-memory-service'
import { TeamMessageDispatcher } from '../src/application/team-message-dispatcher'
import { TeamOrchestrator } from '../src/application/team-orchestrator'
import { createDefaultTeamBundle } from '../src/domain/team-control'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'
import { createUnifiedChannelServer } from '../src/mcp/unified-channel-server'

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function callOk(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true)
  return result
}

interface ConnectedAgent {
  client: Client
  server: McpServer
  channelId: string
}

describe('three-channel autonomous team end to end', () => {
  it('launches, plans, implements, independently reviews, and governs memory across CH-1/2/3', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-three-channel-')), 'team.sqlite3')
    const controlRepository = new SqliteTeamControlRepository(path)
    const bundle = createDefaultTeamBundle({
      workspaceId: 'alpha',
      workspaceName: 'alpha',
      workspacePath: '/workspace/alpha',
      channelIds: ['1', '2', '3'],
      runKey: 'run-three-channel',
      now: 100
    })
    controlRepository.upsertWorkspaceTeam(bundle)
    controlRepository.updateRunGoal(bundle.run.id, '交付一个由实现与质量角色共同完成的可靠功能')
    controlRepository.recordInstallation({
      workspaceId: bundle.workspace.id,
      runId: bundle.run.id,
      generation: 'generation123',
      agents: bundle.slots.map((slot) => ({
        agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
        workspaceId: bundle.workspace.id,
        channelId: slot.channelId!,
        generation: 'generation123',
        runId: bundle.run.id,
        capabilities: bundle.roles.find((role) => role.id === slot.roleId)!.capabilities
      }))
    })
    const taskRepository = new SqliteTaskPoolRepository(path)
    const collaboration = new SqliteTeamCollaborationRepository(path)
    const memoryRepository = new SqliteTeamMemoryRepository(path)
    const channelRepository = new SqliteChannelMessageRepository(path)
    for (const channelId of ['1', '2', '3']) {
      channelRepository.markChannelEmbedded(channelId, bundle.workspace.id, '/workspace/alpha')
      // 模拟各通道内嵌 MCP 在岗（presence 即活性证据），等价原插件 WS 状态投影
      channelRepository.touchPresence(channelId, {
        waiting: true,
        connectionPhase: 'waiting',
        lastSeenAt: Date.now()
      })
    }
    const relay = new ChannelMessageRelay(channelRepository)
    const bridge = new LocalSessionBridge(relay)
    const team = new TeamControlService(controlRepository, bridge)
    const tasks = new TaskPoolService(taskRepository, team)
    const memory = new TeamMemoryService(memoryRepository, team)
    const messageDispatcher = new TeamMessageDispatcher(collaboration, bridge, team)
    const taskDispatcher = new TaskDispatcher(tasks, team, collaboration)
    const memoryCoordinator = new MemoryReviewCoordinator(memory, team, collaboration)
    const orchestrator = new TeamOrchestrator(
      team,
      tasks,
      collaboration,
      taskDispatcher,
      memoryCoordinator
    )
    const role = (key: string) => bundle.roles.find((candidate) => candidate.key === key)!
    const slot = (key: string) => bundle.slots.find((candidate) => candidate.roleId === role(key).id)!
    const identity = (key: string) => ({
      agentSessionId: `alpha:ch-${slot(key).channelId}:generation123`,
      runId: bundle.run.id,
      slotId: slot(key).id,
      capabilities: [...role(key).capabilities]
    })
    const agents: ConnectedAgent[] = []
    const connectAgent = async (key: string): Promise<ConnectedAgent> => {
      const currentIdentity = identity(key)
      const taskService = new TaskAgentService(
        taskRepository,
        currentIdentity,
        taskRepository,
        controlRepository
      )
      const coordination = new TeamCollaborationAgentService(
        collaboration,
        currentIdentity,
        taskService
      )
      const agentMemory = new TeamMemoryAgentService(memoryRepository, collaboration, currentIdentity)
      const server = createUnifiedChannelServer({
        runtimeFor: () => ({ service: taskService, collaboration: coordination, memory: agentMemory }),
        channelServiceFor: () => new ChannelMessageService(channelRepository)
      })
      const client = new Client({ name: `agent-${key}`, version: '1.0.0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const connected = { client, server, channelId: slot(key).channelId! }
      agents.push(connected)
      return connected
    }
    const callFor = (agent: { client: Client; channelId: string }) =>
      (name: string, args: Record<string, unknown> = {}) =>
        callOk(agent.client, name, { channel_id: agent.channelId, ...args })
    const outboxTexts = (channelId: string): string[] =>
      channelRepository.listPendingOutbound(channelId).map((message) => message.text)
    const allOutboxTexts = (): string[] => ['1', '2', '3'].flatMap((channelId) => outboxTexts(channelId))

    try {
      await waitFor(() => team.getSnapshot().preflight.canLaunch)
      const lead = await connectAgent('lead')
      const builder = await connectAgent('builder')
      const reviewer = await connectAgent('reviewer')
      const leadCall = callFor(lead)
      const builderCall = callFor(builder)
      const reviewerCall = callFor(reviewer)
      messageDispatcher.start(250)
      orchestrator.start()

      await team.launch()
      expect(allOutboxTexts().filter((text) => text.includes('系统规划调度'))).toHaveLength(0)
      await leadCall('team_check_in', { note: '主控已读取目标' })
      await builderCall('team_check_in', { note: '实现席已读取边界' })
      await reviewerCall('team_check_in', { note: '质量席已读取验收边界' })
      expect(team.getSnapshot().activeRun?.status).toBe('running')

      orchestrator.reconcile()
      messageDispatcher.dispatchPending()
      expect(Object.values(collaboration.loadRun(bundle.run.id).messages)
        .some((message) => message.clientMessageId.includes(':planning:'))).toBe(false)
      const planningMessage = collaboration.createMessage({
        runId: bundle.run.id,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: slot('lead').id },
        kind: 'directive',
        subject: '用户要求开始执行',
        content: '【用户明确指令】请根据团队目标开始拆分并分配任务。',
        clientMessageId: 'operator:user-start-planning'
      })
      messageDispatcher.dispatchPending()
      await waitFor(() => outboxTexts('1').some((text) => text.includes(planningMessage.id)))
      await leadCall('team_read_message', { messageId: planningMessage.id })
      const planned = await leadCall('team_plan_tasks', {
        tasks: [{
          key: 'feature',
          title: '实现可靠功能',
          description: '实现功能并留下完整测试证据',
          acceptance: '构建通过、测试通过、失败路径有证据',
          targetSlotId: slot('builder').id,
          requiredCapabilities: ['code']
        }]
      })
      const taskId = (planned.structuredContent as { tasks?: Array<{ id?: string }> }).tasks?.[0]?.id
      expect(taskId).toMatch(/^task-/)
      await leadCall('team_respond_message', {
        messageId: planningMessage.id,
        content: '已建立 1 条实现任务，完成后交给质量席独立验收。',
        clientMessageId: 'lead-planning-response-01'
      })

      tasks.pollExternalChanges()
      orchestrator.reconcile()
      messageDispatcher.dispatchPending()
      const implementationMessage = Object.values(collaboration.loadRun(bundle.run.id).messages)
        .find((message) => message.clientMessageId.includes(':task:'))!
      await waitFor(() => implementationMessage
        && outboxTexts('2').some((text) => text.includes(implementationMessage.id)))
      await builderCall('team_read_message', { messageId: implementationMessage.id })
      await builderCall('team_claim_task', { taskId })
      await builderCall('team_start_task', { taskId })
      await builderCall('team_report_progress', {
        taskId,
        progress: 90,
        summary: '实现与测试完成'
      })
      await builderCall('team_submit_for_review', {
        taskId,
        output: '生产构建成功；单元测试与错误路径测试全部通过。'
      })
      await builderCall('team_respond_message', {
        messageId: implementationMessage.id,
        content: '实现已完成并提交独立验收。',
        clientMessageId: 'builder-task-response-01'
      })

      tasks.pollExternalChanges()
      orchestrator.reconcile()
      messageDispatcher.dispatchPending()
      const reviewMessage = Object.values(collaboration.loadRun(bundle.run.id).messages)
        .find((message) => message.clientMessageId.includes(':review:'))!
      await waitFor(() => reviewMessage
        && outboxTexts('3').some((text) => text.includes(reviewMessage.id)))
      await reviewerCall('team_read_message', { messageId: reviewMessage.id })
      await reviewerCall('team_claim_review', { taskId })
      await reviewerCall('team_submit_review', {
        taskId,
        decision: 'accept',
        evidence: '重新运行构建、单测和失败路径检查，所有验收标准通过。'
      })
      await reviewerCall('team_respond_message', {
        messageId: reviewMessage.id,
        content: '独立验收通过，证据已写入 Review。',
        clientMessageId: 'reviewer-task-response-01'
      })
      expect(taskRepository.load().tasks[taskId!]).toMatchObject({ status: 'done' })

      const proposal = await builderCall('team_memory_propose', {
        scope: 'run',
        kind: 'lesson',
        title: '独立验收必须保留证据',
        content: '实现结论不能直接作为完成依据，必须由质量角色复跑并提交证据。',
        sources: [{ type: 'task', ref: taskId, label: '可靠功能任务' }],
        clientProposalId: 'builder-e2e-memory-01'
      })
      const memoryId = (proposal.structuredContent as { memory?: { id?: string } }).memory?.id
      expect(memoryId).toMatch(/^team-memory:/)
      memoryCoordinator.reconcile()
      messageDispatcher.dispatchPending()
      const memoryMessage = Object.values(collaboration.loadRun(bundle.run.id).messages)
        .find((message) => message.clientMessageId.includes(':memory:'))!
      await waitFor(() => memoryMessage
        && outboxTexts('1').some((text) => text.includes(memoryMessage.id)))
      await leadCall('team_read_message', { messageId: memoryMessage.id })
      await leadCall('team_memory_review', {
        memoryId,
        decision: 'accept',
        note: '任务和独立验收证据完整'
      })
      await leadCall('team_respond_message', {
        messageId: memoryMessage.id,
        content: '运行级经验已审核采纳。',
        clientMessageId: 'lead-memory-response-01'
      })

      expect(memoryRepository.load(bundle.workspace.id, bundle.run.id).items[memoryId!])
        .toMatchObject({ status: 'accepted', reviewedBy: { type: 'agent', slotId: slot('lead').id } })
      const builderContext = await builderCall('team_get_context')
      expect(builderContext.structuredContent).toMatchObject({
        context: { memory: { itemCount: 1 } }
      })
      const collaborationSnapshot = collaboration.loadRun(bundle.run.id)
      for (const message of [planningMessage, implementationMessage, reviewMessage, memoryMessage]) {
        expect(collaborationSnapshot.messages[message.id]?.receipt.respondedAt).toBeDefined()
      }
      expect(new Set(['1', '2', '3'].filter((channelId) => outboxTexts(channelId).length > 0)))
        .toEqual(new Set(['1', '2', '3']))
    } finally {
      orchestrator.stop()
      messageDispatcher.dispose()
      memory.dispose()
      team.dispose()
      bridge.dispose()
      relay.stop()
      for (const agent of agents) {
        await agent.client.close()
        await agent.server.close()
      }
      memoryRepository.close()
      collaboration.close()
      taskRepository.close()
      channelRepository.close()
      controlRepository.close()
    }
  })
})
