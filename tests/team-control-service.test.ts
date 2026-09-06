import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TeamControlService, type TeamControlBridge } from '../src/application/team-control-service'
import type { DesktopSnapshot, SendMessageInput } from '../src/shared/desktop-api'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import type { CursorComposerTelemetrySource } from '../src/infrastructure/cursor/cursor-composer-telemetry'
import { createConfiguredTeamBundle, createDefaultTeamBundle, workspaceRunMode } from '../src/domain/team-control'

class FakeBridge implements TeamControlBridge {
  readonly sent: SendMessageInput[] = []
  readonly conversationScopes: Array<{ runId: string; startedAt: number }> = []
  private listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  private nextCommand = 0

  constructor(private snapshot: DesktopSnapshot) {}

  getSnapshot(): DesktopSnapshot {
    return structuredClone(this.snapshot)
  }

  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  sendMessage(input: SendMessageInput) {
    const commandId = `command-${++this.nextCommand}`
    this.sent.push(input)
    this.snapshot = {
      ...this.snapshot,
      conversations: {
        ...this.snapshot.conversations,
        [input.channelId]: [
          ...(this.snapshot.conversations[input.channelId] ?? []),
          {
            id: `outgoing:${commandId}`,
            channelId: input.channelId,
            role: 'user',
            text: input.text,
            timestamp: Date.now(),
            status: 'complete',
            source: 'desktop',
            commandId
          }
        ]
      }
    }
    for (const listener of this.listeners) listener(this.getSnapshot())
    return { commandId }
  }

  beginConversationScope(input: { runId: string; startedAt: number }): DesktopSnapshot {
    this.conversationScopes.push(structuredClone(input))
    this.snapshot = { ...this.snapshot, conversations: {}, updatedAt: this.snapshot.updatedAt + 1 }
    return this.getSnapshot()
  }

  addWaitingChannel(channelId: string): void {
    const template = this.snapshot.sessions[0]!
    this.snapshot = {
      ...this.snapshot,
      sessions: [...this.snapshot.sessions, {
        ...template,
        id: `sg-channel:${channelId}`,
        channelId,
        displayName: `SG Team CH-${channelId}`
      }],
      updatedAt: this.snapshot.updatedAt + 1
    }
    for (const listener of this.listeners) listener(this.getSnapshot())
  }

  setAllOffline(connectionPhase = 'offline'): void {
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) => ({
        ...session,
        online: false,
        connected: false,
        waiting: false,
        status: 'offline',
        connectionPhase
      })),
      updatedAt: this.snapshot.updatedAt + 1
    }
    for (const listener of this.listeners) listener(this.getSnapshot())
  }
}

function desktopSnapshot(waiting = true): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: 'shiguang://local-channel-runtime', attempt: 0, lastError: '' },
    sessions: ['1', '2'].map((channelId) => ({
      id: `sg-channel:${channelId}`,
      channelId,
      generation: 0,
      displayName: `SG Team CH-${channelId}`,
      roleName: '未绑定外置团队',
      status: waiting ? 'waiting' : 'idle',
      currentTask: '',
      queueDepth: 0,
      connectionPhase: waiting ? 'waiting' : '',
      online: true,
      connected: waiting,
      waiting,
      workingFiles: [],
      healthEvidence: [waiting ? 'check_messages 正在待命' : '尚未待命']
    })),
    conversations: {},
    protocolIssues: [],
    updatedAt: Date.now()
  }
}

function fixture(waiting = true) {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-team-service-')), 'control.sqlite3')
  const repository = new SqliteTeamControlRepository(path)
  const bridge = new FakeBridge(desktopSnapshot(waiting))
  const service = new TeamControlService(repository, bridge, 100)
  const selected = service.ensureWorkspace({
    workspaceId: 'alpha',
    workspaceName: 'alpha',
    workspacePath: '/workspace/alpha',
    channelIds: ['1', '2']
  })
  service.updateGoal('完成核心重构并通过回归测试')
  service.recordInstallation({
    workspaceId: 'alpha',
    runId: selected.activeRun!.id,
    generation: 'generation123',
    agents: selected.members.map((member) => ({
      agentSessionId: `alpha:ch-${member.slot.channelId}:generation123`,
      workspaceId: 'alpha',
      channelId: member.slot.channelId!,
      generation: 'generation123',
      runId: selected.activeRun!.id,
      capabilities: member.role.capabilities
    }))
  })
  return { repository, bridge, service }
}

function soloFixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-team-service-solo-')), 'control.sqlite3')
  const repository = new SqliteTeamControlRepository(path)
  const bundle = createConfiguredTeamBundle({
    workspaceId: 'mixed', workspaceName: 'mixed', workspacePath: '/workspace/mixed', now: 1_000,
    members: [
      { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
      { channelId: '2', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }
    ]
  })
  repository.upsertWorkspaceTeam(bundle)
  repository.updateRunGoal(bundle.run.id, '只启动团队成员，独立席由用户单聊')
  repository.recordInstallation({
    workspaceId: bundle.workspace.id, runId: bundle.run.id, generation: 'generation123',
    agents: bundle.slots.map((slot) => ({
      agentSessionId: `mixed:ch-${slot.channelId}:generation123`, workspaceId: bundle.workspace.id,
      channelId: slot.channelId!, generation: 'generation123', runId: bundle.run.id,
      capabilities: bundle.roles.find((role) => role.id === slot.roleId)!.capabilities
    }))
  })
  const desktop = desktopSnapshot(true)
  desktop.sessions = desktop.sessions.map((session) => session.channelId === '2'
    ? { ...session, online: false, connected: false, waiting: false, status: 'offline' as const, connectionPhase: 'offline' }
    : session)
  const bridge = new FakeBridge(desktop)
  const service = new TeamControlService(repository, bridge, 100)
  return { repository, bridge, service, bundle }
}

