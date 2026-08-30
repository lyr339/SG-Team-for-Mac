import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
  type AccountAutomationRun
} from '../src/domain/account-automation'
import {
  LobbyAccountTile,
  accountFlowStatesFor,
  automationDurationText,
  automationFailedStepHint,
  type LobbyAccountTileProps
} from '../src/renderer/src/lobby/LobbyAccountTile'

const accounts: LobbyAccountTileProps['accounts'] = [
  { id: 'account:1', label: 'work@example.com', maskedToken: '••••9f2k', active: true, createdAt: 1, updatedAt: 1 },
  { id: 'account:2', label: 'spare@example.com', maskedToken: '••••41qz', active: false, createdAt: 2, updatedAt: 2 }
]

function propsFor(overrides: Partial<LobbyAccountTileProps> = {}): LobbyAccountTileProps {
  return {
    accounts,
    busy: false,
    error: '',
    onSave: async () => {},
    onSelect: async () => {},
    onRemove: async () => {},
    onRestartWithAccount: async () => {},
    onImportFromLocal: async () => {},
    onImportFromBrowser: async () => {},
    aozaiStatus: { saved: true, maskedCode: '••••card', type: '次卡', remaining: 5 },
    aozaiBusy: false,
    aozaiError: '',
    onSaveAozaiCard: async () => {},
    onClearAozaiCard: async () => {},
    onRefreshAozaiBalance: async () => {},
    onProcessAozaiAccount: async () => {},
    automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, enabled: true, delaySec: 10 },
    automationRun: { phase: 'idle', message: '', startedAt: 0 },
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
    onCancelAutomation: () => {},
    ...overrides
  }
}

function runFor(overrides: Partial<AccountAutomationRun>): AccountAutomationRun {
  return { phase: 'idle', message: '', startedAt: 0, ...overrides }
}

describe('accountFlowStatesFor', () => {
  it('maps idle phase to stock-driven resting states', () => {
    expect(accountFlowStatesFor({
      phase: 'idle', hasAccount: true, automationEnabled: true, aozaiReady: true, lastActiveStep: 'countdown'
    })).toEqual({ acquire: 'done', countdown: 'ready', processing: 'ready', deleting: 'waiting', finish: 'waiting' })
    expect(accountFlowStatesFor({
      phase: 'idle', hasAccount: false, automationEnabled: false, aozaiReady: false, lastActiveStep: 'countdown'
    })).toEqual({ acquire: 'waiting', countdown: 'off', processing: 'waiting', deleting: 'waiting', finish: 'waiting' })
  })

  it('walks active phases in order and attributes failure to the last active step', () => {
    expect(accountFlowStatesFor({
      phase: 'processing', hasAccount: true, automationEnabled: true, aozaiReady: true, lastActiveStep: 'processing'
    })).toEqual({ acquire: 'done', countdown: 'done', processing: 'running', deleting: 'waiting', finish: 'waiting' })
    expect(accountFlowStatesFor({
      phase: 'importing', hasAccount: true, automationEnabled: true, aozaiReady: true, lastActiveStep: 'deleting'
    }).deleting).toBe('running')
    const failed = accountFlowStatesFor({
      phase: 'failed', hasAccount: true, automationEnabled: true, aozaiReady: true, lastActiveStep: 'deleting'
    })
    expect(failed).toEqual({ acquire: 'done', countdown: 'done', processing: 'done', deleting: 'failed', finish: 'failed' })
  })

  it('marks cancelled runs at the countdown step', () => {
    expect(accountFlowStatesFor({
      phase: 'cancelled', hasAccount: true, automationEnabled: true, aozaiReady: true, lastActiveStep: 'countdown'
    })).toEqual({ acquire: 'done', countdown: 'cancelled', processing: 'waiting', deleting: 'waiting', finish: 'cancelled' })
  })
})

describe('automationDurationText', () => {
  it('formats sub-minute and multi-minute durations', () => {
    expect(automationDurationText(runFor({ startedAt: 1_000, finishedAt: 13_500 }))).toBe('12.5 秒')
    expect(automationDurationText(runFor({ startedAt: 2_000, finishedAt: 77_000 }))).toBe('1 分 15 秒')
    expect(automationDurationText(runFor({ startedAt: 0, finishedAt: 5_000 }))).toBe('')
    expect(automationDurationText(runFor({ startedAt: 1_000, finishedAt: undefined }))).toBe('')
  })
})

