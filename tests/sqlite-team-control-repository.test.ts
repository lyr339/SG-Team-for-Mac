import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createConfiguredTeamBundle, createDefaultTeamBundle } from '../src/domain/team-control'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'

function repositoryFixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-team-control-')), 'control.sqlite3')
  return new SqliteTeamControlRepository(path)
}

function bundle(workspaceId: string, channelIds = ['1']) {
  return createDefaultTeamBundle({
    workspaceId,
    workspaceName: workspaceId,
    workspacePath: `/workspace/${workspaceId}`,
    channelIds,
    now: 100
  })
}

describe('SqliteTeamControlRepository', () => {
  it('keeps workspace runs isolated and preserves each goal when switching', () => {
    const repository = repositoryFixture()
    try {
      const alpha = bundle('alpha')
      const beta = bundle('beta')
      repository.upsertWorkspaceTeam(alpha)
      repository.updateRunGoal(alpha.run.id, 'Alpha 目标')
      repository.upsertWorkspaceTeam(beta)
      repository.updateRunGoal(beta.run.id, 'Beta 目标')

      let state = repository.loadTeamControl()
      expect(state.activeWorkspaceId).toBe('beta')
      expect(state.runs).toHaveLength(2)
      expect(state.runs.find((run) => run.id === alpha.run.id)?.goal).toBe('Alpha 目标')

      repository.setActiveWorkspace('alpha')
      state = repository.loadTeamControl()
      expect(state.activeWorkspaceId).toBe('alpha')
      expect(state.runs.find((run) => run.id === beta.run.id)?.goal).toBe('Beta 目标')
    } finally {
      repository.close()
    }
  })

  it('persists configurable roles, assigned skills and stable avatar identities', () => {
    const repository = repositoryFixture()
    try {
      const team = createConfiguredTeamBundle({
        workspaceId: 'configured',
        workspaceName: 'configured',
        workspacePath: '/workspace/configured',
        members: [
          { channelId: '2', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          {
            channelId: '7', roleTemplateKey: 'frontend', avatarId: 'frontend',
            skills: [{ id: 'project:frontend-design', name: 'frontend-design', description: 'UI skill', scope: 'project' }],
            modelSelection: {
              modelId: 'gpt-5.3-codex', displayName: 'Codex 5.3', maxMode: false,
              parameters: [{ id: 'reasoning', value: 'high' }]
            }
          },
          { channelId: '19', roleTemplateKey: 'reviewer', avatarId: 'reviewer', skills: [] }
        ],
        now: 100
      })
      repository.upsertWorkspaceTeam(team)
      const state = repository.loadTeamControl()
      expect(state.schemaVersion).toBe(7)
      expect(state.roles.find((role) => role.templateKey === 'frontend')).toMatchObject({
        skills: [{ id: 'project:frontend-design', name: 'frontend-design' }]
      })
      expect(state.slots.map((slot) => [slot.channelId, slot.avatarId])).toEqual([
        ['2', 'lead'], ['7', 'frontend'], ['19', 'reviewer']
      ])
      expect(state.slots.find((slot) => slot.channelId === '7')?.modelSelection).toEqual({
        modelId: 'gpt-5.3-codex', displayName: 'Codex 5.3', maxMode: false,
        parameters: [{ id: 'reasoning', value: 'high' }]
      })
    } finally {
      repository.close()
    }
  })

  it('persists solo slots and rejects both identity resolution entry points with solo_channel', () => {
    const repository = repositoryFixture()
    try {
      const team = createConfiguredTeamBundle({
        workspaceId: 'solo-persist', workspaceName: 'solo-persist', workspacePath: '/workspace/solo-persist', now: 100,
        members: [
          { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          { channelId: '2', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }
        ]
      })
      repository.upsertWorkspaceTeam(team)
      repository.recordInstallation({
        workspaceId: team.workspace.id, runId: team.run.id, generation: 'generation123',
        agents: team.slots.map((slot) => ({
          agentSessionId: `solo-persist:ch-${slot.channelId}:generation123`, workspaceId: team.workspace.id,
          channelId: slot.channelId!, generation: 'generation123', runId: team.run.id,
          capabilities: team.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })
      expect(repository.loadTeamControl().slots.find((slot) => slot.channelId === '2')?.solo).toBe(true)
      for (const resolve of [
        () => repository.resolveChannelAgentIdentity('2'),
        () => repository.resolveAgentRuntimeIdentity('solo-persist:ch-2:generation123', team.run.id)
      ]) {
        try {
          resolve()
          throw new Error('expected solo_channel')
        } catch (error) {
          expect(error).toMatchObject({ code: 'solo_channel' })
          expect((error as Error).message).toContain('check_messages / record_reply')
        }
      }
    } finally {
      repository.close()
    }
  })

  it('degrades to run_completed guidance after the run wraps up instead of a hard auth error (P0-2)', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('archive', ['1', '2'])
      repository.upsertWorkspaceTeam(team)
      repository.recordInstallation({
        workspaceId: 'archive', runId: team.run.id, generation: 'generation123',
        agents: team.slots.map((slot) => ({
          agentSessionId: `archive:ch-${slot.channelId}:generation123`, workspaceId: 'archive',
          channelId: slot.channelId!, generation: 'generation123', runId: team.run.id,
          capabilities: team.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })
      expect(repository.resolveChannelAgentIdentity('1')).toMatchObject({ runId: team.run.id })
      repository.updateRunGoal(team.run.id, '归档语义验证')
      repository.beginLaunch(team.run.id, 200, 'launch-key-archive')
      expect(repository.completeRun(team.run.id, 300)).toBe(true)

      // run 收尾撤销注册是轮次归档：曾注册的通道得到「本轮已结束 + 如何恢复」
      // 的指引，而非 2026-09-01 事故里把 Agent 永久锁死的授权硬错。
      try {
        repository.resolveChannelAgentIdentity('1')
        throw new Error('expected run_completed')
      } catch (error) {
        expect(error).toMatchObject({ code: 'run_completed' })
        expect((error as Error).message).toContain('record_reply')
        expect((error as Error).message).toContain('check_messages')
      }
      // 从未注册到本轮的通道保持普通未注册语义。
      try {
        repository.resolveChannelAgentIdentity('9')
        throw new Error('expected agent_not_authorized')
      } catch (error) {
        expect(error).toMatchObject({ code: 'agent_not_authorized' })
      }
    } finally {
      repository.close()
    }
  })

  it('reconfigures an installed team to the exact selected seats', () => {
    const repository = repositoryFixture()
    try {
      const eightSeatTeam = bundle('alpha', ['1', '2', '3', '4', '5', '6', '7', '8'])
      repository.upsertWorkspaceTeam(eightSeatTeam)
      repository.updateRunGoal(eightSeatTeam.run.id, '实现并验证')
      repository.recordInstallation({
        workspaceId: 'alpha',
        runId: eightSeatTeam.run.id,
        generation: 'generation123',
        agents: eightSeatTeam.slots.map((slot) => ({
          agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
          workspaceId: 'alpha',
          channelId: slot.channelId!,
          generation: 'generation123',
          runId: eightSeatTeam.run.id,
          capabilities: eightSeatTeam.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })
      expect(repository.loadTeamControl().bindings.filter((binding) => binding.runId === eightSeatTeam.run.id))
        .toHaveLength(8)

      const fourSeatTeam = createConfiguredTeamBundle({
        workspaceId: 'alpha',
        workspaceName: 'alpha',
        workspacePath: '/workspace/alpha',
        members: [
          { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] },
          { channelId: '3', roleTemplateKey: 'reviewer', avatarId: 'reviewer', skills: [] },
          { channelId: '4', roleTemplateKey: 'specialist', avatarId: 'frontend', skills: [] }
        ],
        now: 200
      })
      repository.upsertWorkspaceTeam(fourSeatTeam)

      const state = repository.loadTeamControl()
      const run = state.runs.find((candidate) => candidate.id === fourSeatTeam.run.id)!
      expect(run.status).toBe('draft')
      expect(state.slots.filter((slot) => slot.runId === run.id).map((slot) => slot.channelId)).toEqual(['1', '2', '3', '4'])
      expect(state.roles.filter((role) => role.runId === run.id).map((role) => role.templateKey)).toEqual([
        'lead', 'builder', 'reviewer', 'specialist'
      ])
      expect(state.bindings.filter((binding) => binding.runId === run.id)).toHaveLength(0)
    } finally {
      repository.close()
    }
  })

  it('separates delivery from acknowledgement and runs only after every agent checks in', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('alpha', ['1', '2'])
      repository.upsertWorkspaceTeam(team)
      repository.updateRunGoal(team.run.id, '实现并验证')
      repository.recordInstallation({
        workspaceId: 'alpha',
        runId: team.run.id,
        generation: 'generation123',
        agents: team.slots.map((slot) => ({
          agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
          workspaceId: 'alpha',
          channelId: slot.channelId!,
          generation: 'generation123',
          runId: team.run.id,
          capabilities: team.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })
      repository.beginLaunch(team.run.id, 200, 'launch-attempt-1')
      for (const slot of team.slots) {
        repository.recordLaunchDelivery({
          runId: team.run.id,
          slotId: slot.id,
          status: 'delivered',
          commandId: `command-${slot.channelId}`,
          detail: '已投递'
        })
      }

      let state = repository.loadTeamControl()
      expect(state.runs[0]?.status).toBe('launching')
      expect(state.bindings.every((binding) => binding.launchStatus === 'delivered')).toBe(true)

      const first = state.bindings[0]!
      repository.recordAgentCheckIn({
        agentSessionId: first.agentSessionId,
        runId: first.runId,
        capabilities: []
      }, '已读取角色边界')
      expect(repository.loadTeamControl().runs[0]?.status).toBe('launching')

      const second = state.bindings[1]!
      repository.recordAgentCheckIn({
        agentSessionId: second.agentSessionId,
        runId: second.runId,
        capabilities: []
      }, '已读取团队目标')
      state = repository.loadTeamControl()
      expect(state.runs[0]?.status).toBe('running')
      expect(state.bindings.every((binding) => binding.launchStatus === 'acknowledged')).toBe(true)
    } finally {
      repository.close()
    }
  })

  it('keeps the launched status when an installation batch re-registers after launch', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('alpha', ['1', '2'])
      repository.upsertWorkspaceTeam(team)
      repository.updateRunGoal(team.run.id, '实现并验证')
      const install = (generation: string) => repository.recordInstallation({
        workspaceId: 'alpha',
        runId: team.run.id,
        generation,
        agents: team.slots.map((slot) => ({
          agentSessionId: `alpha:ch-${slot.channelId}:${generation}`,
          workspaceId: 'alpha',
          channelId: slot.channelId!,
          generation,
          runId: team.run.id,
          capabilities: team.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })
      install('generation123')
      repository.beginLaunch(team.run.id, 200, 'launch-attempt-1')
      expect(repository.loadTeamControl().runs[0]?.status).toBe('launching')

      // 启动后安装器再次登记（通道补装/重激活）：不得抹掉已启动标记，
      // 否则 team_check_in 被 team_run_not_launched 永久误拒而消息通道照常工作
      install('generation456')
      const state = repository.loadTeamControl()
      expect(state.runs[0]?.status).toBe('launching')
      expect(state.runs[0]?.launchedAt).toBe(200)

      // check_in 正常放行并推进 acknowledged
      const binding = state.bindings[0]!
      const receipt = repository.recordAgentCheckIn({
        agentSessionId: binding.agentSessionId,
        runId: binding.runId,
        capabilities: []
      }, '重新确认角色边界')
      expect(receipt.runId).toBe(team.run.id)
      expect(repository.loadTeamControl().bindings[0]?.launchStatus).toBe('acknowledged')
    } finally {
      repository.close()
    }
  })

  it('rejects an Agent acknowledgement before the TeamRun has launched', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('alpha')
      repository.upsertWorkspaceTeam(team)
      repository.recordInstallation({
        workspaceId: 'alpha',
        runId: team.run.id,
        generation: 'generation123',
        agents: [{
          agentSessionId: 'alpha:ch-1:generation123',
          workspaceId: 'alpha',
          channelId: '1',
          generation: 'generation123',
          runId: team.run.id,
          capabilities: ['coordination', 'planning']
        }]
      })

      expect(repository.loadTeamControl().runs[0]?.status).toBe('draft')

      expect(() => repository.recordAgentCheckIn({
        agentSessionId: 'alpha:ch-1:generation123',
        runId: team.run.id,
        capabilities: ['coordination', 'planning']
      }, '提前确认')).toThrowError(/尚未启动/)
      expect(repository.loadTeamControl().bindings[0]?.launchStatus).toBe('not_started')
    } finally {
      repository.close()
    }
  })

  it('self-heals a goal-ready run when an Agent checks in from a session-created prompt', () => {
    const repository = repositoryFixture()
    try {
      // 会话创建路径（一键创建会话）只投递启动提示、不调用 beginLaunch；
      // Agent 收到提示即 check_in，状态机应原地推进到 launching 而非误拒。
      const team = bundle('alpha', ['1', '2'])
      repository.upsertWorkspaceTeam(team)
      repository.updateRunGoal(team.run.id, '实现并验证')
      repository.recordInstallation({
        workspaceId: 'alpha',
        runId: team.run.id,
        generation: 'generation123',
        agents: team.slots.map((slot) => ({
          agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
          workspaceId: 'alpha',
          channelId: slot.channelId!,
          generation: 'generation123',
          runId: team.run.id,
          capabilities: team.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })
      expect(repository.loadTeamControl().runs[0]?.status).toBe('ready')

      const first = repository.loadTeamControl().bindings[0]!
      const receipt = repository.recordAgentCheckIn({
        agentSessionId: first.agentSessionId,
        runId: first.runId,
        capabilities: []
      }, '会话创建后直接确认')
      expect(receipt.runId).toBe(team.run.id)

      let state = repository.loadTeamControl()
      expect(state.runs[0]?.status).toBe('launching')
      expect(state.runs[0]?.launchedAt).not.toBeNull()
      expect(state.bindings.find((binding) => binding.id === first.id)?.launchStatus).toBe('acknowledged')

      // 全部确认后照旧推进 running
      const second = state.bindings.find((binding) => binding.id !== first.id)!
      repository.recordAgentCheckIn({
        agentSessionId: second.agentSessionId,
        runId: second.runId,
        capabilities: []
      }, '已读取团队目标')
      state = repository.loadTeamControl()
      expect(state.runs[0]?.status).toBe('running')
    } finally {
      repository.close()
    }
  })

  it('self-heals a draft run with a goal (topology reset) on Agent check-in', () => {
    const repository = repositoryFixture()
    try {
      // 拓扑变更会把 run 打回 draft 但保留目标；此后重建会话的 check_in 同样自愈。
      const team = bundle('alpha', ['1'])
      repository.upsertWorkspaceTeam(team)
      repository.updateRunGoal(team.run.id, '实现并验证')
      repository.recordInstallation({
        workspaceId: 'alpha',
        runId: team.run.id,
        generation: 'generation123',
        agents: [{
          agentSessionId: 'alpha:ch-1:generation123',
          workspaceId: 'alpha',
          channelId: '1',
          generation: 'generation123',
          runId: team.run.id,
          capabilities: ['coordination', 'planning']
        }]
      })
      repository.beginLaunch(team.run.id, 200, 'launch-attempt-1')
      // 模拟拓扑变更（1 席扩为 2 席）：状态打回 draft（保留目标），bindings 重建
      const expanded = bundle('alpha', ['1', '2'])
      repository.upsertWorkspaceTeam(expanded)
      expect(repository.loadTeamControl().runs[0]?.status).toBe('draft')
      repository.recordInstallation({
        workspaceId: 'alpha',
        runId: team.run.id,
        generation: 'generation456',
        agents: expanded.slots.map((slot) => ({
          agentSessionId: `alpha:ch-${slot.channelId}:generation456`,
          workspaceId: 'alpha',
          channelId: slot.channelId!,
          generation: 'generation456',
          runId: team.run.id,
          capabilities: expanded.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })
      // 安装批次会把 draft+有目标 归位到 ready；此后再无 beginLaunch，run 停在 ready
      expect(repository.loadTeamControl().runs[0]?.status).toBe('ready')

      repository.recordAgentCheckIn({
        agentSessionId: 'alpha:ch-1:generation456',
        runId: team.run.id,
        capabilities: ['coordination', 'planning']
      }, '拓扑重置后确认')

      const state = repository.loadTeamControl()
      expect(state.runs[0]?.status).toBe('launching')
      expect(state.bindings.find((binding) => binding.channelId === '1')?.launchStatus).toBe('acknowledged')
    } finally {
      repository.close()
    }
  })

  it('never downgrades an acknowledgement when the delivery receipt arrives late', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('alpha')
      repository.upsertWorkspaceTeam(team)
      repository.updateRunGoal(team.run.id, '验证单调启动状态')
      repository.recordInstallation({
        workspaceId: 'alpha',
        runId: team.run.id,
        generation: 'generation123',
        agents: [{
          agentSessionId: 'alpha:ch-1:generation123',
          workspaceId: 'alpha',
          channelId: '1',
          generation: 'generation123',
          runId: team.run.id,
          capabilities: ['coordination', 'planning']
        }]
      })
      repository.beginLaunch(team.run.id, 200, 'launch-attempt-1')
      repository.recordAgentCheckIn({
        agentSessionId: 'alpha:ch-1:generation123',
        runId: team.run.id,
        capabilities: ['coordination', 'planning']
      }, '已确认')
      repository.recordLaunchDelivery({
        runId: team.run.id,
        slotId: team.slots[0]!.id,
        status: 'uncertain',
        commandId: 'late-command',
        detail: '迟到的超时结果'
      })

      const state = repository.loadTeamControl()
      expect(state.bindings[0]).toMatchObject({
        launchStatus: 'acknowledged',
        launchCommandId: 'late-command',
        lastCheckInNote: '已确认'
      })
      expect(state.runs[0]?.status).toBe('running')
    } finally {
      repository.close()
    }
  })

  it('does not rotate runtime identity when the same topology is installed again', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('alpha')
      repository.upsertWorkspaceTeam(team)
      const install = (generation: string) => repository.recordInstallation({
        workspaceId: 'alpha',
        runId: team.run.id,
        generation,
        agents: [{
          agentSessionId: `alpha:ch-1:${generation}`,
          workspaceId: 'alpha',
          channelId: '1',
          generation,
          runId: team.run.id,
          capabilities: ['coordination', 'planning']
        }]
      })

      install('generation123')
      const first = repository.loadTeamControl()
      install('generation456')
      const second = repository.loadTeamControl()
      expect(second.slots[0]?.id).toBe(first.slots[0]?.id)
      expect(second.bindings).toHaveLength(1)
      expect(second.bindings[0]).toMatchObject({
        generation: 'generation123',
        agentSessionId: 'alpha:ch-1:generation123',
        slotId: first.slots[0]?.id,
        launchStatus: 'not_started'
      })
    } finally {
      repository.close()
    }
  })

  it('rolls authorization and runtime bindings back together when installation fails', () => {
    const repository = repositoryFixture()
    const authorization = new SqliteTaskPoolRepository(repository.path)
    try {
      const team = bundle('alpha', ['1', '2'])
      repository.upsertWorkspaceTeam(team)
      const registration = (generation: string) => ({
        workspaceId: 'alpha',
        runId: team.run.id,
        generation,
        agents: team.slots.map((slot) => ({
          agentSessionId: `alpha:ch-${slot.channelId}:${generation}`,
          workspaceId: 'alpha',
          channelId: slot.channelId!,
          generation,
          runId: team.run.id,
          capabilities: team.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })

      const raw = new DatabaseSync(repository.path)
      raw.exec(`
        CREATE TRIGGER force_runtime_binding_failure
        BEFORE INSERT ON runtime_bindings
        WHEN NEW.generation = 'generation456'
        BEGIN
          SELECT RAISE(ABORT, 'forced runtime binding failure');
        END;
      `)
      raw.close()

      expect(() => repository.recordInstallation(registration('generation456')))
        .toThrowError(/forced runtime binding failure/)
      expect(repository.loadTeamControl().bindings).toEqual([])
      expect(() => authorization.assertAgentAuthorized({
        agentSessionId: 'alpha:ch-1:generation456',
        runId: team.run.id,
        capabilities: ['coordination']
      })).toThrowError(/未注册或已被撤销/)
      expect(() => authorization.assertAgentAuthorized({
        agentSessionId: 'alpha:ch-2:generation456',
        runId: team.run.id,
        capabilities: ['code']
      })).toThrowError(/未注册或已被撤销/)
    } finally {
      authorization.close()
      repository.close()
    }
  })

  it('reconciles changed channel topology and fences the old generation', () => {
    const repository = repositoryFixture()
    const authorization = new SqliteTaskPoolRepository(repository.path)
    try {
      const initial = bundle('alpha', ['1', '2', '3'])
      repository.upsertWorkspaceTeam(initial)
      repository.recordInstallation({
        workspaceId: 'alpha',
        runId: initial.run.id,
        generation: 'generation123',
        agents: initial.slots.map((slot) => ({
          agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
          workspaceId: 'alpha',
          channelId: slot.channelId!,
          generation: 'generation123',
          runId: initial.run.id,
          capabilities: initial.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })

      repository.upsertWorkspaceTeam(bundle('alpha', ['1', '3']))
      const state = repository.loadTeamControl()
      expect(state.slots.map((slot) => [slot.id.split(':').at(-1), slot.channelId])).toEqual([
        ['lead', '1'],
        ['builder', '3']
      ])
      expect(state.bindings).toEqual([])
      expect(state.runs[0]?.status).toBe('draft')
      expect(() => authorization.assertAgentAuthorized({
        agentSessionId: 'alpha:ch-1:generation123',
        runId: initial.run.id,
        capabilities: ['coordination']
      })).toThrowError(/未注册或已被撤销/)
    } finally {
      authorization.close()
      repository.close()
    }
  })

  it('persists one Composer per runtime generation and rejects conflicts or stale writes', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('alpha', ['1', '2'])
      repository.upsertWorkspaceTeam(team)
      repository.recordInstallation({
        workspaceId: 'alpha',
        runId: team.run.id,
        generation: 'generation123',
        agents: team.slots.map((slot) => ({
          agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
          workspaceId: 'alpha',
          channelId: slot.channelId!,
          generation: 'generation123',
          runId: team.run.id,
          capabilities: team.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })
      const [first, second] = repository.loadTeamControl().bindings

      expect(repository.recordComposerBinding({
        runId: first!.runId,
        slotId: first!.slotId,
        generation: first!.generation,
        bindingKey: first!.composerBindingKey,
        composerId: 'composer-alpha-123',
        method: 'launch_marker',
        at: 300
      })).toBe(true)
      expect(repository.recordComposerBinding({
        runId: first!.runId,
        slotId: first!.slotId,
        generation: first!.generation,
        bindingKey: first!.composerBindingKey,
        composerId: 'composer-alpha-123',
        method: 'launch_marker',
        at: 301
      })).toBe(false)
      expect(repository.recordComposerBinding({
        runId: second!.runId,
        slotId: second!.slotId,
        generation: second!.generation,
        bindingKey: second!.composerBindingKey,
        composerId: 'composer-alpha-123',
        method: 'launch_marker',
        at: 302
      })).toBe(false)
      expect(repository.recordComposerBinding({
        runId: second!.runId,
        slotId: second!.slotId,
        generation: 'stale-generation',
        bindingKey: second!.composerBindingKey,
        composerId: 'composer-beta-123',
        method: 'channel_marker',
        at: 303
      })).toBe(false)

      expect(repository.loadTeamControl()).toMatchObject({
        schemaVersion: 7,
        bindings: expect.arrayContaining([expect.objectContaining({
          slotId: first!.slotId,
          composerId: 'composer-alpha-123',
          composerBoundAt: 300,
          composerBindingMethod: 'launch_marker'
        })])
      })

      repository.updateRunGoal(team.run.id, '验证启动轮次栅栏')
      repository.beginLaunch(team.run.id, 400, 'launch-attempt-2')
      const rotated = repository.loadTeamControl().bindings.find((value) => value.slotId === first!.slotId)!
      expect(rotated).toMatchObject({
        composerBindingKey: 'launch-attempt-2',
        launchStatus: 'not_started'
      })
      expect(rotated.composerId).toBeUndefined()
      expect(repository.recordComposerBinding({
        runId: first!.runId,
        slotId: first!.slotId,
        generation: first!.generation,
        bindingKey: first!.composerBindingKey,
        composerId: 'composer-late-123',
        method: 'launch_marker',
        at: 401
      })).toBe(false)
      expect(repository.recordComposerBinding({
        runId: first!.runId,
        slotId: first!.slotId,
        generation: first!.generation,
        bindingKey: 'launch-attempt-2',
        composerId: 'composer-current-123',
        method: 'launch_marker',
        at: 402
      })).toBe(true)
    } finally {
      repository.close()
    }
  })

  it('rotates one offline Composer binding before a targeted relaunch', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('relaunch', ['1'])
      repository.upsertWorkspaceTeam(team)
      repository.recordInstallation({
        workspaceId: 'relaunch', runId: team.run.id, generation: 'generation123',
        agents: [{
          agentSessionId: 'relaunch:ch-1:generation123', workspaceId: 'relaunch', channelId: '1',
          generation: 'generation123', runId: team.run.id, capabilities: ['coordination', 'planning']
        }]
      })
      const binding = repository.loadTeamControl().bindings[0]!
      expect(repository.recordComposerBinding({
        runId: binding.runId, slotId: binding.slotId, generation: binding.generation,
        bindingKey: binding.composerBindingKey, composerId: 'composer-old-123', method: 'launch_marker', at: 100
      })).toBe(true)
      expect(repository.prepareComposerRelaunch({
        runId: binding.runId, slotId: binding.slotId, bindingKey: 'relaunch-key-2'
      })).toBe(true)
      const rotated = repository.loadTeamControl().bindings[0]!
      expect(rotated).toMatchObject({ composerBindingKey: 'relaunch-key-2', launchStatus: 'not_started' })
      expect(rotated.composerId).toBeUndefined()
      expect(repository.recordComposerBinding({
        runId: binding.runId, slotId: binding.slotId, generation: binding.generation,
        bindingKey: 'relaunch-key-2', composerId: 'composer-new-123', method: 'launch_marker', at: 200
      })).toBe(true)
    } finally {
      repository.close()
    }
  })

  it('migrates a version-1 runtime binding table without discarding the database', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-control-v1-')), 'control.sqlite3')
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE team_control_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL, active_workspace_id TEXT, updated_at INTEGER NOT NULL
      );
      INSERT INTO team_control_meta VALUES (1, 1, 0, NULL, 0);
      CREATE TABLE runtime_bindings (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
        slot_id TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL UNIQUE, generation TEXT NOT NULL,
        installed_at INTEGER NOT NULL, launch_status TEXT NOT NULL,
        launch_command_id TEXT, launch_detail TEXT NOT NULL,
        acknowledged_at INTEGER, last_check_in_at INTEGER,
        last_check_in_note TEXT NOT NULL
      );
    `)
    old.close()

    const repository = new SqliteTeamControlRepository(path)
    try {
      expect(repository.loadTeamControl().schemaVersion).toBe(7)
      const database = new DatabaseSync(path, { readOnly: true })
      try {
        const columns = database.prepare('PRAGMA table_info(runtime_bindings)').all() as { name: string }[]
        expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
          'composer_id',
          'composer_bound_at',
          'composer_binding_method',
          'composer_binding_key'
        ]))
        const roleColumns = database.prepare('PRAGMA table_info(team_roles)').all() as { name: string }[]
        const slotColumns = database.prepare('PRAGMA table_info(agent_slots)').all() as { name: string }[]
        expect(roleColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['template_key', 'skills_json']))
        expect(slotColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['avatar_id', 'is_solo']))
      } finally {
        database.close()
      }
    } finally {
      repository.close()
    }
  })

  it('migrates schema v3 roles and slots to configurable skills and avatars', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-control-v3-')), 'control.sqlite3')
    const initial = new SqliteTeamControlRepository(path)
    initial.upsertWorkspaceTeam(bundle('legacy-v3', ['1', '2', '3']))
    initial.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE team_roles DROP COLUMN skills_json')
    old.exec('ALTER TABLE team_roles DROP COLUMN template_key')
    old.exec('ALTER TABLE team_runs DROP COLUMN acting_lead_slot_id')
    old.exec('ALTER TABLE agent_slots DROP COLUMN is_solo')
    old.exec('ALTER TABLE agent_slots DROP COLUMN avatar_id')
    old.exec('UPDATE team_control_meta SET schema_version = 3 WHERE id = 1')
    old.close()

    const migrated = new SqliteTeamControlRepository(path)
    try {
      const state = migrated.loadTeamControl()
      expect(state.schemaVersion).toBe(7)
      expect(state.roles.map((role) => [role.key, role.templateKey, role.skills])).toEqual([
        ['lead', 'lead', []],
        ['builder', 'builder', []],
        ['reviewer', 'reviewer', []]
      ])
      expect(state.slots.map((slot) => slot.avatarId)).toEqual(['lead', 'architect', 'reviewer'])
      const database = new DatabaseSync(path, { readOnly: true })
      try {
        const runColumns = database.prepare('PRAGMA table_info(team_runs)').all() as { name: string }[]
        const slotColumns = database.prepare('PRAGMA table_info(agent_slots)').all() as { name: string }[]
        expect(runColumns.map((column) => column.name)).toContain('acting_lead_slot_id')
        expect(slotColumns.map((column) => column.name)).toContain('is_solo')
      } finally {
        database.close()
      }
    } finally {
      migrated.close()
    }
  })

  it('migrates schema v6 by adding is_solo with a default of zero', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-control-v6-')), 'control.sqlite3')
    const current = new SqliteTeamControlRepository(path)
    current.upsertWorkspaceTeam(bundle('legacy-v6', ['1', '2']))
    current.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE agent_slots DROP COLUMN is_solo')
    old.exec('UPDATE team_control_meta SET schema_version = 6 WHERE id = 1')
    old.close()

    const migrated = new SqliteTeamControlRepository(path)
    try {
      const state = migrated.loadTeamControl()
      expect(state.schemaVersion).toBe(7)
      expect(state.slots.every((slot) => slot.solo === false)).toBe(true)
      const database = new DatabaseSync(path, { readOnly: true })
      try {
        const columns = database.prepare('PRAGMA table_info(agent_slots)').all() as { name: string }[]
        expect(columns.map((column) => column.name)).toContain('is_solo')
      } finally {
        database.close()
      }
    } finally {
      migrated.close()
    }
  })

  it('migrates schema v4 to the failover event store without losing the active team', () => {
    const initial = repositoryFixture()
    const path = initial.path
    const team = bundle('failover-migration', ['1', '2'])
    initial.upsertWorkspaceTeam(team)
    initial.close()

    const old = new DatabaseSync(path)
    old.exec('DROP TABLE team_failovers')
    old.exec('UPDATE team_control_meta SET schema_version = 4 WHERE id = 1')
    old.close()

    const migrated = new SqliteTeamControlRepository(path)
    try {
      expect(migrated.loadTeamControl()).toMatchObject({
        schemaVersion: 7,
        activeWorkspaceId: team.workspace.id
      })
      const database = new DatabaseSync(path, { readOnly: true })
      try {
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_failovers'").get())
          .toBeTruthy()
      } finally {
        database.close()
      }
    } finally {
      migrated.close()
    }
  })
})

describe('SqliteTeamControlRepository 会话围栏令牌', () => {
  const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/

  function installed(repository: SqliteTeamControlRepository, workspaceId: string, channelIds: string[]) {
    const team = createConfiguredTeamBundle({
      workspaceId, workspaceName: workspaceId, workspacePath: `/workspace/${workspaceId}`, now: 100,
      members: channelIds.map((channelId, index) => (
        index === 0
          ? { channelId, roleTemplateKey: 'lead', avatarId: 'lead', skills: [] }
          : { channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }
      ))
    })
    repository.upsertWorkspaceTeam(team)
    repository.recordInstallation({
      workspaceId, runId: team.run.id, generation: 'generation123',
      agents: team.slots.map((slot) => ({
        agentSessionId: `${workspaceId}:ch-${slot.channelId}:generation123`, workspaceId,
        channelId: slot.channelId!, generation: 'generation123', runId: team.run.id,
        capabilities: team.roles.find((role) => role.id === slot.roleId)!.capabilities
      }))
    })
    return team
  }

  it('issues one distinct token per binding at install time and exposes it through the owner query', () => {
    const repository = repositoryFixture()
    try {
      const team = installed(repository, 'fenced', ['1', '2'])
      const bindings = repository.loadTeamControl().bindings.filter((binding) => binding.runId === team.run.id)
      expect(bindings).toHaveLength(2)
      for (const binding of bindings) expect(binding.sessionToken).toMatch(TOKEN_PATTERN)
      expect(new Set(bindings.map((binding) => binding.sessionToken)).size).toBe(2)

      const lead = repository.resolveChannelSessionOwner('1')
      expect(lead).toEqual({
        runId: team.run.id, runStatus: 'draft', bound: true,
        sessionToken: bindings.find((binding) => binding.channelId === '1')!.sessionToken, solo: false
      })
      expect(repository.resolveChannelSessionOwner('2')).toMatchObject({ bound: true, solo: true })
      expect(repository.resolveChannelSessionOwner(' 2 ')).toEqual(repository.resolveChannelSessionOwner('2'))
    } finally {
      repository.close()
    }
  })

  it('reports an unbound channel of the active run and no owner when no workspace is active', () => {
    const repository = repositoryFixture()
    try {
      expect(repository.resolveChannelSessionOwner('1')).toBeUndefined()
      const team = installed(repository, 'partial', ['1'])
      expect(repository.resolveChannelSessionOwner('9')).toEqual({
        runId: team.run.id, runStatus: 'draft', bound: false, sessionToken: undefined, solo: false
      })
    } finally {
      repository.close()
    }
  })

  it('follows the newest run of the active workspace, exactly like the desktop activeRun projection', () => {
    const repository = repositoryFixture()
    try {
      const first = installed(repository, 'switching', ['1'])
      const firstToken = repository.resolveChannelSessionOwner('1')?.sessionToken
      const second = createConfiguredTeamBundle({
        workspaceId: 'switching', workspaceName: 'switching', workspacePath: '/workspace/switching',
        now: 200, runKey: 'run-second00', mode: 'independent',
        members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }]
      })
      repository.upsertWorkspaceTeam(second)
      // 新 run 尚未安装：通道在新 run 里无绑定 → 旧令牌按 channel_unbound 退役。
      expect(repository.resolveChannelSessionOwner('1')).toMatchObject({ runId: second.run.id, bound: false })
      expect(repository.resolveChannelSessionOwner('1')?.runId).not.toBe(first.run.id)
      repository.recordInstallation({
        workspaceId: 'switching', runId: second.run.id, generation: 'generation456',
        agents: [{
          agentSessionId: 'switching:ch-1:generation456', workspaceId: 'switching', channelId: '1',
          generation: 'generation456', runId: second.run.id, capabilities: []
        }]
      })
      const owner = repository.resolveChannelSessionOwner('1')
      expect(owner).toMatchObject({ runId: second.run.id, runStatus: 'running', bound: true, solo: true })
      expect(owner?.sessionToken).toMatch(TOKEN_PATTERN)
      expect(owner?.sessionToken).not.toBe(firstToken)
    } finally {
      repository.close()
    }
  })

  it('rotates the token on seat relaunch so a still-alive old Composer is fenced out', () => {
    const repository = repositoryFixture()
    try {
      const team = installed(repository, 'relaunch', ['1'])
      const before = repository.resolveChannelSessionOwner('1')!.sessionToken
      const slot = team.slots[0]!
      expect(repository.prepareComposerRelaunch({ runId: team.run.id, slotId: slot.id, bindingKey: 'relaunch-key-1' })).toBe(true)
      const after = repository.resolveChannelSessionOwner('1')!.sessionToken
      expect(after).toMatch(TOKEN_PATTERN)
      expect(after).not.toBe(before)
      // 团队 launch 不轮换令牌：启动前创建的会话不能被自己的团队围栏误杀。
      repository.updateRunGoal(team.run.id, '围栏令牌在 launch 时保持不变')
      repository.beginLaunch(team.run.id, 300, 'launch-key-1')
      expect(repository.resolveChannelSessionOwner('1')!.sessionToken).toBe(after)
    } finally {
      repository.close()
    }
  })

  it('marks the owner as completed with the caller-supplied completion detail', () => {
    const repository = repositoryFixture()
    try {
      const team = installed(repository, 'ending', ['1'])
      repository.updateRunGoal(team.run.id, '结束语义')
      repository.beginLaunch(team.run.id, 300, 'launch-key-end')
      expect(repository.completeRun(team.run.id, 400, '用户已结束本轮运行')).toBe(true)
      expect(repository.resolveChannelSessionOwner('1')).toMatchObject({ runId: team.run.id, runStatus: 'completed', bound: true })
      const binding = repository.loadTeamControl().bindings.find((candidate) => candidate.runId === team.run.id)!
      expect(binding.launchStatus).toBe('failed')
      expect(binding.launchDetail).toBe('用户已结束本轮运行')
      // 缺省文案仍是 failover 的自动收尾语义。
      const other = installed(repository, 'ending-default', ['1'])
      repository.updateRunGoal(other.run.id, '缺省收尾文案')
      repository.beginLaunch(other.run.id, 300, 'launch-key-default')
      expect(repository.completeRun(other.run.id, 400)).toBe(true)
      expect(repository.loadTeamControl().bindings.find((candidate) => candidate.runId === other.run.id)?.launchDetail)
        .toBe('本轮所有 Agent 已离线，TeamRun 自动结束')
      // draft/ready 不可收尾。
      const fresh = installed(repository, 'ending-draft', ['1'])
      expect(repository.completeRun(fresh.run.id, 500)).toBe(false)
    } finally {
      repository.close()
    }
  })

  it('adds the session_token column to a pre-fence database and treats existing bindings as legacy', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-control-fence-migrate-')), 'control.sqlite3')
    const seeded = new SqliteTeamControlRepository(path)
    const team = installed(seeded, 'legacy', ['1'])
    seeded.close()
    // 模拟升级前的库：旧构建没有 session_token 列。
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE runtime_bindings DROP COLUMN session_token')
    old.close()

    const migrated = new SqliteTeamControlRepository(path)
    try {
      const binding = migrated.loadTeamControl().bindings.find((candidate) => candidate.runId === team.run.id)!
      expect(binding.sessionToken).toBeUndefined()
      expect(migrated.resolveChannelSessionOwner('1')).toMatchObject({ runId: team.run.id, bound: true, sessionToken: undefined })
      // 迁移后新签发照常。
      expect(migrated.prepareComposerRelaunch({ runId: team.run.id, slotId: team.slots[0]!.id, bindingKey: 'post-migrate' })).toBe(true)
      expect(migrated.resolveChannelSessionOwner('1')?.sessionToken).toMatch(TOKEN_PATTERN)
    } finally {
      migrated.close()
    }
  })
})
