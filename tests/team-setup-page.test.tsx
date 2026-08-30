import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AGENT_AVATAR_IDS, TEAM_ROLE_TEMPLATES } from '../src/domain/team-control'
import { TeamSetupPage } from '../src/renderer/src/team/TeamSetupPage'
import type { TeamSetupDraft } from '../src/shared/desktop-api'

const draft: TeamSetupDraft = {
  draftId: 'setup-models',
  workspaceId: 'workspace',
  workspaceName: 'workspace',
  workspacePath: '/workspace',
  channels: ['1', '2', '3', '4', '5'].map((channelId) => ({
    channelId, displayName: `CH-${channelId}`, status: 'offline', online: false,
    waiting: false, queueDepth: 0
  })),
  roleTemplates: TEAM_ROLE_TEMPLATES,
  avatarIds: [...AGENT_AVATAR_IDS],
  skills: [],
  cursorModels: [{
    modelId: 'kimi-k3', displayName: 'Kimi K3', selected: true, maxMode: false,
    supportsMaxMode: true, supportsNonMaxMode: true,
    contextTokenLimit: 1_048_576, contextTokenLimitForMaxMode: 1_048_576,
    parameters: [{ id: 'reasoning', value: 'high' }], optionLabels: ['High'],
    parameterDefinitions: [{
      id: 'reasoning', displayName: 'Reasoning', kind: 'enum',
      values: [
        { value: 'low', displayName: 'Low', increasesCost: false },
        { value: 'high', displayName: 'High', increasesCost: true }
      ]
    }]
  }, {
    modelId: 'gpt-5.3-codex', displayName: 'Codex 5.3', selected: false, maxMode: false,
    parameters: [], optionLabels: [], parameterDefinitions: []
  }]
}

describe('TeamSetupPage · channel count and model controls', () => {
  it('keeps seat cards compact while exposing model controls only in the selected inspector', () => {
    const html = renderToStaticMarkup(
      <TeamSetupPage draft={draft} onCreate={async () => {}} onCancel={() => {}} />
    )
    expect(html).toContain('团队通道')
    expect(html.match(/type="checkbox"/g)).toHaveLength(4)
    expect(html).not.toContain('CH-4')
    expect(html).not.toContain('CH-5')
    expect(html).not.toContain('team-setup-seat__model')
    expect(html).toContain('CH-1 Cursor 模型')
    expect(html).toContain('CH-1 Reasoning')
    expect(html).toContain('MAX Mode')
    expect(html).toContain('200K · Standard')
    expect(html).toContain('Kimi K3 · Cursor 当前')
    expect(html).toContain('不改变 Cursor 全局模型')
  })
})
