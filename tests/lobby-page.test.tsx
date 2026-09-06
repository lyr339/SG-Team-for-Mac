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
  onInstallMcp: async () => ({
    installation: {
      ok: true as const, workspacePath: '/workspace/wedge-demo', workspaceId: 'wedge-demo', runId: 'team-run:wedge-demo:main',
      configPath: '/workspace/wedge-demo/.cursor/mcp.json', serverNames: ['SG Team'], autoInjected: true, restartRequired: false
    },
    snapshot: teamControlSnapshot
  }),
  onLaunch: async () => teamControlSnapshot,
  onCreateNextRun: async () => ({ snapshot: teamControlSnapshot, restartRequired: false }),
  onLaunchAgentSessions: async () => ({ id: 'plan:test', state: 'done' as const, items: [], startedAt: 1, finishedAt: 2 }),
  onCreateIndependentSessions: async () => ({ id: 'plan:independent', state: 'done' as const, items: [], startedAt: 1, finishedAt: 2 }),
  onChooseIndependentWorkspace: async () => undefined,
  onEndActiveRun: async () => {},
  onOpenSessions: () => {},
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

  it('独立会话页提供批量数量和逐会话模型配置', () => {
    const html = renderToStaticMarkup(
      <LobbyPage
        {...common}
        detectedWorkspace={{ id: 'wedge-demo', name: 'wedge-demo', path: '/workspace/wedge-demo' }}
        section="independent"
        onSectionChange={() => {}}
      />
    )
    expect(html).toContain('aria-label="独立会话配置"')
    expect(html).toContain('批量创建常驻 Cursor 会话')
    expect(html).toContain('会话数量')
    expect(html).toContain('批量创建独立会话（3）')
    expect(html).toContain('配置 CH-1 会话')
  })
})

/**
 * 独立模式下团队页不再整页拦截，而是渲染 RunModePanel（会话围栏 + 软守卫）：
 * 切换/结束不以「旧会话全部离线」为前提，只在仍有在线会话时要一次确认。
 * 确认交互（点击 → alertdialog → 回调）见 tests/run-mode-panel.test.tsx。
 */
describe('LobbyPage 独立模式运行面板（会话围栏软守卫）', () => {
  function independentTeam(options: { online: boolean }) {
    const snapshot = structuredClone(teamControlSnapshot)
    snapshot.activeRun = { ...snapshot.activeRun!, templateId: 'independent-session-v1' }
    snapshot.members = snapshot.members
      .filter((member) => member.slot.solo === true)
      .map((member) => ({
        ...member,
        runtime: member.runtime
          ? {
              ...member.runtime,
              online: options.online,
              waiting: options.online,
              status: options.online ? 'waiting' : 'offline',
              connectionPhase: options.online ? 'waiting' : 'offline'
            }
          : member.runtime
      }))
    return snapshot
  }

  it('独立会话全部离线时直接开放「切换为团队模式」与「结束独立批次」', () => {
    const html = renderToStaticMarkup(
      <LobbyPage
        {...common}
        section="team"
        onSectionChange={() => {}}
        team={independentTeam({ online: false })}
      />
    )
    expect(html).toContain('aria-label="运行模式"')
    expect(html).toContain('当前模式 · 独立会话')
    expect(html).not.toContain('当前正在使用独立会话')
    expect(html).toContain('所有独立会话已离线，可以直接切换。')
    expect(html).toContain('离线 1')
    for (const label of ['切换为团队模式', '结束独立批次', '查看独立会话']) {
      expect(html).toContain(label)
      expect(html).not.toMatch(new RegExp(`<button[^>]*disabled[^>]*>[^<]*${label}`))
    }
  })

  it('仍有在线独立会话时保持按钮可用，只说明围栏后果（软守卫，不再硬阻）', () => {
    const html = renderToStaticMarkup(
      <LobbyPage
        {...common}
        section="team"
        onSectionChange={() => {}}
        team={independentTeam({ online: true })}
      />
    )
    expect(html).toContain('待命 1')
    expect(html).toContain('run-mode-panel__consequence is-warning')
    expect(html).toContain('1 个会话仍在线或待确认')
    expect(html).toContain('下一次轮询（最长 60 秒）收到结束指令并退出')
    expect(html).not.toContain('全部离线后即可切换为团队模式')
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>[^<]*切换为团队模式/)
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>[^<]*结束独立批次/)
    // 未点击前不渲染确认框
    expect(html).not.toContain('role="alertdialog"')
  })

  it('独立批次已结束时禁用「结束独立批次」并提示可直接组建团队', () => {
    const team = independentTeam({ online: false })
    team.activeRun = { ...team.activeRun!, status: 'completed' }
    const html = renderToStaticMarkup(
      <LobbyPage {...common} section="team" onSectionChange={() => {}} team={team} />
    )
    expect(html).toContain('独立批次 · 已结束')
    expect(html).toContain('本批次已结束：旧会话下一次轮询会收到结束指令并自行退出。')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*结束独立批次/)
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>[^<]*切换为团队模式/)
  })
})
