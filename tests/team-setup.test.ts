import { describe, expect, it } from 'vitest'
import { resolveIndependentSessionMembers, resolveTeamSetupMembers } from '../src/application/team-setup'
import { AGENT_AVATAR_IDS, TEAM_ROLE_TEMPLATES } from '../src/domain/team-control'
import type { TeamSetupDraft } from '../src/shared/desktop-api'

const draft: TeamSetupDraft = {
  draftId: 'draft-1',
  workspaceId: 'workspace',
  workspaceName: 'workspace',
  workspacePath: '/workspace',
  channels: ['1', '2', '3', '4', '5'].map((channelId) => ({
    channelId,
    displayName: `CH-${channelId}`,
    status: 'waiting',
    online: true,
    waiting: true,
    queueDepth: 0
  })),
  roleTemplates: TEAM_ROLE_TEMPLATES,
  avatarIds: [...AGENT_AVATAR_IDS],
  cursorModels: [{
    modelId: 'kimi-k3', displayName: 'Kimi K3', selected: true,
    parameters: [{ id: 'reasoning', value: 'high' }], optionLabels: ['High'],
    maxMode: false, supportsMaxMode: true, supportsNonMaxMode: true,
    contextTokenLimit: 1_048_576, contextTokenLimitForMaxMode: 1_048_576,
    parameterDefinitions: [{
      id: 'reasoning', displayName: 'Reasoning', kind: 'enum',
      values: [
        { value: 'low', displayName: 'Low', increasesCost: false },
        { value: 'high', displayName: 'High', increasesCost: true }
      ]
    }],
    // 真实运行态目录形态：全部 variants 均为 maxMode:false，MAX Mode 为正交开关
    variants: [
      { parameters: [{ id: 'reasoning', value: 'low' }], maxMode: false },
      { parameters: [{ id: 'reasoning', value: 'high' }], maxMode: false }
    ]
  }, {
    modelId: 'gpt-5.3-codex', displayName: 'Codex 5.3', selected: false,
    parameters: [{ id: 'reasoning', value: 'medium' }], optionLabels: [],
    maxMode: false,
    parameterDefinitions: [{
      id: 'reasoning', displayName: 'Reasoning', kind: 'enum',
      values: [
        { value: 'medium', displayName: 'Medium', increasesCost: false },
        { value: 'high', displayName: 'High', increasesCost: true }
      ]
    }]
  }],
  skills: [
    {
      id: 'project:tdd', name: 'tdd', description: 'TDD', scope: 'project', installed: true,
      source: 'workspace', recommendedRoles: ['builder']
    },
    {
      id: 'recommended:frontend', name: 'frontend-design', description: 'UI', scope: 'project', installed: false,
      source: 'anthropic', recommendedRoles: ['frontend']
    }
  ]
}

