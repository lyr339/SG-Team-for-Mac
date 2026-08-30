import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TeamControlService, type TeamControlBridge } from '../src/application/team-control-service'
import type { DesktopSnapshot, SendMessageInput } from '../src/shared/desktop-api'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import type { CursorComposerTelemetrySource } from '../src/infrastructure/cursor/cursor-composer-telemetry'
import { createDefaultTeamBundle } from '../src/domain/team-control'

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
        id: `qingtian-channel:${channelId}`,
        channelId,
        displayName: `QingTian CH-${channelId}`
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
      id: `qingtian-channel:${channelId}`,
      channelId,
      generation: 0,
      displayName: `QingTian CH-${channelId}`,
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
  const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-service-')), 'control.sqlite3')
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

describe('TeamControlService', () => {
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
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-service-')), 'control.sqlite3')
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
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-bound-main-')), 'control.sqlite3')
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
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-fresh-run-')), 'control.sqlite3')
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
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-slot-model-')), 'control.sqlite3')
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
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-service-')), 'control.sqlite3')
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
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-goal-gate-')), 'control.sqlite3')
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
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-no-install-')), 'control.sqlite3')
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
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-presence-')), 'control.sqlite3')
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
