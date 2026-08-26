import { describe, expect, it } from 'vitest'
import {
  createDefaultTeamBundle,
  type RuntimeBinding,
  type TeamControlSnapshot
} from '../src/domain/team-control'
import { createTeamAgentLaunchPromptPort } from '../src/application/team-agent-launch-prompts'

function snapshotWith(binding?: RuntimeBinding): TeamControlSnapshot {
  const bundle = createDefaultTeamBundle({
    workspaceId: 'workspace-a',
    workspaceName: 'alpha',
    workspacePath: '/workspace/alpha',
    channelIds: ['1', '2', '3'],
    now: 100
  })
  bundle.run.goal = '完成真实 lead/builder/reviewer 协作闭环'
  return {
    schemaVersion: 5,
    revision: 1,
    activeWorkspaceId: bundle.workspace.id,
    workspaces: [bundle.workspace],
    runs: [bundle.run],
    roles: bundle.roles,
    slots: bundle.slots,
    bindings: binding ? [binding] : [],
    updatedAt: 100,
    activeRun: bundle.run,
    members: [],
    runtimeChannels: [],
    standbyChannels: [],
    failovers: [],
    preflight: {
      bridgeConnected: true,
      workspaceBound: true,
      goalDefined: true,
      mcpInstalled: Boolean(binding),
      agentsWaiting: false,
      canLaunch: Boolean(binding),
      blockers: []
    }
  }
}

describe('team agent launch prompts', () => {
  it('builds the start prompt from the active TeamRun channel binding', async () => {
    const binding: RuntimeBinding = {
      id: 'binding-builder',
      workspaceId: 'workspace-a',
      runId: 'team-run:workspace-a:main',
      slotId: 'agent-slot:workspace-a:builder',
      channelId: '2',
      agentSessionId: 'workspace-a:ch-2:generation1',
      generation: 'generation1',
      installedAt: 100,
      launchStatus: 'not_started',
      launchDetail: '',
      lastCheckInNote: '',
      composerBindingKey: 'generation1'
    }
    const prompts = createTeamAgentLaunchPromptPort({ getSnapshot: () => snapshotWith(binding) })

    const prompt = await prompts.fetchStartPrompt('2')

    // S4 底层注入：启动提示只保留一句话引导
    expect(prompt).toContain('CH-2')
    expect(prompt).toContain('team_check_in')
    expect(prompt).toContain('qunshu')
    expect(prompt).not.toContain('qtwx-mcp-2')
    expect(prompt).not.toContain('核心职责')
  })

  it('fails before CDP launch when the channel has no installed runtime binding', async () => {
    const prompts = createTeamAgentLaunchPromptPort({ getSnapshot: () => snapshotWith() })

    await expect(prompts.fetchStartPrompt('2')).rejects.toThrowError(/尚未安装 Team MCP/)
  })

  it('refuses to issue a start prompt while the run goal is empty', async () => {
    const binding: RuntimeBinding = {
      id: 'binding-builder',
      workspaceId: 'workspace-a',
      runId: 'team-run:workspace-a:main',
      slotId: 'agent-slot:workspace-a:builder',
      channelId: '2',
      agentSessionId: 'workspace-a:ch-2:generation1',
      generation: 'generation1',
      installedAt: 100,
      launchStatus: 'not_started',
      launchDetail: '',
      lastCheckInNote: '',
      composerBindingKey: 'generation1'
    }
    const snapshot = snapshotWith(binding)
    snapshot.runs[0]!.goal = ''
    snapshot.activeRun = { ...snapshot.activeRun!, goal: '' }
    const prompts = createTeamAgentLaunchPromptPort({ getSnapshot: () => snapshot })

    await expect(prompts.fetchStartPrompt('2')).rejects.toThrowError(/请先填写团队目标/)
  })

  it('ensures the run has entered launching before the start prompt is delivered', async () => {
    const binding: RuntimeBinding = {
      id: 'binding-builder',
      workspaceId: 'workspace-a',
      runId: 'team-run:workspace-a:main',
      slotId: 'agent-slot:workspace-a:builder',
      channelId: '2',
      agentSessionId: 'workspace-a:ch-2:generation1',
      generation: 'generation1',
      installedAt: 100,
      launchStatus: 'not_started',
      launchDetail: '',
      lastCheckInNote: '',
      composerBindingKey: 'generation1'
    }
    let ensured = 0
    const prompts = createTeamAgentLaunchPromptPort({
      getSnapshot: () => snapshotWith(binding),
      ensureRunLaunched: () => { ensured += 1 }
    })

    const prompt = await prompts.fetchStartPrompt('2')

    expect(ensured).toBe(1)
    expect(prompt).toContain('team_check_in')
  })
})
