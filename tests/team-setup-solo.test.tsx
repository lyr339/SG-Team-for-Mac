// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_AVATAR_IDS, TEAM_ROLE_TEMPLATES } from '../src/domain/team-control'
import { TeamSetupPage } from '../src/renderer/src/team/TeamSetupPage'
import type { TeamSetupDraft } from '../src/shared/desktop-api'

const draft: TeamSetupDraft = {
  draftId: 'solo-ui', workspaceId: 'solo-ui', workspaceName: 'solo-ui', workspacePath: '/workspace/solo-ui',
  channels: ['1', '2', '3'].map((channelId) => ({
    channelId, displayName: `CH-${channelId}`, status: 'offline', online: false, waiting: false, queueDepth: 0
  })),
  roleTemplates: TEAM_ROLE_TEMPLATES,
  avatarIds: [...AGENT_AVATAR_IDS],
  skills: [{ id: 'skill:test', name: 'test', description: 'test', scope: 'project', installed: true, source: 'workspace', recommendedRoles: ['builder'] }],
  cursorModels: []
}

describe('TeamSetupPage solo seat', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('toggles a seat to solo, locks its role and hides skill assignment sections', async () => {
    await act(async () => root.render(<TeamSetupPage draft={draft} onCreate={async () => {}} onCancel={() => {}} />))
    const articles = [...container.querySelectorAll<HTMLElement>('.team-setup-seats article')]
    const builder = articles.find((article) => article.textContent?.includes('CH-2'))!
    await act(async () => builder.click())
    const soloToggle = builder.querySelector<HTMLInputElement>('.toggle-switch input')!
    await act(async () => soloToggle.click())

    expect(builder.className).toContain('is-solo')
    expect(builder.textContent).toContain('独立席')
    expect(builder.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true)
    expect(builder.querySelector<HTMLSelectElement>('select')?.value).toBe('solo')
    expect(container.querySelector('.team-setup-inspector')?.textContent).not.toContain('已安装技能')
    expect(container.querySelector('.team-setup-inspector')?.textContent).not.toContain('推荐技能')

    await act(async () => soloToggle.click())
    expect(builder.className).not.toContain('is-solo')
    expect(builder.querySelector<HTMLSelectElement>('select')?.disabled).toBe(false)
    expect(builder.querySelector<HTMLSelectElement>('select')?.value).not.toBe('solo')
  })

  it('blocks an all-solo composition with the dedicated validation message', async () => {
    await act(async () => root.render(<TeamSetupPage draft={draft} onCreate={async () => {}} onCancel={() => {}} />))
    for (const channelId of ['1', '2', '3']) {
      const article = [...container.querySelectorAll<HTMLElement>('.team-setup-seats article')]
        .find((candidate) => candidate.textContent?.includes(`CH-${channelId}`))!
      await act(async () => article.querySelector<HTMLInputElement>('.toggle-switch input')!.click())
    }
    expect(container.querySelector('.team-setup-footer')?.textContent)
      .toContain('至少保留 1 个团队席位（含 1 名主控）')
    expect([...container.querySelectorAll<HTMLButtonElement>('.team-setup-footer button')].at(-1)?.disabled).toBe(true)
  })
})
