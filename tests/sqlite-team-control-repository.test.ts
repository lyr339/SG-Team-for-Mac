import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createConfiguredTeamBundle, createDefaultTeamBundle } from '../src/domain/team-control'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'

function repositoryFixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-control-')), 'control.sqlite3')
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
          { channelId: '7', roleTemplateKey: 'frontend', avatarId: 'frontend', skills: [{
            id: 'project:frontend-design', name: 'frontend-design', description: 'UI skill', scope: 'project'
          }] },
          { channelId: '19', roleTemplateKey: 'reviewer', avatarId: 'reviewer', skills: [] }
        ],
        now: 100
      })
      repository.upsertWorkspaceTeam(team)
      const state = repository.loadTeamControl()
      expect(state.schemaVersion).toBe(6)
      expect(state.roles.find((role) => role.templateKey === 'frontend')).toMatchObject({
        skills: [{ id: 'project:frontend-design', name: 'frontend-design' }]
      })
      expect(state.slots.map((slot) => [slot.channelId, slot.avatarId])).toEqual([
        ['2', 'lead'], ['7', 'frontend'], ['19', 'reviewer']
      ])
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
        schemaVersion: 6,
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

  it('migrates a version-1 runtime binding table without discarding the database', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-control-v1-')), 'control.sqlite3')
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
      expect(repository.loadTeamControl().schemaVersion).toBe(6)
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
        expect(slotColumns.map((column) => column.name)).toContain('avatar_id')
      } finally {
        database.close()
      }
    } finally {
      repository.close()
    }
  })

  it('migrates schema v3 roles and slots to configurable skills and avatars', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-team-control-v3-')), 'control.sqlite3')
    const initial = new SqliteTeamControlRepository(path)
    initial.upsertWorkspaceTeam(bundle('legacy-v3', ['1', '2', '3']))
    initial.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE team_roles DROP COLUMN skills_json')
    old.exec('ALTER TABLE team_roles DROP COLUMN template_key')
    old.exec('ALTER TABLE agent_slots DROP COLUMN avatar_id')
    old.exec('UPDATE team_control_meta SET schema_version = 3 WHERE id = 1')
    old.close()

    const migrated = new SqliteTeamControlRepository(path)
    try {
      const state = migrated.loadTeamControl()
      expect(state.schemaVersion).toBe(6)
      expect(state.roles.map((role) => [role.key, role.templateKey, role.skills])).toEqual([
        ['lead', 'lead', []],
        ['builder', 'builder', []],
        ['reviewer', 'reviewer', []]
      ])
      expect(state.slots.map((slot) => slot.avatarId)).toEqual(['lead', 'architect', 'reviewer'])
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
        schemaVersion: 6,
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