describe('LobbyAccountTile', () => {
  it('renders the five-step flow with accessible state labels in idle phase', () => {
    const html = renderToStaticMarkup(<LobbyAccountTile {...propsFor()} />)

    expect(html).toContain('aria-label="账号自动化流程"')
    for (const [index, title, state] of [
      [1, '获取 Token', '完成'],
      [2, '倒计时', '就绪'],
      [3, '奥仔处理', '就绪'],
      [4, '账号加固', '等待'],
      [5, '收尾', '等待']
    ] as const) {
      expect(html).toContain(`aria-label="步骤 ${index}：${title}，${state}"`)
    }
    expect(html).not.toContain('lobby-account__columns')
  })

  it('合并状态行：一致 + 档位一行呈现（档位段着色），带手动刷新按钮', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        runtimeMatch: { status: 'matched', cursorLabel: 'work@example.com', activeLabel: 'work@example.com' },
        membership: { state: 'ok', profile: { tier: 'free', raw: 'free', fetchedAt: 1 } },
        onRefreshMembership: () => {}
      })} />
    )
    expect(html).toContain('account-status-line is-off')
    expect(html).toContain('work@example.com · 一致 ·')
    expect(html).toContain('<span class="is-tier-free">Free</span>')
    expect(html).toContain('>刷新</button>')
    // 悬停完整说明（劈叉明细走 title）
    expect(html).toContain('title="Cursor 运行登录态与活跃账号的比对 + 在线会员档位')

    const paid = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        runtimeMatch: { status: 'matched', cursorLabel: 'work@example.com', activeLabel: 'work@example.com' },
        membership: { state: 'ok', profile: { tier: 'pro', raw: 'pro', fetchedAt: 1 } }
      })} />
    )
    expect(paid).toContain('account-status-line"')  // 无警示 tone
    expect(paid).toContain('work@example.com · 一致 ·')
    expect(paid).toContain('<span class="is-tier-pro">Pro</span>')
    expect(paid).not.toContain('is-tier-free')
  })

  it('档位段按档位着色：free/trial/pro/pro+/ultra/enterprise 各自类名', () => {
    for (const [tier, className] of [
      ['free', 'is-tier-free'],
      ['free_trial', 'is-tier-trial'],
      ['pro', 'is-tier-pro'],
      ['pro_plus', 'is-tier-proplus'],
      ['ultra', 'is-tier-ultra'],
      ['enterprise', 'is-tier-enterprise']
    ] as const) {
      const html = renderToStaticMarkup(
        <LobbyAccountTile {...propsFor({
          membership: { state: 'ok', profile: { tier, raw: tier, fetchedAt: 1 } }
        })} />
      )
      expect(html).toContain(className)
    }
  })

  it('状态行位于卡片头：替换「当前 xxx」；无信号时回退原展示', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        runtimeMatch: { status: 'matched', cursorLabel: 'work@example.com', activeLabel: 'work@example.com' },
        membership: { state: 'ok', profile: { tier: 'free', raw: 'free', fetchedAt: 1 } }
      })} />
    )
    expect(html).toContain('<em class="lobby-account__current"><span class="account-status-line is-off"')
    expect(html).toContain('account-status-line__text')

    // 无信号（未拉取/未登录）：头部回退「当前 xxx」粗体展示
    const fallback = renderToStaticMarkup(<LobbyAccountTile {...propsFor({})} />)
    expect(fallback).toContain('<b>work@example.com</b>')
    expect(fallback).not.toContain('account-status-line')
  })

  it('延时滑杆与自动化开关同行呈现', () => {
    const html = renderToStaticMarkup(<LobbyAccountTile {...propsFor()} />)
    expect(html).toContain('<div class="account-automation__row"><label class="toggle-switch')
    expect(html).toMatch(/account-automation__delay"><span>延时<\/span>[\s\S]*?type="range"/)
  })

  it('合并状态行：mismatch 红点精简文案，title 携带双账号明细', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        runtimeMatch: { status: 'mismatch', cursorLabel: 'other@example.com', activeLabel: 'work@example.com' },
        membership: { state: 'ok', profile: { tier: 'pro', raw: 'pro', fetchedAt: 1 } }
      })} />
    )
    expect(html).toContain('account-status-line is-off')
    expect(html).toContain('登录账号不一致 ·')
    expect(html).toContain('<span class="is-tier-pro">Pro</span>')
    expect(html).toContain('Cursor 当前登录 other@example.com，活跃账号 work@example.com')
  })

  it('合并状态行：仅一侧有信号照常渲染；全部无信号不渲染', () => {
    const runtimeOnly = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({ runtimeMatch: { status: 'matched', cursorLabel: 'a@x.com', activeLabel: 'a@x.com' } })} />
    )
    expect(runtimeOnly).toContain('a@x.com · 一致')

    const membershipError = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({ membership: { state: 'error', detail: 'HTTP 503' } })} />
    )
    expect(membershipError).toContain('account-status-line is-warn')
    expect(membershipError).toContain('档位获取失败')

    for (const props of [
      { runtimeMatch: { status: 'vault_empty' as const } },
      { runtimeMatch: { status: 'cursor_unavailable' as const } },
      { membership: { state: 'not_logged_in' as const } },
      {}
    ]) {
      const html = renderToStaticMarkup(<LobbyAccountTile {...propsFor(props)} />)
      expect(html).not.toContain('account-status-line')
    }
  })

  it('keeps every existing feature entry point', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        automationSettings: { enabled: true, delaySec: 10, browserHost: 'external' },
        onImportFromFingerprint: async () => {}
      })} />
    )

    // 账号库存：选择 / 切换并重启 / 处理 / 删除
    expect(html).toContain('work@example.com')
    expect(html).toContain('>处理</button>')
    expect(html).toContain('>切换并重启</button>')
    expect(html).toContain('>删除</button>')
    // 获取路径并列（external 来源下从浏览器导入为工作流主路径）
    expect(html).toContain('从浏览器导入 Token')
    expect(html).toContain('自动获取本机 Token')
    expect(html).toContain('手动粘贴 Token')
    expect(html).not.toContain('其他获取方式')
    // 奥仔卡密：刷新余额 / 更换卡密
    expect(html).toContain('刷新余额')
    expect(html).toContain('更换卡密')
    // 自动化开关（自绘 ToggleSwitch，保留原生 checkbox 可达性）与延时滑杆
    expect(html).toContain('会话创建后自动处理账号')
    expect(html).toContain('toggle-switch')
    expect(html).toContain('type="range"')
    expect(html).toContain('range-field__value')
    // Cursor 本机维护
    expect(html).toContain('关闭 Cursor 自动更新')
  })

  it('shows the countdown scene with remaining seconds and a cancel button', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        automationRun: runFor({
          phase: 'countdown',
          message: '将在 6.5s 后自动处理当前账号（可取消）',
          remainingSec: 6.5,
          startedAt: 1_000
        })
      })}
      />
    )

    expect(html).toContain('aria-label="步骤 2：倒计时，进行"')
    expect(html).toContain('aria-label="自动化倒计时"')
    expect(html).toContain('6.5')
    expect(html).toContain('将在 6.5s 后自动处理当前账号（可取消）')
    expect(html).toContain('flow-step__cancel')
    expect(html).toContain('>取消</button>')
  })

  it('streams the live message on the processing step', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        automationRun: runFor({ phase: 'processing', message: '奥仔：正在提交 Session Token 处理…', startedAt: 1_000 })
      })}
      />
    )

    expect(html).toContain('aria-label="步骤 3：奥仔处理，进行"')
    expect(html).toContain('aria-label="步骤 2：倒计时，完成"')
    expect(html).toContain('aria-live="polite">奥仔：正在提交 Session Token 处理…')
  })

  it('summarizes a done run with duration on the finish step', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        automationRun: runFor({
          phase: 'done',
          message: '自动化完成：已处理、账号已加固、本地记录已移除',
          startedAt: 10_000,
          finishedAt: 22_500
        })
      })}
      />
    )

    expect(html).toContain('aria-label="步骤 5：收尾，完成"')
    expect(html).toContain('耗时 12.5 秒')
    expect(html).toContain('自动化完成：已处理、账号已加固、本地记录已移除')
  })

  it('shows the full error message when the run failed', () => {
    const message = '奥仔处理失败：卡密余额不足，请先充值或更换卡密（本地账号已保留）'
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        automationRun: runFor({ phase: 'failed', message, startedAt: 10_000, finishedAt: 20_000 })
      })}
      />
    )

    // 无活跃轨迹时按消息文案归属到奥仔处理步骤
    expect(html).toContain('aria-label="步骤 3：奥仔处理，失败"')
    expect(html).toContain('aria-label="步骤 5：收尾，失败"')
    expect(html).toContain('role="alert"')
    expect(html).toContain(`流程未完成：${message}`)
  })

  it('hints the failed step from persisted run messages', () => {
    expect(automationFailedStepHint('奥仔处理失败：卡密余额不足')).toBe('processing')
    expect(automationFailedStepHint('新 Token 获取失败：网络超时（本地账号已保留）')).toBe('deleting')
    expect(automationFailedStepHint('官网持续要求先退出团队（已等待 60s 重试 3 次）')).toBe('deleting')
    expect(automationFailedStepHint('尚未选择 Cursor 账号，自动化中止')).toBe('countdown')
    // preflight 类失败含「会话」但发生在倒计时阶段，不能误标到删除步骤
    expect(automationFailedStepHint('浏览器会话读取失败，请先登录')).toBe('countdown')
  })

  it('marks a cancelled run without pretending progress', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        automationRun: runFor({ phase: 'cancelled', message: '已取消本次自动化', startedAt: 10_000, finishedAt: 14_000 })
      })}
      />
    )

    expect(html).toContain('aria-label="步骤 2：倒计时，已取消"')
    expect(html).toContain('aria-label="步骤 5：收尾，已取消"')
    expect(html).toContain('已取消本次自动化')
  })

  it('labels the countdown step as off when automation is disabled', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({ automationSettings: { enabled: false, delaySec: 10 } })} />
    )

    expect(html).toContain('aria-label="步骤 2：倒计时，未开启"')
    expect(html).toContain('会话创建后自动处理账号')
  })

  it('renders the browser source segment with fingerprint default in step 1', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        bitProfiles: [
          { id: 'bit-proxy', name: '代理', seq: 1 },
          { id: 'bit-direct', name: '直连', seq: 2 }
        ],
        onRefreshBitProfiles: () => {},
        onImportFromFingerprint: async () => {}
      })} />
    )

    // 分段控件在第一步「获取 Token」，默认选中指纹
    expect(html).toContain('aria-label="浏览器来源切换"')
    expect(html).toMatch(/aria-selected="true"[^>]*>指纹浏览器<\/button>/)
    expect(html).toMatch(/aria-selected="false"[^>]*>系统浏览器<\/button>/)
    // 紧凑配置行：自绘下拉关闭态只显示占位符（选项列表展开时才渲染）
    expect(html).not.toContain('<option value="roxybrowser">Roxy</option>')
    expect(html).toContain('menu-select__button')
    expect(html).toContain('选择窗口…')
    expect(html).not.toContain('#1 代理')
    // 主导入按钮
    expect(html).toContain('从指纹浏览器导入（推荐）')
  })

  it('已选指纹窗口时下拉按钮直接显示窗口名（自绘 MenuSelect 选中态）', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        automationSettings: { enabled: true, delaySec: 10, bitProfileId: 'bit-proxy' },
        bitProfiles: [
          { id: 'bit-proxy', name: '代理', seq: 1 },
          { id: 'bit-direct', name: '直连', seq: 2 }
        ],
        onImportFromFingerprint: async () => {}
      })} />
    )

    expect(html).toContain('#1 代理')
    expect(html).not.toContain('选择窗口…')
    // 选中窗口后主导入按钮解除禁用
    expect(html).not.toContain('请先在上方选择指纹浏览器窗口')
  })

  it('external source shows edge hint and browser import as quick action', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        automationSettings: { enabled: true, delaySec: 10, browserHost: 'external' },
        bitProfiles: [{ id: 'bit-proxy', name: '代理', seq: 1 }],
        onImportFromFingerprint: async () => {}
      })} />
    )

    expect(html).toMatch(/aria-selected="true"[^>]*>系统浏览器<\/button>/)
    expect(html).toContain('需在 Edge / Chrome 登录 cursor.com')
    expect(html).toContain('从浏览器导入 Token')
    expect(html).not.toContain('从指纹浏览器导入（推荐）')
    expect(html).not.toContain('选择窗口…')
  })

  it('fingerprint import button disabled until a window is picked', () => {
    const noWindow = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({ onImportFromFingerprint: async () => {} })} />
    )
    expect(noWindow).toContain('请先在上方选择指纹浏览器窗口')
    // 未选窗口时按钮渲染为 disabled
    expect(noWindow).toMatch(/disabled=""[^>]*>导入中…|从指纹浏览器导入（推荐）</)
    const picked = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        automationSettings: { enabled: true, delaySec: 10, bitProfileId: 'bit-proxy' },
        onImportFromFingerprint: async () => {}
      })} />
    )
    expect(picked).toContain('打开选定的指纹浏览器窗口读取登录态 Token')
  })

  it('renders the open-login-page quick action beside the fingerprint import (fingerprint host)', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        automationSettings: { enabled: true, delaySec: 10, bitProfileId: 'bit-proxy' },
        onImportFromFingerprint: async () => {},
        onOpenFingerprintLogin: async () => {}
      })} />
    )
    expect(html).toContain('>打开网页登录</button>')
    expect(html).toContain('未登录可先登录')

    // 未选窗口 → 渲染但 disabled（与指纹导入按钮同语义，title 引导选择窗口）
    const noWindow = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({ onOpenFingerprintLogin: async () => {} })} />
    )
    expect(noWindow).toMatch(/disabled=""[^>]*title="请先在上方选择指纹浏览器窗口"[^>]*>打开网页登录</)

    // 自动化活跃阶段禁用：此时导航的正是自动化链在用的 tab（破坏就绪探测/轮换基准）
    const active = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        automationSettings: { enabled: true, delaySec: 10, bitProfileId: 'bit-proxy' },
        automationRun: runFor({ phase: 'processing', message: '奥仔自助处理中…', startedAt: 1 }),
        onOpenFingerprintLogin: async () => {}
      })} />
    )
    expect(active).toMatch(/disabled=""[^>]*>打开网页登录</)
  })

  it('hides the open-login-page action for the external browser host', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        automationSettings: { enabled: true, delaySec: 10, browserHost: 'external' },
        onOpenFingerprintLogin: async () => {}
      })} />
    )
    expect(html).not.toContain('>打开网页登录</button>')
  })

  it('shows the roxy api key input in step 1 when key missing (all platforms)', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        roxyApiKeyStatus: { saved: false },
        onSaveRoxyApiKey: async () => {}
      })} />
    )

    expect(html).toContain('placeholder="Roxy API Key"')
  })

  it('shows saved roxy key mask instead of the input', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        roxyApiKeyStatus: { saved: true, maskedKey: '6192****eada' },
        onSaveRoxyApiKey: async () => {}
      })} />
    )

    expect(html).toContain('6192****eada')
    expect(html).not.toContain('placeholder="Roxy API Key"')
  })

  it('shows the fingerprint browser fetch failure message inside the source card', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        bitProfilesMessage: 'RoxyBrowser Local API 不可达——请确认 RoxyBrowser 客户端已运行且 API 状态为 Enabled'
      })} />
    )

    expect(html).toContain('RoxyBrowser Local API 不可达')
    expect(html).toContain('role="alert"')
  })

  it('countdown step has no browser controls, only the follow note', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        automationSettings: { enabled: true, delaySec: 10, bitProfileId: 'bit-proxy' }
      })} />
    )

    expect(html).toContain('执行浏览器跟随「获取 Token」的来源')
    expect(html).toContain('指纹浏览器（Roxy）')
    // 倒计时步骤不再有浏览器路径/provider 选择
    expect(html).not.toContain('浏览器路径')
  })

  it('macos: external browser host remains selectable (fingerprint provider is Roxy on both platforms)', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        platform: 'darwin',
        roxyApiKeyStatus: { saved: true, maskedKey: '6192****eada' },
        onSaveRoxyApiKey: async () => {}
      })} />
    )

    // mac 上系统浏览器宿主（Keychain + Apple Events）仍可选；Roxy Key 掩码双平台展示
    expect(html).toMatch(/aria-selected="false"[^>]*>系统浏览器<\/button>/)
    expect(html).toContain('6192****eada')
  })

  it('hides the external browser segment on windows', () => {
    const html = renderToStaticMarkup(
      <LobbyAccountTile {...propsFor({
        platform: 'win32',
        automationSettings: { enabled: true, delaySec: 10, bitProfileId: 'bit-proxy' }
      })} />
    )

    // 系统浏览器宿主是 macOS 专属（Keychain + Apple Events），Windows 不提供
    expect(html).not.toContain('>系统浏览器</button>')
    expect(html).not.toContain('需在 Edge / Chrome 登录 cursor.com')
    expect(html).toContain('指纹浏览器（Roxy）')
  })
})
