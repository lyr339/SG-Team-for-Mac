import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskAgentService } from '../src/application/task-agent-service'
import { TeamCollaborationAgentService } from '../src/application/team-collaboration-agent-service'
import { createDefaultTeamBundle } from '../src/domain/team-control'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-agent-coordination-')), 'team.sqlite3')
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
  const collaboration = new SqliteTeamCollaborationRepository(path)
  const role = (key: string) => bundle.roles.find((candidate) => candidate.key === key)!
  const slot = (key: string) => bundle.slots.find((candidate) => candidate.roleId === role(key).id)!
  const agent = (key: string) => {
    const currentRole = role(key)
    const currentSlot = slot(key)
    const identity = {
      agentSessionId: `alpha:ch-${currentSlot.channelId}:generation123`,
      runId: bundle.run.id,
      slotId: currentSlot.id,
      capabilities: [...currentRole.capabilities]
    }
    const taskService = new TaskAgentService(tasks, identity, tasks, team)
    return new TeamCollaborationAgentService(collaboration, identity, taskService)
  }
  return { team, tasks, collaboration, bundle, role, slot, agent }
}

describe('TeamCollaborationAgentService', () => {
  it('lets the lead direct a stable slot and requires an explicit correlated response', () => {
    const data = fixture()
    try {
      const lead = data.agent('lead')
      const builder = data.agent('builder')
      const directive = lead.sendMessage({
        recipientSlotId: data.slot('builder').id,
        kind: 'directive',
        subject: '重构接口层',
        content: '请重构接口层，并在完成后回复测试证据。',
        clientMessageId: 'lead-builder-directive-01'
      })

      expect(builder.getContext()).toMatchObject({ unreadMessages: 1 })
      expect(builder.listInbox()).toEqual([
        expect.objectContaining({ id: directive.id, kind: 'directive' })
      ])
      expect(builder.readMessage(directive.id).content).toContain('重构接口层')
      const response = builder.respondMessage({
        messageId: directive.id,
        content: '已完成，单元测试与类型检查均通过。',
        clientMessageId: 'builder-lead-response-01'
      })

      expect(lead.listInbox()).toEqual([
        expect.objectContaining({ id: response.id, kind: 'response' })
      ])
      expect(lead.getContext()).toMatchObject({ awaitingResponses: 0, unreadMessages: 1 })
    } finally {
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })

  it('prevents non-lead agents from issuing directives', () => {
    const data = fixture()
    try {
      expect(() => data.agent('builder').sendMessage({
        recipientSlotId: data.slot('reviewer').id,
        kind: 'directive',
        content: '越权指挥',
        clientMessageId: 'builder-directive-denied'
      })).toThrowError(/只有主控协调/)
    } finally {
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })

  it('dedupes repeated agent messages when the caller omits a stable clientMessageId', () => {
    const data = fixture()
    try {
      const lead = data.agent('lead')
      const first = lead.sendMessage({
        recipientSlotId: data.slot('builder').id,
        kind: 'notice',
        subject: '进展同步',
        content: '进展更新：builder 10%，reviewer 待命。'
      })
      const duplicate = lead.sendMessage({
        recipientSlotId: data.slot('builder').id,
        kind: 'notice',
        subject: '进展同步',
        content: '进展更新：builder 10%，reviewer 待命。'
      })

      expect(duplicate.id).toBe(first.id)
      expect(data.collaboration.loadRun(data.bundle.run.id).messageOrder).toEqual([first.id])
    } finally {
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })

  it('broadcasts to every other member and lets the lead collect only real correlated responses', () => {
    const data = fixture()
    try {
      const lead = data.agent('lead')
      const builder = data.agent('builder')
      const reviewer = data.agent('reviewer')
      const messages = lead.broadcast({
        kind: 'question',
        subject: '团队自我介绍',
        content: '请分别介绍自己的角色与职责。',
        clientMessageId: 'lead-introductions-broadcast-01'
      })

      expect(messages).toHaveLength(2)
      const builderMessage = messages.find((message) => message.recipient.type === 'agent'
        && message.recipient.slotId === data.slot('builder').id)!
      const reviewerMessage = messages.find((message) => message.recipient.type === 'agent'
        && message.recipient.slotId === data.slot('reviewer').id)!
      expect(builder.listInbox()).toEqual([
        expect.objectContaining({ id: builderMessage.id, kind: 'question' })
      ])
      expect(reviewer.listInbox()).toEqual([
        expect.objectContaining({ id: reviewerMessage.id, kind: 'question' })
      ])

      builder.respondMessage({
        messageId: builderMessage.id,
        content: '我是架构实现，负责可运行实现。',
        clientMessageId: 'builder-introduction-response-01'
      })
      const partial = new Map(lead.collectResponses(messages.map((message) => message.id))
        .map((item) => [item.messageId, item]))
      expect(partial.get(builderMessage.id)).toMatchObject({
        stage: 'responded',
        response: '我是架构实现，负责可运行实现。'
      })
      expect(partial.get(reviewerMessage.id)).toMatchObject({ stage: 'queued', response: undefined })

      reviewer.respondMessage({
        messageId: reviewerMessage.id,
        content: '我是质量验证，负责独立复现与验收。',
        clientMessageId: 'reviewer-introduction-response-01'
      })
      const collected = lead.collectResponses(messages.map((message) => message.id))
      expect(new Set(collected.map((item) => item.response))).toEqual(new Set([
        '我是架构实现，负责可运行实现。',
        '我是质量验证，负责独立复现与验收。'
      ]))
      expect(() => builder.broadcast({
        kind: 'notice',
        content: '越权广播',
        clientMessageId: 'builder-broadcast-denied-01'
      })).toThrowError(/只有主控协调/)
    } finally {
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })

  it('reports member task status to the lead without creating a fake pending response', () => {
    const data = fixture()
    try {
      const lead = data.agent('lead')
      const builder = data.agent('builder')
      const status = builder.reportTaskStatus({
        taskId: 'task-1',
        subject: '任务进度',
        content: '进度 60%，单元测试已通过。',
        eventKey: 'progress:60:tests-passed'
      })

      expect(status).toMatchObject({ kind: 'status', recipient: { slotId: data.slot('lead').id } })
      expect(lead.listInbox()).toEqual([
        expect.objectContaining({ id: status?.id, kind: 'status' })
      ])
      expect(builder.getContext()).toMatchObject({ awaitingResponses: 0 })
    } finally {
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })

  it('lets only the lead plan a task reserved for one stable AgentSlot', () => {
    const data = fixture()
    try {
      const builderSlot = data.slot('builder')
      const lead = data.agent('lead')
      expect(lead.getContext()).toMatchObject({
        members: expect.arrayContaining([
          expect.objectContaining({
            slotId: builderSlot.id,
            capabilities: expect.arrayContaining(['code', 'architecture'])
          })
        ])
      })
      expect(() => lead.planTasks([{
        key: 'invalid-capability',
        title: '错误能力指派',
        requiredCapabilities: ['implementation'],
        targetSlotId: builderSlot.id
      }])).toThrowError(/不具备能力 implementation/)

      const [task] = lead.planTasks([{
        key: 'interface-layer',
        title: '重构接口层',
        acceptance: '测试通过',
        requiredCapabilities: ['code'],
        targetSlotId: builderSlot.id
      }])
      expect(task).toMatchObject({ targetSlotId: builderSlot.id, status: 'queued' })
      expect(data.agent('builder').listTaskBoard).toBeDefined()
      expect(() => data.agent('builder').listTaskBoard()).toThrowError(/只有主控协调/)

      const builderTaskService = new TaskAgentService(data.tasks, {
        agentSessionId: 'alpha:ch-2:generation123',
        runId: data.bundle.run.id,
        slotId: builderSlot.id,
        capabilities: ['code', 'architecture']
      }, data.tasks, data.team)
      const reviewerTaskService = new TaskAgentService(data.tasks, {
        agentSessionId: 'alpha:ch-3:generation123',
        runId: data.bundle.run.id,
        slotId: data.slot('reviewer').id,
        capabilities: ['qa', 'testing']
      }, data.tasks, data.team)
      expect(builderTaskService.listAvailable().map((candidate) => candidate.id)).toEqual([task!.id])
      expect(reviewerTaskService.listAvailable()).toEqual([])
    } finally {
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })

  it('starts a ready TeamRun when goal defined and all MCP installed', () => {
    const data = fixture()
    try {
      const state = data.team.loadTeamControl()
      const run = state.runs.find((candidate) => candidate.id === data.bundle.run.id)!
      expect(run.status).toBe('draft')

      // 填写目标并标记为 ready
      data.team.updateRunGoal(run.id, '完成接口重构')
      const readyState = data.team.loadTeamControl()
      const readyRun = readyState.runs.find((candidate) => candidate.id === run.id)!
      expect(readyState.slots.every((slot) => readyState.bindings.some((binding) => binding.slotId === slot.id))).toBe(true)

      // 模拟启动
      data.team.beginLaunch(run.id, Date.now(), 'test-binding-key')
      const launchingState = data.team.loadTeamControl()
      const launchingRun = launchingState.runs.find((candidate) => candidate.id === run.id)!
      expect(launchingRun.status).toBe('launching')
    } finally {
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })

  it('rejects start when goal is empty or MCP not fully installed', () => {
    const data = fixture()
    try {
      const state = data.team.loadTeamControl()
      const run = state.runs.find((candidate) => candidate.id === data.bundle.run.id)!

      // 目标为空时无法启动
      expect(() => data.team.beginLaunch(run.id, Date.now(), 'test-key')).toThrow(/尚未达到可启动状态/)
    } finally {
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })

  it('pings a channel and records liveness on pong response', () => {
    const data = fixture()
    try {
      const lead = data.agent('lead')
      const builder = data.agent('builder')

      // lead 向 builder 发送 ping
      const { pingId } = lead.ping({ targetChannelId: '2', timeoutMs: 5000 })
      expect(pingId).toMatch(/^ping:/)

      // 初始状态应该是 suspected_offline（未验证）
      let liveness = lead.checkLiveness('2')
      expect(liveness?.liveness).toBe('suspected_offline')
      expect(liveness?.consecutiveFailures).toBe(1)

      // builder 响应 pong
      builder.pong({ pingId })

      // 状态应该变为 active
      liveness = lead.checkLiveness('2')
      expect(liveness?.liveness).toBe('active')
      expect(liveness?.consecutiveFailures).toBe(0)
    } finally {
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })

  it('escalates to confirmed_offline after 3 consecutive ping failures', () => {
    const data = fixture()
    try {
      const lead = data.agent('lead')

      // 连续 3 次 ping 失败（无 pong 响应）
      lead.ping({ targetChannelId: '2' })
      lead.checkLiveness('2') // 触发状态更新
      lead.ping({ targetChannelId: '2' })
      lead.checkLiveness('2')
      lead.ping({ targetChannelId: '2' })
      const liveness = lead.checkLiveness('2')

      expect(liveness?.liveness).toBe('confirmed_offline')
      expect(liveness?.consecutiveFailures).toBe(3)
    } finally {
      data.collaboration.close()
      data.tasks.close()
      data.team.close()
    }
  })
})
