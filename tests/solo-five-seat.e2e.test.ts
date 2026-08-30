import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTeamAgentLaunchPromptPort } from '../src/application/team-agent-launch-prompts'
import { TeamControlService, type TeamControlBridge } from '../src/application/team-control-service'
import { createConfiguredTeamBundle } from '../src/domain/team-control'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import type { DesktopSnapshot, SendMessageInput } from '../src/shared/desktop-api'

class Bridge implements TeamControlBridge {
  readonly sent: SendMessageInput[] = []
  private listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  constructor(private snapshot: DesktopSnapshot) {}
  getSnapshot(): DesktopSnapshot { return structuredClone(this.snapshot) }
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }
  sendMessage(input: SendMessageInput) {
    const commandId = `cmd-${this.sent.length + 1}`
    this.sent.push(input)
    this.snapshot.conversations[input.channelId] = [{
      id: commandId, channelId: input.channelId, role: 'user', text: input.text,
      timestamp: Date.now(), status: 'complete', source: 'desktop', commandId
    }]
    for (const listener of this.listeners) listener(this.getSnapshot())
    return { commandId }
  }
}

describe('solo five-seat end-to-end composition', () => {
  it('installs all five, launches/checks in only the three-person team, and keeps two solo prompts independent', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-solo-e2e-')), 'team.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const collaboration = new SqliteTeamCollaborationRepository(path)
    const bundle = createConfiguredTeamBundle({
      workspaceId: 'mixed-five', workspaceName: 'mixed-five', workspacePath: '/workspace/mixed-five', now: 100,
      members: [
        { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
        { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] },
        { channelId: '3', roleTemplateKey: 'reviewer', avatarId: 'reviewer', skills: [] },
        { channelId: '4', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true },
        { channelId: '5', roleTemplateKey: 'solo', avatarId: 'devops', skills: [], solo: true }
      ]
    })
    repository.upsertWorkspaceTeam(bundle)
    repository.updateRunGoal(bundle.run.id, '三人团队协作，两个独立会话由用户单独指派')
    repository.recordInstallation({
      workspaceId: bundle.workspace.id, runId: bundle.run.id, generation: 'generation123',
      agents: bundle.slots.map((slot) => ({
        agentSessionId: `mixed-five:ch-${slot.channelId}:generation123`, workspaceId: bundle.workspace.id,
        channelId: slot.channelId!, generation: 'generation123', runId: bundle.run.id,
        capabilities: bundle.roles.find((role) => role.id === slot.roleId)!.capabilities
      }))
    })
    const bridge = new Bridge({
      connection: { state: 'connected', endpoint: 'local', attempt: 0, lastError: '' },
      sessions: ['1', '2', '3', '4', '5'].map((channelId) => ({
        id: `session-${channelId}`, channelId, generation: 1, displayName: `CH-${channelId}`,
        roleName: '', status: 'waiting', currentTask: '', queueDepth: 0, connectionPhase: 'waiting',
        online: true, connected: true, waiting: true, workingFiles: [], healthEvidence: ['waiting']
      })),
      conversations: {}, protocolIssues: [], updatedAt: 1
    })
    const service = new TeamControlService(repository, bridge, 100)
    try {
      expect(service.getSnapshot().members).toHaveLength(5)
      expect(service.getSnapshot().preflight).toMatchObject({ mcpInstalled: true, agentsWaiting: true, canLaunch: true })
      await service.launch()
      expect(bridge.sent.map((message) => message.channelId)).toEqual(['1', '2', '3'])

      for (const channelId of ['1', '2', '3']) {
        const identity = repository.resolveChannelAgentIdentity(channelId)
        repository.recordAgentCheckIn(identity, 'ready')
      }
      expect(service.getSnapshot().activeRun?.status).toBe('running')
      expect(collaboration.listRunMembers(bundle.run.id)).toHaveLength(3)

      for (const channelId of ['4', '5']) {
        expect(() => repository.resolveChannelAgentIdentity(channelId)).toThrowError(/独立席位/)
        const prompts = createTeamAgentLaunchPromptPort({ getSnapshot: () => service.getSnapshot() })
        const prompt = await prompts.fetchStartPrompt(channelId)
        expect(prompt).toContain('独立模式')
        expect(prompt).toContain('record_reply')
        expect(prompt).not.toContain('team_check_in')
      }
    } finally {
      service.dispose()
      collaboration.close()
      repository.close()
    }
  })
})