describe('TeamControlService', () => {
  it('creates an independent run without team goal, lead, or collaboration launch', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-independent-service-')), 'control.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const bridge = new FakeBridge(desktopSnapshot(false))
    const service = new TeamControlService(repository, bridge, 100)
    try {
      const snapshot = service.configureIndependentWorkspace({
        workspaceId: 'independent', workspaceName: 'independent', workspacePath: '/workspace/independent',
        members: [
          { channelId: '1', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true },
          { channelId: '2', roleTemplateKey: 'solo', avatarId: 'devops', skills: [], solo: true }
        ]
      })
      expect(workspaceRunMode(snapshot.activeRun)).toBe('independent')
      expect(snapshot.activeRun?.status).toBe('running')
      expect(snapshot.members.every((member) => member.slot.solo === true)).toBe(true)
      expect(bridge.sent).toHaveLength(0)
      expect(bridge.conversationScopes.at(-1)?.runId).toBe(snapshot.activeRun?.id)
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('replaces a team run with an independent batch even while its sessions still show live evidence (soft guard)', () => {
    // 会话围栏取代硬阻：旧会话在下一次轮询被围栏拒绝并自行退出，服务端不再以
    // 「全部离线」为前提；后果确认由渲染层负责。
    const data = fixture()
    try {
      const previous = data.service.getSnapshot().activeRun!
      const snapshot = data.service.configureIndependentWorkspace({
        workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha',
        members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }]
      })
      expect(workspaceRunMode(snapshot.activeRun)).toBe('independent')
      expect(snapshot.activeRun?.id).not.toBe(previous.id)
      // 未启动（ready）的旧团队 run 没有会话可围栏，只被新 run 取代，不伪造 completed。
      expect(snapshot.runs.find((run) => run.id === previous.id)?.status).toBe(previous.status)
      expect(data.bridge.conversationScopes.at(-1)?.runId).toBe(snapshot.activeRun?.id)
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('requires only team members to wait and sends launch instructions only to them', async () => {
    const data = soloFixture()
    try {
      expect(data.service.getSnapshot().preflight).toMatchObject({
        mcpInstalled: true,
        agentsWaiting: true,
        canLaunch: true
      })
      await data.service.launch()
      expect(data.bridge.sent.map((message) => message.channelId)).toEqual(['1'])
      const leadBinding = data.service.getSnapshot().bindings.find((binding) => binding.channelId === '1')!
      data.repository.recordAgentCheckIn({
        agentSessionId: leadBinding.agentSessionId,
        runId: leadBinding.runId,
        slotId: leadBinding.slotId,
        capabilities: ['coordination', 'planning']
      }, 'ready')
      expect(data.service.getSnapshot().activeRun?.status).toBe('running')
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('preserves solo topology when creating the next run', () => {
    const data = soloFixture()
    try {
      data.repository.beginLaunch(data.bundle.run.id, 1_500, 'next-run-binding-key')
      expect(data.repository.completeRun(data.bundle.run.id, 2_000)).toBe(true)
      const next = data.service.createNextRun()
      expect(next.members.map((member) => [member.role.templateKey, member.slot.solo])).toEqual([
        ['lead', false],
        ['solo', true]
      ])
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('stale launch recovery marks only team bindings uncertain and leaves solo untouched', () => {
    const data = soloFixture()
    data.service.dispose()
    data.repository.beginLaunch(data.bundle.run.id, 1, 'stale-launch-binding-key')
    const recovered = new TeamControlService(data.repository, data.bridge, 100)
    try {
      const byChannel = new Map(recovered.getSnapshot().bindings.map((binding) => [binding.channelId, binding]))
      expect(byChannel.get('1')?.launchStatus).toBe('uncertain')
      expect(byChannel.get('2')?.launchStatus).toBe('not_started')
    } finally {
      recovered.dispose()
      data.repository.close()
    }
  })
  it('reuses assembled team state until the repository revision changes', () => {
    const { repository, service } = fixture()
    const load = vi.spyOn(repository, 'loadTeamControl')
    try {
      service.getSnapshot()
      service.getSnapshot()
      service.getActiveRunId()
      expect(load).not.toHaveBeenCalled()

      const runId = service.getActiveRunId()!
      repository.updateRunGoal(runId, '外部进程写入的新目标')
      expect(service.getSnapshot().activeRun?.goal).toBe('外部进程写入的新目标')
      expect(load).toHaveBeenCalledTimes(1)
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('clears stale collaboration state for a prelaunch run on startup', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-service-')), 'control.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const bundle = createDefaultTeamBundle({
      workspaceId: 'alpha',
      workspaceName: 'alpha',
      workspacePath: '/workspace/alpha',
      channelIds: ['1', '2'],
      now: 1_000
    })
    repository.upsertWorkspaceTeam(bundle)
    const clearedRuns: string[] = []
    const bridge = new FakeBridge(desktopSnapshot())
    const service = new TeamControlService(repository, bridge, 100, undefined, {
      clearRun: (runId) => {
        clearedRuns.push(runId)
        return true
      }
    })

    try {
      const activeRun = service.getSnapshot().activeRun
      expect(activeRun?.id).toMatch(/^team-run:alpha:run-/)
      expect(activeRun?.id).not.toBe(bundle.run.id)
      expect(clearedRuns).toEqual([activeRun?.id])
      expect(bridge.conversationScopes.at(-1)).toMatchObject({ runId: activeRun?.id })
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('does not migrate a legacy main run that already has runtime bindings', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-bound-main-')), 'control.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const bundle = createDefaultTeamBundle({
      workspaceId: 'alpha',
      workspaceName: 'alpha',
      workspacePath: '/workspace/alpha',
      channelIds: ['1', '2'],
      now: 1_000
    })
    repository.upsertWorkspaceTeam(bundle)
    repository.updateRunGoal(bundle.run.id, '保持旧会话连续')
    repository.recordInstallation({
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
    const clearedRuns: string[] = []
    const bridge = new FakeBridge(desktopSnapshot())
    const service = new TeamControlService(repository, bridge, 100, undefined, {
      clearRun: (runId) => {
        clearedRuns.push(runId)
        return true
      }
    })

    try {
      expect(service.getSnapshot().activeRun?.id).toBe(bundle.run.id)
      expect(clearedRuns).toEqual([bundle.run.id])
      expect(bridge.conversationScopes.at(-1)).toMatchObject({ runId: bundle.run.id })
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('creates a fresh TeamRun each time a workspace team is configured', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-fresh-run-')), 'control.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const bridge = new FakeBridge(desktopSnapshot())
    const service = new TeamControlService(repository, bridge, 100)
    try {
      const first = service.configureWorkspace({
        workspaceId: 'alpha',
        workspaceName: 'alpha',
        workspacePath: '/workspace/alpha',
        members: [
          { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] }
        ]
      }).activeRun!
      const second = service.configureWorkspace({
        workspaceId: 'alpha',
        workspaceName: 'alpha',
        workspacePath: '/workspace/alpha',
        members: [
          { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] }
        ]
      }).activeRun!

      expect(first.id).toMatch(/^team-run:alpha:run-/)
      expect(second.id).toMatch(/^team-run:alpha:run-/)
      expect(second.id).not.toBe(first.id)
      expect(bridge.conversationScopes.map((scope) => scope.runId)).toContain(second.id)
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('persists per-channel model selection to the slot and reads it back after reopen', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-slot-model-')), 'control.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const bridge = new FakeBridge(desktopSnapshot())
    const service = new TeamControlService(repository, bridge, 100)
    try {
      service.configureWorkspace({
        workspaceId: 'alpha',
        workspaceName: 'alpha',
        workspacePath: '/workspace/alpha',
        members: [
          { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] }
        ]
      })
      service.setSlotModelSelection('2', {
        modelId: 'claude-opus-5',
        displayName: 'Claude Opus 5',
        parameters: [{ id: 'effort', value: 'max' }, { id: 'context', value: '1m' }],
        maxMode: true
      })
      const selection = {
        modelId: 'claude-opus-5',
        displayName: 'Claude Opus 5',
        parameters: [{ id: 'effort', value: 'high' }, { id: 'context', value: '1m' }],
        maxMode: true
      }
      service.setSlotModelSelection('2', selection)
      expect(service.getSnapshot().members.find((member) => member.slot.channelId === '2')?.slot.modelSelection)
        .toEqual(selection)

      // 重启回读：新仓库实例重装配同一库，选定值仍一一对应
      const reopened = new SqliteTeamControlRepository(path)
      try {
        const slot = reopened.loadTeamControl().slots.find((candidate) => candidate.channelId === '2')
        expect(slot?.modelSelection).toEqual(selection)
      } finally {
        reopened.close()
      }
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('clears collaboration state when a workspace team is recreated and launched', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-service-')), 'control.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const bridge = new FakeBridge(desktopSnapshot())
    const clearedRuns: string[] = []
    const service = new TeamControlService(repository, bridge, 100, undefined, {
      clearRun: (runId) => {
        clearedRuns.push(runId)
        return true
      }
    })
    try {
      const created = service.configureWorkspace({
        workspaceId: 'alpha',
        workspaceName: 'alpha',
        workspacePath: '/workspace/alpha',
        members: [
          { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] }
        ]
      })

      expect(created.activeRun?.id).toMatch(/^team-run:alpha:run-/)
      expect(clearedRuns).toEqual([created.activeRun?.id])
      service.updateGoal('完成核心重构并通过回归测试')
      service.recordInstallation({
        workspaceId: 'alpha',
        runId: created.activeRun!.id,
        generation: 'generation123',
        agents: created.members.map((member) => ({
          agentSessionId: `alpha:ch-${member.slot.channelId}:generation123`,
          workspaceId: 'alpha',
          channelId: member.slot.channelId!,
          generation: 'generation123',
          runId: created.activeRun!.id,
          capabilities: [...member.role.capabilities]
        }))
      })

      clearedRuns.length = 0
      await service.launch()
      expect(clearedRuns).toEqual([created.activeRun?.id])
    } finally {
      repository.close()
    }
  })

  it('exposes an unsaved goal as a visible launch gate even when every channel check passes', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-goal-gate-')), 'control.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const bridge = new FakeBridge(desktopSnapshot(true))
    const service = new TeamControlService(repository, bridge, 100)
    try {
      const selected = service.ensureWorkspace({
        workspaceId: 'alpha',
        workspaceName: 'alpha',
        workspacePath: '/workspace/alpha',
        channelIds: ['1', '2']
      })
      service.recordInstallation({
        workspaceId: 'alpha',
        runId: selected.activeRun!.id,
        generation: 'generation123',
        agents: selected.members.map((member) => ({
          agentSessionId: `alpha:ch-${member.slot.channelId}:generation123`,
          workspaceId: 'alpha',
          channelId: member.slot.channelId!,
          generation: 'generation123',
          runId: selected.activeRun!.id,
          capabilities: member.role.capabilities
        }))
      })

      const snapshot = service.getSnapshot()
      expect(snapshot.preflight).toMatchObject({
        bridgeConnected: true,
        workspaceBound: true,
        goalDefined: false,
        mcpInstalled: true,
        agentsWaiting: true,
        canLaunch: false
      })
      expect(snapshot.preflight.blockers[0]).toMatch(/填写并保存团队目标/)
      expect(snapshot.activeRun?.status).toBe('draft')
      expect(() => service.launch()).toThrowError(/填写并保存团队目标/)
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('requires every installed runtime to be online and waiting before launch', () => {
    const { repository, bridge, service } = fixture(false)
    try {
      const snapshot = service.getSnapshot()
      expect(snapshot.preflight).toMatchObject({
        bridgeConnected: true,
        workspaceBound: true,
        mcpInstalled: true,
        agentsWaiting: false,
        canLaunch: false
      })
      expect(() => service.launch()).toThrowError(/并非所有 Agent 通道都已在线待命/)
      expect(bridge.sent).toEqual([])
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('does not block launch for an outside channel that is discovered but unregistered', () => {
    const { repository, bridge, service } = fixture(true)
    try {
      expect(service.getSnapshot().preflight.mcpInstalled).toBe(true)
      bridge.addWaitingChannel('3')
      const snapshot = service.getSnapshot()
      expect(snapshot.runtimeChannels.map((channel) => [channel.channelId, channel.registered])).toEqual([
        ['1', true], ['2', true], ['3', false]
      ])
      // 一体化后 preflight 只对本轮成员（slot/binding）口径负责：
      // 局外通道（未加入团队的待机运行时）不再拦截启动。
      expect(snapshot.preflight.mcpInstalled).toBe(true)
      expect(snapshot.preflight.blockers).not.toContain('Agent MCP 尚未接入全部本轮通道')
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('marks MCP incomplete when a member channel lacks registration', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-no-install-')), 'control.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const bridge = new FakeBridge(desktopSnapshot(true))
    const service = new TeamControlService(repository, bridge, 100)
    try {
      service.ensureWorkspace({
        workspaceId: 'alpha',
        workspaceName: 'alpha',
        workspacePath: '/workspace/alpha',
        channelIds: ['1', '2']
      })
      service.updateGoal('完成核心重构并通过回归测试')
      // 安装批次与团队拓扑强一致（仓库校验），因此「成员缺注册」
      // 的现实形态就是尚未完成安装：成员无 binding。
      const snapshot = service.getSnapshot()
      expect(snapshot.preflight.mcpInstalled).toBe(false)
      expect(snapshot.preflight.blockers).toContain('Agent MCP 尚未接入全部本轮通道')
      expect(snapshot.preflight.canLaunch).toBe(false)
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('records delivery without claiming that the agents acknowledged', async () => {
    const { repository, bridge, service } = fixture(true)
    try {
      expect(service.getSnapshot().preflight.canLaunch).toBe(true)
      const launched = await service.launch()
      expect(bridge.sent).toHaveLength(2)
      expect(bridge.sent.every((message) => message.text.includes('team_check_in'))).toBe(true)
      const launchedBindings = launched.bindings
      expect(bridge.sent.every((message) => {
        const channelId = message.channelId
        const binding = launchedBindings.find((value) => value.channelId === channelId)
        return Boolean(binding && message.text.includes(
          `[[SG_TEAM_BIND:${binding.composerBindingKey}:CH-${channelId}]]`
        ))
      })).toBe(true)
      expect(launched.activeRun?.status).toBe('launching')
      expect(launched.bindings.every((binding) => binding.launchStatus === 'delivered')).toBe(true)
      expect(launched.members.every((member) => member.readiness === 'launching')).toBe(true)
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('settles a failed session creation out of launching without damaging successful channels', async () => {
    const { repository, service } = fixture(true)
    try {
      service.ensureRunLaunched()
      const before = service.getSnapshot()
      expect(before.activeRun?.status).toBe('launching')

      service.settleAgentSessionLaunch({
        id: 'failed-launch-plan',
        state: 'failed',
        startedAt: 100,
        finishedAt: 200,
        items: [
          { channelId: '1', stage: 'failed', message: 'Cursor 会话未启动' },
          { channelId: '2', stage: 'done', message: '会话已就绪', composerId: 'composer-2' }
        ]
      })

      const settled = service.getSnapshot()
      expect(settled.activeRun?.status).toBe('attention')
      expect(settled.bindings.find((binding) => binding.channelId === '1')?.launchStatus).toBe('failed')
      expect(settled.bindings.find((binding) => binding.channelId === '1')?.launchDetail).toBe('Cursor 会话未启动')
      expect(settled.bindings.find((binding) => binding.channelId === '2')?.launchStatus).toBe('not_started')
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('changes the run to running only after all current generations check in', async () => {
    const { repository, bridge, service } = fixture(true)
    try {
      await service.launch()
      const bindings = service.getSnapshot().bindings
      for (const binding of bindings) {
        repository.recordAgentCheckIn({
          agentSessionId: binding.agentSessionId,
          runId: binding.runId,
          capabilities: []
        }, 'ready')
      }
      const snapshot = service.getSnapshot()
      expect(snapshot.activeRun?.status).toBe('running')
      expect(snapshot.members.every((member) => member.readiness === 'active')).toBe(true)
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('creates a fresh run from persisted channel assignments after every Agent goes offline', async () => {
    const { repository, bridge, service } = fixture(true)
    try {
      await service.launch()
      const previous = service.getSnapshot().activeRun!
      for (const binding of service.getSnapshot().bindings) {
        repository.recordAgentCheckIn({
          agentSessionId: binding.agentSessionId,
          runId: binding.runId,
          capabilities: []
        }, 'ready')
      }
      expect(repository.completeRun(previous.id, 500)).toBe(true)
      expect(Object.keys(bridge.getSnapshot().conversations).length).toBeGreaterThan(0)
      bridge.setAllOffline()

      const next = service.createNextRun()
      expect(next.activeRun).toMatchObject({ status: 'draft', goal: '' })
      expect(next.activeRun?.id).not.toBe(previous.id)
      expect(next.runs.find((run) => run.id === previous.id)?.status).toBe('completed')
      expect(next.members.map((member) => member.slot.channelId)).toEqual(['1', '2'])
      expect(next.members.every((member) => !member.binding)).toBe(true)
      expect(new Set(next.members.map((member) => member.slot.id)).size).toBe(2)
      expect(next.members.some((member) => member.slot.id.includes(':main:'))).toBe(false)
      expect(bridge.conversationScopes.at(-1)).toMatchObject({ runId: next.activeRun?.id })
      expect(bridge.getSnapshot().conversations).toEqual({})
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('lets the operator explicitly end an offline run and start fresh', async () => {
    const { repository, bridge, service } = fixture(true)
    try {
      await service.launch()
      const previous = service.getSnapshot().activeRun!
      for (const binding of service.getSnapshot().bindings) {
        repository.recordAgentCheckIn({
          agentSessionId: binding.agentSessionId,
          runId: binding.runId,
          capabilities: []
        }, 'ready')
      }
      bridge.setAllOffline()

      const next = service.createNextRun()
      expect(next.activeRun).toMatchObject({ status: 'draft', goal: '' })
      expect(next.activeRun?.id).not.toBe(previous.id)
      expect(next.runs.find((run) => run.id === previous.id)?.status).toBe('completed')
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('protects an offline-looking run while an Agent still owns in-flight work', async () => {
    const { repository, bridge, service } = fixture(true)
    try {
      await service.launch()
      for (const binding of service.getSnapshot().bindings) {
        repository.recordAgentCheckIn({
          agentSessionId: binding.agentSessionId,
          runId: binding.runId,
          capabilities: []
        }, 'ready')
      }
      bridge.setAllOffline('processing')
      expect(() => service.createNextRun()).toThrowError(/执行中的 Agent/)
      expect(service.getSnapshot().activeRun?.status).toBe('running')
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('uses verified Cursor activity for Team member status instead of MCP heartbeat alone', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-presence-')), 'control.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const bridge = new FakeBridge(desktopSnapshot(true))
    const source: CursorComposerTelemetrySource = {
      readWorkspace: (_workspace, bindings) => ({
        availability: 'available',
        workspacePath: '/workspace/alpha',
        composers: bindings.flatMap((binding) => binding.composerId ? [{
          composerId: binding.composerId,
          title: `CH-${binding.channelId}`,
          activity: {
            state: 'stopped' as const,
            channelId: binding.channelId,
            detail: 'Agent 已停止监听'
          }
        }] : []),
        bindingCandidates: [],
        updatedAt: Date.now()
      })
    }
    const service = new TeamControlService(repository, bridge, 100, source)
    try {
      const selected = service.ensureWorkspace({
        workspaceId: 'alpha',
        workspaceName: 'alpha',
        workspacePath: '/workspace/alpha',
        channelIds: ['1', '2']
      })
      service.updateGoal('验证 Agent 活性')
      service.recordInstallation({
        workspaceId: 'alpha',
        runId: selected.activeRun!.id,
        generation: 'generation123',
        agents: selected.members.map((member) => ({
          agentSessionId: `alpha:ch-${member.slot.channelId}:generation123`,
          workspaceId: 'alpha',
          channelId: member.slot.channelId!,
          generation: 'generation123',
          runId: selected.activeRun!.id,
          capabilities: member.role.capabilities
        }))
      })
      await service.launch()
      for (const binding of service.getSnapshot().bindings) {
        service.recordComposerBinding({
          runId: binding.runId,
          slotId: binding.slotId,
          generation: binding.generation,
          bindingKey: binding.composerBindingKey,
          composerId: `composer-${binding.channelId}-verified`,
          method: 'launch_marker'
        })
      }

      const snapshot = service.getSnapshot()

      expect(snapshot.members.every((member) => member.runtime?.online === false)).toBe(true)
      expect(snapshot.members.every((member) => member.readiness === 'offline')).toBe(true)
      expect(snapshot.preflight.agentsWaiting).toBe(false)
    } finally {
      service.dispose()
      repository.close()
    }
  })
})

describe('独立模式 → 团队切换（会话围栏软守卫）', () => {
  function independentFixture(online: boolean) {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-ind-to-team-')), 'control.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const desktop = desktopSnapshot(false)
    desktop.sessions = desktop.sessions.map((session) => (
      { ...session, online, connected: online, waiting: online, status: online ? 'waiting' as const : 'offline' as const, connectionPhase: online ? 'waiting' : 'offline' }
    ))
    const bridge = new FakeBridge(desktop)
    const service = new TeamControlService(repository, bridge, 100)
    service.configureIndependentWorkspace({
      workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha',
      members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }]
    })
    return { repository, bridge, service }
  }

  it('switches to a team run while solo sessions are still online: the independent run is completed, not blocked', () => {
    const data = independentFixture(true)
    try {
      const previous = data.service.getSnapshot().activeRun!
      expect(previous.status).toBe('running')
      const snapshot = data.service.configureWorkspace({
        workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha',
        members: [{ channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] }]
      })
      expect(workspaceRunMode(snapshot.activeRun)).toBe('team')
      expect(snapshot.activeRun?.id).not.toBe(previous.id)
      // 旧独立 run 显式收尾：围栏据此把仍持旧令牌的会话判为 retired。
      expect(snapshot.runs.find((run) => run.id === previous.id)?.status).toBe('completed')
      expect(data.bridge.conversationScopes.at(-1)?.runId).toBe(snapshot.activeRun?.id)
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('replaces the independent run with a team run once every solo session is offline', () => {
    const data = independentFixture(false)
    try {
      const snapshot = data.service.configureWorkspace({
        workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha',
        members: [{ channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] }]
      })
      expect(workspaceRunMode(snapshot.activeRun)).toBe('team')
      expect(snapshot.members.map((member) => member.role.templateKey)).toEqual(['lead'])
      expect(snapshot.members.some((member) => member.slot.solo === true)).toBe(false)
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('records why the previous run ended when it is replaced, so the lobby does not claim "all agents offline"', () => {
    const data = independentFixture(true)
    try {
      const previous = data.service.getSnapshot().activeRun!
      data.repository.recordInstallation({
        workspaceId: 'alpha', runId: previous.id, generation: 'generation123',
        agents: [{
          agentSessionId: 'alpha:ch-1:generation123', workspaceId: 'alpha', channelId: '1',
          generation: 'generation123', runId: previous.id, capabilities: []
        }]
      })
      data.service.configureIndependentWorkspace({
        workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha',
        members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }]
      })
      const retired = data.repository.loadTeamControl().bindings.find((binding) => binding.runId === previous.id)!
      expect(retired.launchStatus).toBe('failed')
      expect(retired.launchDetail).toContain('已被新的运行替换')
      expect(retired.launchDetail).toContain('会话围栏')
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('ends an independent batch explicitly and reports the user-initiated reason', () => {
    const data = independentFixture(true)
    try {
      const run = data.service.getSnapshot().activeRun!
      data.repository.recordInstallation({
        workspaceId: 'alpha', runId: run.id, generation: 'generation123',
        agents: [{
          agentSessionId: 'alpha:ch-1:generation123', workspaceId: 'alpha', channelId: '1',
          generation: 'generation123', runId: run.id, capabilities: []
        }]
      })
      const snapshot = data.service.endActiveRun()
      expect(snapshot.activeRun).toMatchObject({ id: run.id, status: 'completed' })
      expect(workspaceRunMode(snapshot.activeRun)).toBe('independent')
      expect(snapshot.bindings.find((binding) => binding.runId === run.id)?.launchDetail).toBe('用户已结束本轮运行')
      // 围栏据 completed 状态把仍持令牌的旧会话判为 run_completed。
      expect(data.repository.resolveChannelSessionOwner('1')).toMatchObject({ runId: run.id, runStatus: 'completed' })
      expect(() => data.service.endActiveRun()).toThrow(/已经结束/)
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('refuses to end a run that has no sessions yet and explains why', () => {
    const configured = fixture()
    try {
      // fixture 的团队 run 已安装但未启动（ready）：没有会话可结束。
      expect(configured.service.getSnapshot().activeRun?.status).toBe('ready')
      expect(() => configured.service.endActiveRun()).toThrow(/尚未启动/)
    } finally {
      configured.service.dispose()
      configured.repository.close()
    }
    const path = join(mkdtempSync(join(tmpdir(), 'sg-end-empty-')), 'control.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const service = new TeamControlService(repository, new FakeBridge(desktopSnapshot(false)), 100)
    try {
      expect(() => service.endActiveRun()).toThrow(/没有可结束的运行/)
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('keeps the only hard block: no mode switch, batch replacement or end while a launch is being delivered', async () => {
    const data = fixture(true)
    try {
      const launch = data.service.launch()
      const solo = {
        workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha',
        members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }]
      }
      expect(() => data.service.configureIndependentWorkspace(solo)).toThrow(/启动指令正在投递/)
      expect(() => data.service.configureWorkspace({
        ...solo, members: [{ channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] }]
      })).toThrow(/启动指令正在投递/)
      expect(() => data.service.endActiveRun()).toThrow(/启动指令正在投递/)
      expect(() => data.service.createNextRun()).toThrow(/启动指令正在投递/)
      await launch
      // 投递结束后不再硬阻：独立批次替换正在 launching 的团队 run。
      const snapshot = data.service.configureIndependentWorkspace(solo)
      expect(workspaceRunMode(snapshot.activeRun)).toBe('independent')
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })
})
