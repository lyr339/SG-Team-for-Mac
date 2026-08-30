import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskAgentService } from '../src/application/task-agent-service'
import { TeamCollaborationAgentService } from '../src/application/team-collaboration-agent-service'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { ChannelMessageService } from '../src/application/channel-message-service'
import { createDefaultTeamBundle } from '../src/domain/team-control'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { createUnifiedChannelServer } from '../src/mcp/unified-channel-server'

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), 'qingtian-claim-lead-')), 'team.sqlite3')
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
  team.updateRunGoal(bundle.run.id, '完成本轮接口重构')
  team.beginLaunch(bundle.run.id, Date.now(), 'binding-key-claim-1')
  const tasks = new SqliteTaskPoolRepository(path)
  const collaboration = new SqliteTeamCollaborationRepository(path)
  const channels = new SqliteChannelMessageRepository(path)
  channels.touchPresence('1', {
    lastSeenAt: Date.now(), waiting: true, connectionPhase: 'waiting'
  })
  channels.touchPresence('2', {
    lastSeenAt: Date.now(), waiting: true, connectionPhase: 'waiting'
  })
  const slot = (key: string) => {
    const role = bundle.roles.find((candidate) => candidate.key === key)!
    return bundle.slots.find((candidate) => candidate.roleId === role.id)!
  }
  const connect = async (key: string) => {
    const currentSlot = slot(key)
    const role = bundle.roles.find((candidate) => candidate.id === currentSlot.roleId)!
    const identity = {
      agentSessionId: `alpha:ch-${currentSlot.channelId}:generation123`,
      runId: bundle.run.id,
      slotId: currentSlot.id,
      capabilities: [...role.capabilities]
    }
    const taskService = new TaskAgentService(tasks, identity, tasks, team)
    const coordination = new TeamCollaborationAgentService(collaboration, identity, taskService)
    const server = createUnifiedChannelServer({
      runtimeFor: () => ({
        service: taskService,
        collaboration: coordination,
        controlRepository: team,
        channelPresence: (channelId) => channels.getPresence(channelId)
      }),
      channelServiceFor: () => new ChannelMessageService(channels),
      refreshIdentity: () => {
        const current = team.resolveChannelAgentIdentity(currentSlot.channelId!)
        Object.assign(taskService.identity, current)
        Object.assign(coordination.identity, current)
      }
    })
    const client = new Client({ name: `claim-lead-${key}`, version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return { client, server }
  }
  return {
    bundle,
    team,
    collaboration,
    channels,
    tasks,
    slot,
    connect,
    close: () => {
      collaboration.close()
      channels.close()
      tasks.close()
      team.close()
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('team_claim_lead（主控离线接管）', () => {
  it('rejects the claim when the lead answers the liveness ping with a pong', async () => {
    const data = setup()
    const builder = await data.connect('builder')
    try {
      // 模拟主控活跃：ping 发出 500ms 后 pong 回来（verified 刷新 lastPongAt）
      const pong = setTimeout(() => {
        data.collaboration.recordLiveness({ channelId: '1', runId: data.bundle.run.id, verified: true, at: Date.now() })
      }, 500)
      const result = await builder.client.callTool({
        name: 'team_claim_lead',
        arguments: { channel_id: '2', reason: '主控疑似掉线', pongTimeoutMs: 2_000 }
      })
      clearTimeout(pong)
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ ok: false, code: 'lead_still_active' })
      expect(data.team.loadTeamControl().runs.find((run) => run.id === data.bundle.run.id)?.actingLeadSlotId)
        .toBeUndefined()
    } finally {
      await builder.client.close()
      data.close()
    }
  })

  it('lets an online member claim the lead when the ping times out with offline liveness on record', async () => {
    const data = setup()
    const builder = await data.connect('builder')
    const originalLead = await data.connect('lead')
    try {
      const [leadTask, builderTask] = transactTaskPool(data.tasks, (pool) => {
        const planned = pool.plan(data.bundle.run.id, [
          { key: 'lead-active', title: '原主控活动任务', targetSlotId: data.slot('lead').id },
          { key: 'builder-active', title: '接管者原有任务', targetSlotId: data.slot('builder').id }
        ])
        for (const [task, key] of [[planned[0]!, 'lead'], [planned[1]!, 'builder']] as const) {
          const currentSlot = data.slot(key)
          const role = data.bundle.roles.find((candidate) => candidate.id === currentSlot.roleId)!
          const lease = pool.leaseTask(task.id, {
            runId: data.bundle.run.id,
            slotId: currentSlot.id,
            agentSessionId: `alpha:ch-${currentSlot.channelId}:generation123`,
            capabilities: role.capabilities
          })!
          pool.startAttempt(lease.attempt.id, lease.leaseToken)
        }
        return planned
      })
      data.collaboration.recordLiveness({ channelId: '1', runId: data.bundle.run.id, verified: false, at: Date.now() })
      data.channels.touchPresence('1', {
        lastSeenAt: Date.now(), waiting: false, connectionPhase: 'cursor_stopped'
      })

      const result = await builder.client.callTool({
        name: 'team_claim_lead',
        arguments: { channel_id: '2', reason: 'CH-1 已掉线，用户指定接管', pongTimeoutMs: 2_000 }
      })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({
        ok: true,
        actingLeadSlotId: data.slot('builder').id,
        previousLeadSlotId: data.slot('lead').id,
        recoveredTaskIds: [leadTask!.id]
      })
      const run = data.team.loadTeamControl().runs.find((candidate) => candidate.id === data.bundle.run.id)!
      expect(run.actingLeadSlotId).toBe(data.slot('builder').id)

      const snapshot = data.collaboration.loadRun(data.bundle.run.id)
      const audit = Object.values(snapshot.messages)
        .find((message) => message.content.includes('接管审计'))!
      expect(audit.kind).toBe('notice')
      expect(audit.recipient).toMatchObject({ type: 'agent', slotId: data.slot('lead').id })
      expect(audit.content).toContain('suspected_offline')
      expect(audit.content).toContain('Cursor 已明确终止')
      expect(audit.content).toContain('用户指定接管')
      expect(snapshot.threads.find((thread) => thread.id === audit.threadId)?.subject)
        .toBe('主控离线接管审计')
      const contextMessageId = (result.structuredContent as { contextMessageId: string }).contextMessageId
      expect(snapshot.messages[contextMessageId]).toMatchObject({
        recipient: { type: 'agent', slotId: data.slot('builder').id }
      })
      expect(snapshot.messages[contextMessageId]?.content).toContain('主控接管上下文')
      expect(snapshot.threads.find((thread) => thread.id === snapshot.messages[contextMessageId]?.threadId)?.subject)
        .toBe('主控接管上下文')
      const taskState = data.tasks.load()
      expect(taskState.tasks[leadTask!.id]).toMatchObject({
        status: 'queued', targetSlotId: data.slot('builder').id, assigneeSessionId: undefined
      })
      expect(taskState.tasks[builderTask!.id]).toMatchObject({
        status: 'running', assigneeSessionId: `alpha:ch-2:generation123`
      })

      // 真权限迁移：临时主控可立即使用任务板/拆任务，原主控同时失去这些权限。
      const board = await builder.client.callTool({
        name: 'team_list_board', arguments: { channel_id: '2' }
      })
      expect(board.isError).not.toBe(true)
      const planned = await builder.client.callTool({
        name: 'team_plan_tasks',
        arguments: {
          channel_id: '2',
          tasks: [{ key: 'acting-lead-task', title: '临时主控创建的任务' }]
        }
      })
      expect(planned.isError).not.toBe(true)

      const oldLeadBoard = await originalLead.client.callTool({
        name: 'team_list_board', arguments: { channel_id: '1' }
      })
      expect(oldLeadBoard.isError).toBe(true)
      expect(oldLeadBoard.structuredContent).toMatchObject({ ok: false, code: 'coordinator_only' })
      const actingLiveness = await builder.client.callTool({
        name: 'team_check_liveness', arguments: { channel_id: '2', targetChannelId: '1' }
      })
      expect(actingLiveness.isError).not.toBe(true)
      const demotedLiveness = await originalLead.client.callTool({
        name: 'team_check_liveness', arguments: { channel_id: '1', targetChannelId: '2' }
      })
      expect(demotedLiveness.isError).toBe(true)
      expect(demotedLiveness.structuredContent).toMatchObject({ code: 'lead_only_liveness' })
    } finally {
      await originalLead.client.close()
      await builder.client.close()
      data.close()
    }
  })

  it('treats a repeated claim by the acting lead as an idempotent no-op', async () => {
    const data = setup()
    const builder = await data.connect('builder')
    try {
      data.channels.touchPresence('1', {
        lastSeenAt: Date.now(), waiting: false, connectionPhase: 'cursor_stopped'
      })
      await builder.client.callTool({
        name: 'team_claim_lead',
        arguments: { channel_id: '2', pongTimeoutMs: 2_000 }
      })
      const again = await builder.client.callTool({
        name: 'team_claim_lead',
        arguments: { channel_id: '2' }
      })
      expect(again.isError).not.toBe(true)
      expect(again.structuredContent).toMatchObject({ ok: true, alreadyLead: true })
    } finally {
      await builder.client.close()
      data.close()
    }
  })

  it('preserves exclusive effective-lead permissions across MCP process recreation', async () => {
    const data = setup()
    data.team.setActingLead({
      runId: data.bundle.run.id,
      slotId: data.slot('builder').id,
      at: Date.now()
    })
    const restartedBuilder = await data.connect('builder')
    const restartedLead = await data.connect('lead')
    try {
      const builderBoard = await restartedBuilder.client.callTool({
        name: 'team_list_board', arguments: { channel_id: '2' }
      })
      expect(builderBoard.isError).not.toBe(true)
      const originalLeadBoard = await restartedLead.client.callTool({
        name: 'team_list_board', arguments: { channel_id: '1' }
      })
      expect(originalLeadBoard.isError).toBe(true)
      expect(originalLeadBoard.structuredContent).toMatchObject({ code: 'coordinator_only' })
    } finally {
      await restartedBuilder.client.close()
      await restartedLead.client.close()
      data.close()
    }
  })

  it('rejects a takeover when the ping is unanswered but the lead presence is still fresh', async () => {
    const data = setup()
    const builder = await data.connect('builder')
    try {
      const result = await builder.client.callTool({
        name: 'team_claim_lead',
        arguments: { channel_id: '2', reason: '心跳超时接管', pongTimeoutMs: 2_000 }
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ ok: false, code: 'lead_liveness_unproven' })
      expect(data.team.loadTeamControl().runs.find((run) => run.id === data.bundle.run.id)?.actingLeadSlotId)
        .toBeUndefined()
    } finally {
      await builder.client.close()
      data.close()
    }
  })

  it('rejects immediately when the lead is processing a long-running task', async () => {
    const data = setup()
    const builder = await data.connect('builder')
    try {
      data.channels.touchPresence('1', {
        lastSeenAt: Date.now() - 45 * 60_000,
        waiting: false,
        connectionPhase: 'processing'
      })
      const result = await builder.client.callTool({
        name: 'team_claim_lead',
        arguments: { channel_id: '2', reason: '主控很久没 pong', pongTimeoutMs: 2_000 }
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ ok: false, code: 'lead_busy' })
      expect(data.team.loadTeamControl().runs.find((run) => run.id === data.bundle.run.id)?.actingLeadSlotId)
        .toBeUndefined()
    } finally {
      await builder.client.close()
      data.close()
    }
  })

  it('does not treat a stale non-processing lease plus no-pong as sufficient takeover evidence', async () => {
    const data = setup()
    const builder = await data.connect('builder')
    try {
      data.channels.touchPresence('1', {
        lastSeenAt: Date.now() - 10 * 60_000,
        waiting: false,
        connectionPhase: 'waiting'
      })
      const result = await builder.client.callTool({
        name: 'team_claim_lead',
        arguments: { channel_id: '2', pongTimeoutMs: 2_000 }
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ ok: false, code: 'lead_liveness_unproven' })
      expect(data.team.loadTeamControl().runs.find((run) => run.id === data.bundle.run.id)?.actingLeadSlotId)
        .toBeUndefined()
    } finally {
      await builder.client.close()
      data.close()
    }
  })

  it('rejects the claim when the run is not active', async () => {
    const data = setup()
    const builder = await data.connect('builder')
    try {
      data.team.completeRun(data.bundle.run.id, Date.now())
      const result = await builder.client.callTool({
        name: 'team_claim_lead',
        arguments: { channel_id: '2' }
      })
      expect(result.isError).toBe(true)
      // run 结束后运行时注册已被撤销，授权围栏先于 run_inactive 拦截
      expect(result.structuredContent).toMatchObject({ ok: false, code: 'agent_not_authorized' })
    } finally {
      await builder.client.close()
      data.close()
    }
  })
})
