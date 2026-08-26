import { describe, expect, it } from 'vitest'
import { resolveTeamSetupMembers } from '../src/application/team-setup'
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
        { channelId: '5', roleTemplateKey: 'builder', avatarId: 'architect', skillIds: ['project:tdd'] }
      ]
    })).toEqual([
      expect.objectContaining({ channelId: '2', roleTemplateKey: 'lead' }),
      expect.objectContaining({
        channelId: '5',
        skills: [{ id: 'project:tdd', name: 'tdd', description: 'TDD', scope: 'project' }]
      })
    ])
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
})
