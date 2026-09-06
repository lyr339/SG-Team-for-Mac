import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTeamAgentLaunchPromptPort } from '../src/application/team-agent-launch-prompts'
import { TeamControlService, type TeamControlBridge } from '../src/application/team-control-service'
import { createConfiguredTeamBundle, workspaceRunMode } from '../src/domain/team-control'
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
  it('persists an independent-only run and gives every channel the isolated long-poll prompt', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-independent-e2e-')), 'team.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const bridge = new Bridge({
      connection: { state: 'connected', endpoint: 'local', attempt: 0, lastError: '' },
      sessions: [], conversations: {}, protocolIssues: [], updatedAt: 1
    })
    const service = new TeamControlService(repository, bridge, 100)
    try {
      const created = service.configureIndependentWorkspace({
        workspaceId: 'independent-three', workspaceName: 'independent-three', workspacePath: '/workspace/independent-three',
        members: ['1', '2', '3'].map((channelId) => ({
          channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true
        }))
      })
      const run = created.activeRun!
      service.recordInstallation({
        workspaceId: 'independent-three', runId: run.id, generation: 'generation123',
        agents: created.members.map((member) => ({
          agentSessionId: `independent-three:ch-${member.slot.channelId}:generation123`,
          workspaceId: 'independent-three', channelId: member.slot.channelId!, generation: 'generation123',
          runId: run.id, capabilities: []
        }))
      })
      const restored = service.getSnapshot()
      expect(workspaceRunMode(restored.activeRun)).toBe('independent')
      expect(restored.bindings).toHaveLength(3)
      const prompts = createTeamAgentLaunchPromptPort({ getSnapshot: () => service.getSnapshot() })
      for (const channelId of ['1', '2', '3']) {
        const prompt = await prompts.fetchStartPrompt(channelId)
        // 会话围栏：开场提示把该席位签发的 session 令牌写进两条通信调用，令牌与绑定一致。
        const token = restored.bindings.find((binding) => binding.channelId === channelId)?.sessionToken
        expect(token).toMatch(/^[a-zA-Z0-9_-]{8,128}$/)
        expect(prompt).toContain(`check_messages({channel_id:'${channelId}', session:'${token}'})`)
        expect(prompt).toContain(`record_reply({channel_id:'${channelId}', session:'${token}', content: 完整回复正文})`)
        expect(prompt).toContain('会话围栏')
        expect(prompt).not.toContain('team_check_in')
        expect(() => repository.resolveChannelAgentIdentity(channelId)).toThrowError(/独立席位/)
      }
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('installs all five, launches/checks in only the three-person team, and keeps two solo prompts independent', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-solo-e2e-')), 'team.sqlite3')
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
