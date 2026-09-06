import { describe, expect, it } from 'vitest'
import {
  buildSoloLaunchHint,
  buildTeamRoleBriefing,
  createConfiguredTeamBundle,
  createDefaultTeamBundle,
  workspaceRunMode,
  type RuntimeBinding
} from '../src/domain/team-control'

describe('team control domain', () => {
  it('creates explicit durable roles and slots for the discovered channels', () => {
    const bundle = createDefaultTeamBundle({
      workspaceId: 'workspace-a',
      workspaceName: 'alpha',
      workspacePath: '/workspace/alpha',
      channelIds: ['3', '1', '2', '2'],
      now: 100
    })

    expect(bundle.run.id).toBe('team-run:workspace-a:main')
    expect(bundle.roles.map((role) => [role.key, role.capabilities])).toEqual([
      ['lead', ['coordination', 'planning']],
      ['builder', ['code', 'architecture']],
      ['reviewer', ['qa', 'testing']]
    ])
    expect(bundle.slots.map((slot) => [slot.id, slot.channelId])).toEqual([
      ['agent-slot:workspace-a:lead', '1'],
      ['agent-slot:workspace-a:builder', '2'],
      ['agent-slot:workspace-a:reviewer', '3']
    ])
  })

  it('adds explicit specialist roles without guessing capabilities from display names', () => {
    const bundle = createDefaultTeamBundle({
      workspaceId: 'workspace-b',
      workspaceName: 'beta',
      workspacePath: '/workspace/beta',
      channelIds: ['1', '2', '3', '4'],
      now: 100
    })
    expect(bundle.roles[3]).toMatchObject({
      key: 'specialist-1',
      name: '专项实现 1',
      capabilities: ['code', 'implementation']
    })
  })

  it('builds a bounded launch contract that requires explicit agent acknowledgement', () => {
    const bundle = createDefaultTeamBundle({
      workspaceId: 'workspace-a',
      workspaceName: 'alpha',
      workspacePath: '/workspace/alpha',
      channelIds: ['2'],
      now: 100
    })
    bundle.run.goal = '完成 Bridge v2，并提供回归测试证据'
    const binding: RuntimeBinding = {
      id: 'binding-1',
      workspaceId: bundle.workspace.id,
      runId: bundle.run.id,
      slotId: bundle.slots[0]!.id,
      channelId: '2',
      agentSessionId: 'workspace-a:ch-2:generation123',
      generation: 'generation123',
      composerBindingKey: 'generation123',
      installedAt: 100,
      launchStatus: 'not_started',
      launchDetail: '',
      lastCheckInNote: ''
    }
    const prompt = buildTeamRoleBriefing({
      run: bundle.run,
      role: bundle.roles[0]!,
      slot: bundle.slots[0]!,
      binding
    })

    expect(prompt).toContain('team_check_in')
    expect(prompt).toContain('完成 Bridge v2，并提供回归测试证据')
    expect(prompt).toContain("channel_id:'2'")
    expect(prompt).toContain('SG Team')
    expect(prompt).toContain('[[SG_TEAM_BIND:generation123:CH-2]]')
    expect(prompt).toContain('停止自动重试')
    expect(prompt).toContain('默认控制在 1—4 句')
    expect(prompt).toContain('不要固定输出“当前结论 / 下一步 / 阻塞项”')
    expect(prompt).toContain(bundle.slots[0]!.id)
    expect(prompt).toContain('不要依据团队目标自行调用 team_task plan')
    expect(prompt).toContain('只有收到用户明确要求“开始 / 分配 / 拆任务 / 执行”后')
  })

  it('builds an arbitrary channel subset with user-selected roles, skills and avatars', () => {
    const bundle = createConfiguredTeamBundle({
      workspaceId: 'workspace-configured',
      workspaceName: 'configured',
      workspacePath: '/workspace/configured',
      members: [
        { channelId: '2', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
        { channelId: '7', roleTemplateKey: 'backend', avatarId: 'architect', skills: [{ id: 'project:mcp', name: 'mcp-builder', description: 'MCP', scope: 'project' }] },
        { channelId: '11', roleTemplateKey: 'backend', avatarId: 'devops', skills: [] },
        { channelId: '19', roleTemplateKey: 'reviewer', avatarId: 'reviewer', skills: [] },
        { channelId: '23', roleTemplateKey: 'researcher', avatarId: 'researcher', skills: [] }
      ],
      now: 100
    })

    expect(bundle.slots.map((slot) => slot.channelId)).toEqual(['2', '7', '11', '19', '23'])
    expect(bundle.roles.map((role) => role.key)).toEqual(['lead', 'backend', 'backend-2', 'reviewer', 'researcher'])
    expect(bundle.roles[1]).toMatchObject({
      templateKey: 'backend',
      name: '后端实现 1',
      skills: [{ name: 'mcp-builder' }]
    })
    expect(bundle.roles[2]).toMatchObject({ templateKey: 'backend', name: '后端实现 2' })
    expect(bundle.slots[1]).toMatchObject({ avatarId: 'architect' })

    bundle.run.goal = '按用户选择的技能协作'
    const prompt = buildTeamRoleBriefing({
      run: bundle.run,
      role: bundle.roles[1]!,
      slot: bundle.slots[1]!,
      binding: {
        id: 'binding-configured', workspaceId: bundle.workspace.id, runId: bundle.run.id,
        slotId: bundle.slots[1]!.id, channelId: '7', agentSessionId: 'configured:ch-7:generation123',
        generation: 'generation123', installedAt: 100, launchStatus: 'not_started', launchDetail: '',
        lastCheckInNote: '', composerBindingKey: 'generation123'
      }
    })
    expect(prompt).toContain('/mcp-builder')
    expect(prompt).toContain('CH-7')
  })

  it('briefs an acting lead with real coordinator duties while retaining the specialist role', () => {
    const bundle = createDefaultTeamBundle({
      workspaceId: 'acting', workspaceName: 'acting', workspacePath: '/workspace/acting',
      channelIds: ['1', '2'], now: 100
    })
    bundle.run.goal = '完成真实主控交接'
    const role = bundle.roles.find((candidate) => candidate.templateKey === 'builder')!
    const slot = bundle.slots.find((candidate) => candidate.roleId === role.id)!
    const prompt = buildTeamRoleBriefing({
      run: bundle.run,
      role,
      slot,
      effectiveLead: true,
      binding: {
        id: 'binding-acting', workspaceId: bundle.workspace.id, runId: bundle.run.id,
        slotId: slot.id, channelId: '2', agentSessionId: 'acting:ch-2:generation123',
        generation: 'generation123', installedAt: 100, launchStatus: 'acknowledged',
        launchDetail: '', lastCheckInNote: '', composerBindingKey: 'generation123'
      }
    })
    expect(prompt).toContain('唯一有效主控')
    expect(prompt).toContain('全局规划、调度、消息协调')
    expect(prompt).toContain("team_tasks({channel_id:'2', view:'board'})")
    expect(prompt).toContain('team_message broadcast + collect')
  })

  it('requires exactly one lead regardless of team size', () => {
    expect(() => createConfiguredTeamBundle({
      workspaceId: 'invalid', workspaceName: 'invalid', workspacePath: '/workspace/invalid',
      members: [{ channelId: '1', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] }]
    })).toThrowError(/只能有 1 名主控/)
    expect(() => createConfiguredTeamBundle({
      workspaceId: 'invalid', workspaceName: 'invalid', workspacePath: '/workspace/invalid',
      members: [
        { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
        { channelId: '2', roleTemplateKey: 'lead', avatarId: 'architect', skills: [] }
      ]
    })).toThrowError(/只能有 1 名主控/)
  })

  it('builds one TeamRun with team members plus numbered solo seats without counting solo as lead', () => {
    const bundle = createConfiguredTeamBundle({
      workspaceId: 'mixed', workspaceName: 'mixed', workspacePath: '/workspace/mixed', now: 100,
      members: [
        { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
        { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] },
        { channelId: '3', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true },
        // 防御：solo=true 时即使上游传入 lead/skills，也强制落为 solo 空能力模板。
        { channelId: '4', roleTemplateKey: 'lead', avatarId: 'devops', skills: [{ id: 'x', name: 'x', description: 'x', scope: 'project' }], solo: true }
      ]
    })
    expect(bundle.roles.map((role) => [role.templateKey, role.name, role.capabilities, role.skills])).toEqual([
      ['lead', '主控协调', ['coordination', 'planning'], []],
      ['builder', '架构实现', ['code', 'architecture'], []],
      ['solo', '独立执行 1', [], []],
      ['solo', '独立执行 2', [], []]
    ])
    expect(bundle.slots.map((slot) => [slot.name, slot.solo])).toEqual([
      ['主控席', false], ['实现席', false], ['独立席 1', true], ['独立席 2', true]
    ])
  })

  it('rejects an all-solo bundle and builds a solo launch loop without team_check_in', () => {
    expect(() => createConfiguredTeamBundle({
      workspaceId: 'solo-only', workspaceName: 'solo-only', workspacePath: '/workspace/solo-only',
      members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }]
    })).toThrowError(/至少需要 1 个非独立席位/)

    const prompt = buildSoloLaunchHint({ channelId: '8' })
    expect(prompt).toContain('独立模式')
    expect(prompt).toContain("record_reply({channel_id:'8'")
    expect(prompt).toContain("check_messages({channel_id:'8'})")
    expect(prompt).not.toContain('team_check_in')
  })

  it('creates an explicit independent run made only of isolated solo slots', () => {
    const bundle = createConfiguredTeamBundle({
      workspaceId: 'independent', workspaceName: 'independent', workspacePath: '/workspace/independent',
      mode: 'independent', now: 100,
      members: [
        { channelId: '1', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true },
        { channelId: '2', roleTemplateKey: 'solo', avatarId: 'devops', skills: [], solo: true }
      ]
    })
    expect(workspaceRunMode(bundle.run)).toBe('independent')
    expect(bundle.run.id).toContain('session-run:')
    expect(bundle.run.status).toBe('running')
    expect(bundle.slots.every((slot) => slot.solo === true)).toBe(true)
    expect(() => createConfiguredTeamBundle({
      workspaceId: 'invalid-independent', workspaceName: 'invalid', workspacePath: '/workspace/invalid',
      mode: 'independent',
      members: [{ channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] }]
    })).toThrowError(/只接受独立席位/)
  })
})
