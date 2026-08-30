import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, IDLE_ACCOUNT_AUTOMATION_RUN } from '../src/domain/account-automation'
import { LobbyPage } from '../src/renderer/src/lobby/LobbyPage'
import { collaborationSnapshot, desktopSnapshot, teamControlSnapshot } from '../src/renderer/src/preview/mock-data'

describe('LobbyPage', () => {
  it('renders the lobby as a compact control rail plus account pipeline', () => {
    const html = renderToStaticMarkup(
      <LobbyPage
        team={teamControlSnapshot}
        collaboration={collaborationSnapshot}
        cursorModels={desktopSnapshot.cursorModels ?? []}
        onChooseWorkspace={async () => {}}
        onReconfigure={async () => {}}
        onUpdateGoal={async () => teamControlSnapshot}
        onInstallMcp={async () => ({ installation: { ok: true, restartRequired: false, detail: '' }, snapshot: teamControlSnapshot })}
        onLaunch={async () => teamControlSnapshot}
        onCreateNextRun={async () => ({ snapshot: teamControlSnapshot, restartRequired: false })}
        onLaunchAgentSessions={async () => ({ id: 'plan:test', state: 'done', items: [], startedAt: 1, finishedAt: 2 })}
        cdpAutoHealEnabled={false}
        account={{
          accounts: [{
            id: 'account:1',
            label: 'work@example.com',
            maskedToken: '••••token',
            active: true,
            createdAt: 1,
            updatedAt: 1
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
            updateMode: 'none',
            autoUpdateDisabled: true,
            settingsExists: true
          },
          cursorUpdateBusy: false,
          cursorUpdateError: '',
          onSetCursorAutoUpdateDisabled: async () => {},
          onSaveAutomationSettings: () => {},
          onCancelAutomation: () => {}
        }}
      />
    )

    expect(html).toContain('lobby-workbench has-session-launch')
    expect(html).toContain('aria-label="运行控制"')
    expect(html).toContain('运行脉冲')
    expect(html.match(/lobby-summary__slot is-/g)).toHaveLength(teamControlSnapshot.members.length)
    expect(html).toContain(`aria-label="${teamControlSnapshot.members.length} 个团队席位`)
    expect(html).toContain('Cursor 账号管线')
    expect(html).toContain('lobby-account__flow')
    expect(html).toContain('aria-label="逐会话模型配置"')
    expect(html).toContain('Composer 2.5')
    expect(html).toContain('配置 CH-2 会话')
    expect(html).toContain('Fast')
    expect(html).toContain('200K · Standard')
    expect(html).toContain('MAX Mode Off')
    expect(html).toContain('aria-label="账号自动化流程"')
    expect(html).toContain('获取 Token')
    expect(html).toContain('aria-label="浏览器来源切换"')
    expect(html).toContain('从指纹浏览器导入（推荐）')
    expect(html).toContain('自动获取本机 Token')
    expect(html).toContain('手动粘贴 Token')
    expect(html).not.toContain('其他获取方式')
    expect(html).toContain('倒计时')
    expect(html).toContain('奥仔处理')
    expect(html).toContain('账号加固')
    expect(html).toContain('收尾')
    expect(html).not.toContain('lobby-account__columns')
    expect(html).not.toContain('lobby-account__stage')
    expect(html).not.toContain('class="lobby-grid"')
  })
})
