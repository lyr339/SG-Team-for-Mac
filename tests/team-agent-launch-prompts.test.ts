import { describe, expect, it } from 'vitest'
import {
  createConfiguredTeamBundle,
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
    schemaVersion: 7,
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
    expect(prompt).toContain('SG Team')
    expect(prompt).not.toContain('qtwx-mcp-2')
    expect(prompt).not.toContain('核心职责')
    // 升级前的绑定没有会话令牌：提示词不得凭空要求 Agent 附带 session。
    expect(prompt).not.toContain('session')
    expect(prompt).not.toContain('会话围栏')
  })

  it('hands the seat session token to the team Agent and tells it to stop on a fence instruction', async () => {
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
      composerBindingKey: 'generation1',
      sessionToken: 'seat-token-builder-0001'
    }
    const prompts = createTeamAgentLaunchPromptPort({ getSnapshot: () => snapshotWith(binding) })
    const prompt = await prompts.fetchStartPrompt('2')
    // 团队工具只需 channel_id；令牌只约束通信工具。
    expect(prompt).toContain("team_check_in({channel_id:'2'})")
    expect(prompt).toContain('本会话令牌（session）：seat-token-builder-0001')
    expect(prompt).toContain("session:'seat-token-builder-0001'")
    expect(prompt).toContain('会话围栏')
    expect(prompt).toContain('立即停止轮询并结束，不要重试')
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

  it('gives a solo channel its independent loop without goal or run-state transition', async () => {
    const bundle = createConfiguredTeamBundle({
      workspaceId: 'solo-workspace', workspaceName: 'solo', workspacePath: '/workspace/solo', now: 100,
      members: [
        { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
        { channelId: '2', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }
      ]
    })
    bundle.run.goal = ''
    const slot = bundle.slots.find((candidate) => candidate.solo)!
    const binding: RuntimeBinding = {
      id: 'binding-solo', workspaceId: bundle.workspace.id, runId: bundle.run.id,
      slotId: slot.id, channelId: '2', agentSessionId: 'solo:ch-2:g1', generation: 'g1',
      installedAt: 100, launchStatus: 'not_started', launchDetail: '', lastCheckInNote: '', composerBindingKey: 'g1'
    }
    let ensured = 0
    const snapshot: TeamControlSnapshot = {
      schemaVersion: 7, revision: 1, activeWorkspaceId: bundle.workspace.id,
      workspaces: [bundle.workspace], runs: [bundle.run], roles: bundle.roles, slots: bundle.slots,
      bindings: [binding], updatedAt: 100, activeRun: bundle.run, members: [], runtimeChannels: [],
      standbyChannels: [], failovers: [],
      preflight: { bridgeConnected: true, workspaceBound: true, goalDefined: false, mcpInstalled: true, agentsWaiting: false, canLaunch: false, blockers: [] }
    }
    const prompts = createTeamAgentLaunchPromptPort({
      getSnapshot: () => snapshot,
      ensureRunLaunched: () => { ensured += 1 }
    })
    const prompt = await prompts.fetchStartPrompt('2')
    expect(prompt).toContain('独立模式')
    expect(prompt).toContain('record_reply')
    expect(prompt).not.toContain('team_check_in')
    expect(ensured).toBe(0)
  })
})
