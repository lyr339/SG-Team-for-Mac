import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, IDLE_ACCOUNT_AUTOMATION_RUN } from '../src/domain/account-automation'
import { LobbyPage } from '../src/renderer/src/lobby/LobbyPage'
import { collaborationSnapshot, teamControlSnapshot } from '../src/renderer/src/preview/mock-data'

describe('LobbyPage', () => {
  it('renders the lobby as a compact control rail plus account pipeline', () => {
    const html = renderToStaticMarkup(
      <LobbyPage
        team={teamControlSnapshot}
        collaboration={collaborationSnapshot}
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
          onInject: async () => {},
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
    expect(html).toContain('Cursor 账号管线')
    expect(html).toContain('lobby-account__stage lobby-account__stock')
    expect(html).toContain('lobby-account__stage lobby-account__acquire')
    expect(html).toContain('lobby-account__stage lobby-account__ops')
    expect(html).not.toContain('class="lobby-grid"')
  })
})