describe('resolveTeamSetupMembers', () => {
  it('accepts any valid channel subset and resolves only installed skill metadata', () => {
    expect(resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: [
        { channelId: '2', roleTemplateKey: 'lead', avatarId: 'lead', skillIds: [] },
        {
          channelId: '5', roleTemplateKey: 'builder', avatarId: 'architect', skillIds: ['project:tdd'],
          modelSelection: {
            modelId: 'gpt-5.3-codex', displayName: '伪造名称', maxMode: false,
            parameters: [{ id: 'reasoning', value: 'high' }]
          }
        }
      ]
    })).toEqual([
      expect.objectContaining({ channelId: '2', roleTemplateKey: 'lead' }),
      expect.objectContaining({
        channelId: '5',
        skills: [{ id: 'project:tdd', name: 'tdd', description: 'TDD', scope: 'project' }],
        modelSelection: {
          modelId: 'gpt-5.3-codex', displayName: 'Codex 5.3', maxMode: false,
          parameters: [{ id: 'reasoning', value: 'high' }]
        }
      })
    ])
  })

  it('defaults every seat to Cursor current model and rejects stale or invalid parameters', () => {
    const [member] = resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: [{ channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skillIds: [] }]
    })
    expect(member?.modelSelection).toMatchObject({ modelId: 'kimi-k3', displayName: 'Kimi K3' })
    expect(() => resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: [{
        channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skillIds: [],
        modelSelection: { modelId: 'retired-model', displayName: 'Old', parameters: [] }
      }]
    })).toThrowError(/不可用或已失效/)
    expect(() => resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: [{
        channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skillIds: [],
        modelSelection: {
          modelId: 'kimi-k3', displayName: 'Kimi K3',
          parameters: [{ id: 'reasoning', value: 'ultra' }]
        }
      }]
    })).toThrowError(/参数不可用/)
  })

  it('persists MAX Mode independently from reasoning parameters', () => {
    const [member] = resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: [{
        channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skillIds: [],
        modelSelection: {
          modelId: 'kimi-k3', displayName: 'Kimi K3', maxMode: true,
          parameters: [{ id: 'reasoning', value: 'high' }]
        }
      }]
    })
    expect(member?.modelSelection).toMatchObject({
      modelId: 'kimi-k3',
      maxMode: true,
      parameters: [{ id: 'reasoning', value: 'high' }]
    })
  })

  it('orthogonal catalog (all-false variants) accepts MAX Mode on any parameter combo, constrained catalog still enforces', () => {
    // Kimi K3 形态：目录全 false + supportsMaxMode——maxMode 不参与组合约束
    expect(() => resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: [{
        channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skillIds: [],
        modelSelection: {
          modelId: 'kimi-k3', displayName: 'Kimi K3', maxMode: true,
          parameters: [{ id: 'reasoning', value: 'low' }]
        }
      }]
    })).not.toThrow()

    // 约束型目录（含 true 条目）：不存在的组合仍然拒绝
    const constrained: TeamSetupDraft = {
      ...draft,
      cursorModels: [{
        modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', selected: true,
        parameters: [{ id: 'context', value: '272k' }], optionLabels: [],
        maxMode: false, supportsMaxMode: true, supportsNonMaxMode: true,
        parameterDefinitions: [{ id: 'context', displayName: 'Context', kind: 'enum', values: [
          { value: '272k', displayName: '272K', increasesCost: false },
          { value: '1m', displayName: '1M', increasesCost: true }
        ] }],
        variants: [
          { parameters: [{ id: 'context', value: '272k' }], maxMode: false },
          { parameters: [{ id: 'context', value: '1m' }], maxMode: true }
        ]
      }]
    }
    expect(() => resolveTeamSetupMembers(constrained, {
      draftId: constrained.draftId,
      members: [{
        channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skillIds: [],
        modelSelection: {
          modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', maxMode: true,
          parameters: [{ id: 'context', value: '272k' }]
        }
      }]
    })).toThrowError(/模型参数组合不可用/)
    expect(() => resolveTeamSetupMembers(constrained, {
      draftId: constrained.draftId,
      members: [{
        channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skillIds: [],
        modelSelection: {
          modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', maxMode: true,
          parameters: [{ id: 'context', value: '1m' }]
        }
      }]
    })).not.toThrow()
  })

  it('rejects unavailable channels, duplicates and uninstalled recommendations', () => {
    expect(() => resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: [{ channelId: 'abc', roleTemplateKey: 'lead', avatarId: 'lead', skillIds: [] }]
    })).toThrowError(/通道不可用/)
    expect(() => resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: [
        { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skillIds: [] },
        { channelId: '1', roleTemplateKey: 'builder', avatarId: 'architect', skillIds: [] }
      ]
    })).toThrowError(/重复/)
    expect(() => resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: [{ channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skillIds: ['recommended:frontend'] }]
    })).toThrowError(/未安装/)
  })

  it('accepts new numeric channel ids beyond the draft as offline standby channels', () => {
    expect(resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: [
        { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skillIds: [] },
        { channelId: '6', roleTemplateKey: 'builder', avatarId: 'architect', skillIds: [] }
      ]
    })).toEqual([
      expect.objectContaining({ channelId: '1', roleTemplateKey: 'lead' }),
      expect.objectContaining({ channelId: '6', roleTemplateKey: 'builder' })
    ])
  })

  it('rejects teams larger than 16 members', () => {
    expect(() => resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: Array.from({ length: 17 }, (_, index) => ({
        channelId: String(index + 1),
        roleTemplateKey: index === 0 ? 'lead' : 'specialist',
        avatarId: 'lead',
        skillIds: []
      }))
    })).toThrowError(/不能超过 16/)
  })

  it('passes solo through, forces empty skills, and rejects role/solo mismatches', () => {
    const resolved = resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: [
        { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skillIds: [] },
        { channelId: '2', roleTemplateKey: 'solo', avatarId: 'researcher', skillIds: ['project:tdd'], solo: true }
      ]
    })
    expect(resolved[1]).toMatchObject({ channelId: '2', roleTemplateKey: 'solo', solo: true, skills: [] })
    expect(() => resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: [{ channelId: '1', roleTemplateKey: 'builder', avatarId: 'architect', skillIds: [], solo: true }]
    })).toThrowError(/独立席位必须使用独立执行角色/)
    expect(() => resolveTeamSetupMembers(draft, {
      draftId: draft.draftId,
      members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'researcher', skillIds: [], solo: false }]
    })).toThrowError(/团队席位不能使用独立执行角色/)
  })

  it('builds 1–16 isolated sessions with sequential channels and validated models', () => {
    const resolved = resolveIndependentSessionMembers(draft.cursorModels ?? [], {
      workspacePath: draft.workspacePath,
      sessions: [{}, {
        modelSelection: {
          modelId: 'kimi-k3', displayName: 'Kimi K3', maxMode: false,
          parameters: [{ id: 'reasoning', value: 'low' }]
        }
      }]
    })
    expect(resolved.map((member) => [member.channelId, member.roleTemplateKey, member.solo])).toEqual([
      ['1', 'solo', true], ['2', 'solo', true]
    ])
    expect(resolved[1]?.modelSelection?.parameters).toEqual([{ id: 'reasoning', value: 'low' }])
    expect(() => resolveIndependentSessionMembers(draft.cursorModels ?? [], {
      workspacePath: draft.workspacePath, sessions: []
    })).toThrowError(/1 到 16/)
  })
})
