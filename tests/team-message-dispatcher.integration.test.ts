import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelMessageRelay } from '../src/application/channel-message-relay'
import { LocalSessionBridge } from '../src/application/local-session-bridge'
import { TaskAgentService } from '../src/application/task-agent-service'
import { TeamCollaborationAgentService } from '../src/application/team-collaboration-agent-service'
import { TeamControlService } from '../src/application/team-control-service'
import { TeamMessageDispatcher } from '../src/application/team-message-dispatcher'
import { createDefaultTeamBundle } from '../src/domain/team-control'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('Team message end-to-end local delivery', () => {
  it('delivers lead → builder → lead through the embedded channel queue', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-e2e-')), 'team.sqlite3')
    const teamRepository = new SqliteTeamControlRepository(path)
    const bundle = createDefaultTeamBundle({
      workspaceId: 'alpha',
      workspaceName: 'alpha',
      workspacePath: '/workspace/alpha',
      channelIds: ['1', '2'],
      runKey: 'run-message-e2e',
      now: 100
    })
    teamRepository.upsertWorkspaceTeam(bundle)
    teamRepository.recordInstallation({
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
    const channelRepository = new SqliteChannelMessageRepository(path)
    for (const channelId of ['1', '2']) {
      channelRepository.markChannelEmbedded(channelId, 'alpha', '/workspace/alpha')
      // 模拟内嵌 MCP 进程在岗：presence 即活性证据（等价原插件 WS 状态投影）
      channelRepository.touchPresence(channelId, {
        waiting: true,
        connectionPhase: 'waiting',
        lastSeenAt: Date.now()
      })
    }
    const relay = new ChannelMessageRelay(channelRepository)
    const bridge = new LocalSessionBridge(relay)
    const team = new TeamControlService(teamRepository, bridge)
    const dispatcher = new TeamMessageDispatcher(collaboration, bridge, team)

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
      const taskService = new TaskAgentService(tasks, identity, tasks, teamRepository)
      return new TeamCollaborationAgentService(collaboration, identity, taskService)
    }
    const outboxTexts = (channelId: string): string[] =>
      channelRepository.listPendingOutbound(channelId).map((message) => message.text)

    try {
      await waitFor(() => team.getSnapshot().preflight.agentsWaiting)
      const lead = agent('lead')
      const builder = agent('builder')
      const directive = lead.sendMessage({
        recipientSlotId: slot('builder').id,
        kind: 'directive',
        content: '请读取并明确回应。',
        clientMessageId: 'e2e-lead-directive-01'
      })
      dispatcher.dispatchPending()
      await waitFor(() => outboxTexts('2').some((text) => text.includes(directive.id)))
      await waitFor(() => collaboration.loadRun(bundle.run.id).messages[directive.id]?.receipt.notificationState === 'notified')

      builder.readMessage(directive.id)
      const response = builder.respondMessage({
        messageId: directive.id,
        content: '已读取并完成明确回应。',
        clientMessageId: 'e2e-builder-response-01'
      })
      dispatcher.dispatchPending()
      await waitFor(() => outboxTexts('1').some((text) => text.includes(response.id)))
      await waitFor(() => collaboration.loadRun(bundle.run.id).messages[response.id]?.receipt.notificationState === 'notified')

      expect(lead.listInbox()).toEqual([
        expect.objectContaining({ id: response.id, kind: 'response' })
      ])
      expect(collaboration.loadRun(bundle.run.id).messages[directive.id]?.receipt)
        .toMatchObject({ responseMessageId: response.id })
    } finally {
      dispatcher.dispose()
      team.dispose()
      bridge.dispose()
      relay.stop()
      collaboration.close()
      tasks.close()
      channelRepository.close()
      teamRepository.close()
    }
  })
})
