import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { TaskAgentService } from '../src/application/task-agent-service'
import { TeamCollaborationAgentService } from '../src/application/team-collaboration-agent-service'
import type { TeamMemoryAgentService } from '../src/application/team-memory-agent-service'
import { createDefaultTeamBundle } from '../src/domain/team-control'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { ChannelMessageService } from '../src/application/channel-message-service'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { createUnifiedChannelServer } from '../src/mcp/unified-channel-server'

function createTaskMcpServer(
  taskService: TaskAgentService,
  _communication?: unknown,
  coordination?: TeamCollaborationAgentService,
  memory?: TeamMemoryAgentService
) {
  return createUnifiedChannelServer({
    runtimeFor: () => ({ service: taskService, collaboration: coordination, memory }),
    channelServiceFor: () => new ChannelMessageService(new SqliteChannelMessageRepository(':memory:'))
  })
}

describe('Qunshu collaboration MCP', () => {
  it('moves a lead directive through inbox, read and correlated response tools', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-collab-mcp-')), 'team.sqlite3')
    const team = new SqliteTeamControlRepository(path)
    const bundle = createDefaultTeamBundle({
      workspaceId: 'alpha',
      workspaceName: 'alpha',
      workspacePath: '/workspace/alpha',
      channelIds: ['1', '2'],
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
    const collaboration = new SqliteTeamCollaborationRepository(path)
    const slot = (key: string) => {
      const role = bundle.roles.find((candidate) => candidate.key === key)!
      return bundle.slots.find((candidate) => candidate.roleId === role.id)!
    }
    const identity = (key: string) => {
      const role = bundle.roles.find((candidate) => candidate.key === key)!
      const currentSlot = slot(key)
      return {
        agentSessionId: `alpha:ch-${currentSlot.channelId}:generation123`,
        runId: bundle.run.id,
        slotId: currentSlot.id,
        capabilities: [...role.capabilities]
      }
    }
    const connect = async (key: string) => {
      const currentIdentity = identity(key)
      const taskService = new TaskAgentService(tasks, currentIdentity, tasks, team)
      const coordination = new TeamCollaborationAgentService(
        collaboration,
        currentIdentity,
        taskService
      )
      const server = createTaskMcpServer(taskService, undefined, coordination)
      const client = new Client({ name: `collab-${key}`, version: '1.0.0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      return { client, server }
    }

    const lead = await connect('lead')
    const builder = await connect('builder')
    try {
      const leadTools = (await lead.client.listTools()).tools.map((tool) => tool.name)
      const builderTools = (await builder.client.listTools()).tools.map((tool) => tool.name)
      expect(leadTools).toContain('team_plan_tasks')
      expect(leadTools).toContain('team_list_board')
      expect(leadTools).toContain('team_broadcast')
      expect(leadTools).toContain('team_collect_responses')
      // S4 单服务器暴露超集；主控专用工具对实现席按调用围栏拒绝
      expect(builderTools).toContain('team_plan_tasks')
      const fencedPlan = await builder.client.callTool({
        name: 'team_plan_tasks',
        arguments: { channel_id: '1', tasks: [{ key: 'x', title: '越权规划' }] }
      })
      expect(fencedPlan.isError).toBe(true)

      const planned = await lead.client.callTool({
        name: 'team_plan_tasks',
        arguments: { channel_id: '1', 
          tasks: [{
            key: 'api-layer',
            title: '实现接口层',
            targetSlotId: slot('builder').id,
            requiredCapabilities: ['code']
          }]
        }
      })
      expect(planned.isError).not.toBe(true)

      const sent = await lead.client.callTool({
        name: 'team_send_message',
        arguments: { channel_id: '1', 
          recipientSlotId: slot('builder').id,
          kind: 'directive',
          subject: '实现接口层',
          content: '请领取 api-layer 任务并回应。',
          clientMessageId: 'lead-api-layer-message-01'
        }
      })
      const messageId = (sent.structuredContent as {
        message?: { id?: string }
      }).message?.id
      expect(messageId).toMatch(/^team-message:/)

      const inbox = await builder.client.callTool({
        name: 'team_list_inbox',
        arguments: { channel_id: '1' }
      })
      expect(inbox.structuredContent).toMatchObject({
        messages: [expect.objectContaining({ id: messageId, kind: 'directive' })]
      })
      await builder.client.callTool({
        name: 'team_read_message',
        arguments: { channel_id: '1',  messageId }
      })
      const response = await builder.client.callTool({
        name: 'team_respond_message',
        arguments: { channel_id: '1', 
          messageId,
          content: '已读取并领取任务。',
          clientMessageId: 'builder-api-layer-response-01'
        }
      })
      expect(response.isError).not.toBe(true)

      const leadInbox = await lead.client.callTool({
        name: 'team_list_inbox',
        arguments: { channel_id: '1' }
      })
      expect(leadInbox.structuredContent).toMatchObject({
        messages: [expect.objectContaining({ kind: 'response' })]
      })

      await builder.client.callTool({ name: 'team_claim_task', arguments: { channel_id: '1' } })
      await builder.client.callTool({ name: 'team_start_task', arguments: { channel_id: '1' } })
      const progress = await builder.client.callTool({
        name: 'team_report_progress',
        arguments: { channel_id: '1',  progress: 60, summary: '接口实现完成，正在补测试。' }
      })
      expect(progress.structuredContent).toMatchObject({
        coordinationMessage: {
          kind: 'status',
          recipient: { type: 'agent', slotId: slot('lead').id }
        }
      })

      const broadcast = await lead.client.callTool({
        name: 'team_broadcast',
        arguments: { channel_id: '1', 
          kind: 'question',
          subject: '自我介绍',
          content: '请介绍你的实际职责。',
          clientMessageId: 'lead-team-introduction-broadcast-01'
        }
      })
      const broadcastMessageId = (broadcast.structuredContent as {
        messageIds?: string[]
      }).messageIds?.[0]
      expect(broadcastMessageId).toMatch(/^team-message:/)
      await builder.client.callTool({
        name: 'team_read_message',
        arguments: { channel_id: '1',  messageId: broadcastMessageId }
      })
      await builder.client.callTool({
        name: 'team_respond_message',
        arguments: { channel_id: '1', 
          messageId: broadcastMessageId,
          content: '我是架构实现，负责交付可运行、可测试的代码。',
          clientMessageId: 'builder-team-introduction-response-01'
        }
      })
      const collected = await lead.client.callTool({
        name: 'team_collect_responses',
        arguments: { channel_id: '1',  messageIds: [broadcastMessageId] }
      })
      expect(collected.structuredContent).toMatchObject({
        complete: true,
        pendingMessageIds: [],
        responses: [{
          messageId: broadcastMessageId,
          stage: 'responded',
          response: '我是架构实现，负责交付可运行、可测试的代码。'
        }]
      })
    } finally {
      await lead.client.close()
      await lead.server.close()
      await builder.client.close()
      await builder.server.close()
      collaboration.close()
      tasks.close()
      team.close()
    }
  })
})
