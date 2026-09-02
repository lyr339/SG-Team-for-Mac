import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, IDLE_ACCOUNT_AUTOMATION_RUN } from '../src/domain/account-automation'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import { LobbyPage } from '../src/renderer/src/lobby/LobbyPage'
import { collaborationSnapshot, desktopSnapshot, teamControlSnapshot } from '../src/renderer/src/preview/mock-data'

const account = {
  accounts: [{
    id: 'account:1', label: 'work@example.com', maskedToken: '••••token',
    active: true, createdAt: 1, updatedAt: 1
  }],
  busy: false,
  error: '',
  onSave: async () => {},
  onSelect: async () => {},
  onRemove: async () => {},
  onRestartWithAccount: async () => {},
  onImportFromFingerprint: async () => {},
  onImportFromLocal: async () => {},
  onImportFromBrowser: async () => {},
  aozaiStatus: { saved: true, maskedCode: '••••card', type: '次卡', remaining: 5 },
  aozaiBusy: false,
  aozaiError: '',
  onSaveAozaiCard: async () => {},
  onClearAozaiCard: async () => {},
  onRefreshAozaiBalance: async () => {},
  onProcessAozaiAccount: async () => {},
  automationSettings: DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
  automationRun: IDLE_ACCOUNT_AUTOMATION_RUN,
  cursorUpdatePreferences: {
    settingsPath: '/Users/example/Library/Application Support/Cursor/User/settings.json',
    updateMode: 'none' as const,
    autoUpdateDisabled: true,
    settingsExists: true
  },
  cursorUpdateBusy: false,
  cursorUpdateError: '',
  onSetCursorAutoUpdateDisabled: async () => {},
  onSaveAutomationSettings: () => {},
  onCancelAutomation: () => {}
}

const common = {
  team: teamControlSnapshot,
  collaboration: collaborationSnapshot,
  cursorModels: desktopSnapshot.cursorModels ?? [],
  onChooseWorkspace: async () => {},
  onReconfigure: async () => {},
  onUpdateGoal: async () => teamControlSnapshot,
  onInstallMcp: async () => ({ installation: { ok: true as const, restartRequired: false, detail: '' }, snapshot: teamControlSnapshot }),
  onLaunch: async () => teamControlSnapshot,
  onCreateNextRun: async () => ({ snapshot: teamControlSnapshot, restartRequired: false }),
  onLaunchAgentSessions: async () => ({ id: 'plan:test', state: 'done' as const, items: [], startedAt: 1, finishedAt: 2 }),
  cdpAutoHealEnabled: false,
  account
}

describe('LobbyPage', () => {
  it('把团队运行与账号管线拆成独立配置页', () => {
    const html = renderToStaticMarkup(
      <LobbyPage {...common} section="team" onSectionChange={() => {}} />
    )

    expect(html).toContain('aria-label="配置分类"')
    expect(html).toContain('团队')
    expect(html).toContain('账号与 Cursor')
    expect(html).toContain('lobby-workbench lobby-workbench--team has-session-launch')
    expect(html).toContain('aria-label="运行控制"')
    expect(html).toContain('运行脉冲')
    expect(html.match(/lobby-summary__slot is-/g)).toHaveLength(teamControlSnapshot.members.length)
    expect(html).toContain(`aria-label="${teamControlSnapshot.members.length} 个团队席位`)
    expect(html).toContain('aria-label="逐会话模型配置"')
    expect(html).toContain('配置 CH-2 会话')
    expect(html).not.toContain('Cursor 账号管线')
  })

  it('账号与 Cursor 页保留完整账号自动化和本机维护链', () => {
    const html = renderToStaticMarkup(
      <LobbyPage {...common} section="account" onSectionChange={() => {}} />
    )

    expect(html).toContain('aria-label="账号与 Cursor 配置"')
    expect(html).toContain('Cursor 账号管线')
    expect(html).toContain('aria-label="账号自动化流程"')
    expect(html).toContain('获取 Token')
    expect(html).toContain('aria-label="浏览器来源切换"')
    expect(html).toContain('会话浏览器')
    expect(html).toContain('倒计时')
    expect(html).toContain('奥仔处理')
    expect(html).toContain('账号加固')
    expect(html).toContain('收尾')
    expect(html).toContain('Cursor 本机维护')
    expect(html).not.toContain('运行脉冲')
  })

  it('尚未创建团队时仍可直接管理账号与 Cursor', () => {
    const html = renderToStaticMarkup(
      <LobbyPage {...common} team={emptyTeamControlSnapshot()} section="account" onSectionChange={() => {}} />
    )
    expect(html).toContain('Cursor 账号管线')
    expect(html).not.toContain('选择一个 Cursor 工程')
  })
})
