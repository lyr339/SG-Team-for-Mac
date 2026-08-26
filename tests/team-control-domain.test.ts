import { describe, expect, it } from 'vitest'
import {
  buildTeamRoleBriefing,
  createConfiguredTeamBundle,
  createDefaultTeamBundle,
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

    expect(prompt).toContain('team_get_context')
    expect(prompt).toContain('完成 Bridge v2，并提供回归测试证据')
    expect(prompt).toContain("channel_id:'2'")
    expect(prompt).toContain('qunshu')
    expect(prompt).not.toContain('qtwx-mcp-2')
    expect(prompt).toContain('[[QINGTIAN_TEAM_BIND:generation123:CH-2]]')
    expect(prompt).toContain('停止自动重试')
    expect(prompt).toContain('默认控制在 1—4 句')
    expect(prompt).toContain('不要固定输出“当前结论 / 下一步 / 阻塞项”')
    expect(prompt).toContain(bundle.slots[0]!.id)
    expect(prompt).toContain('不要依据团队目标自行调用 team_plan_tasks')
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
})
