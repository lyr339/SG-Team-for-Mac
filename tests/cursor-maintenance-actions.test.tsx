// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ACCOUNT_AUTOMATION_SETTINGS } from '../src/domain/account-automation'
import { LobbyAccountTile, type LobbyAccountTileProps } from '../src/renderer/src/lobby/LobbyAccountTile'

describe('Cursor 本机维护操作', () => {
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

  function props(overrides: Partial<LobbyAccountTileProps> = {}): LobbyAccountTileProps {
    return {
      accounts: [],
      busy: false,
      error: '',
      onSave: async () => {},
      onSelect: async () => {},
      onRemove: async () => {},
      automationSettings: {
        ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
        browserHost: 'fingerprint',
        bitProfileId: 'roxy-1'
      },
      automationRun: { phase: 'idle', message: '', startedAt: 0 },
      cursorUpdatePreferences: {
        settingsPath: '/tmp/Cursor/User/settings.json',
        updateMode: undefined,
        autoUpdateDisabled: false,
        settingsExists: true
      },
      ...overrides
    }
  }

  it('两个配置操作都调用真实回调，政策确认完成后回显主进程结果', async () => {
    const setUpdate = vi.fn(async () => {})
    const setPolicy = vi.fn(async () => ({ message: '已确认 claude-fable-5 的数据政策' }))
    await act(async () => root.render(<LobbyAccountTile {...props({
      automationSettings: {
        ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
        browserHost: 'fingerprint',
        bitProfileId: 'roxy-1',
        autoAcknowledgeModelDataPolicies: false
      },
      onSetCursorAutoUpdateDisabled: setUpdate,
      onSetModelDataPolicyAutoAcknowledge: setPolicy
    })} />))

    const toggleByText = (text: string): HTMLInputElement => {
      const label = [...container.querySelectorAll<HTMLLabelElement>('label')]
        .find((candidate) => candidate.textContent?.includes(text))!
      return label.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    }
    const updateToggle = toggleByText('关闭 Cursor 自动更新')
    await act(async () => updateToggle.click())
    expect(setUpdate).toHaveBeenCalledWith(true)

    const policyToggle = toggleByText('自动确认受限模型数据政策')
    expect(policyToggle.disabled).toBe(false)
    await act(async () => policyToggle.click())
    expect(setPolicy).toHaveBeenCalledWith(true)
    expect(container.textContent).toContain('已确认 claude-fable-5 的数据政策')
  })

  it('未选择 Roxy 窗口时仍可关闭自动确认，并提示重新开启所需条件', async () => {
    const setPolicy = vi.fn(async () => ({ message: '已关闭' }))
    await act(async () => root.render(<LobbyAccountTile {...props({
      automationSettings: { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, browserHost: 'fingerprint' },
      onSetModelDataPolicyAutoAcknowledge: setPolicy
    })} />))
    const label = [...container.querySelectorAll<HTMLLabelElement>('label')]
      .find((candidate) => candidate.textContent?.includes('自动确认受限模型数据政策'))!
    const input = label.querySelector<HTMLInputElement>('input')!
    expect(input.disabled).toBe(false)
    expect(label.title).toContain('重新开启前请先选择 Roxy 窗口')
    await act(async () => input.click())
    expect(setPolicy).toHaveBeenCalledWith(false)
  })

  it('会员等级刷新期间旋转并阻止重复点击，完成后恢复', async () => {
    let resolveRefresh!: () => void
    const refresh = vi.fn(() => new Promise<void>((resolve) => { resolveRefresh = resolve }))
    await act(async () => root.render(<LobbyAccountTile {...props({
      accounts: [{ id: 'account:1', label: 'work@example.com', maskedToken: '••••9f2k', active: true, createdAt: 1, updatedAt: 1 }],
      membership: { state: 'ok', profile: { tier: 'free', raw: 'free', fetchedAt: 1 } },
      onRefreshMembership: refresh
    })} />))
    const button = container.querySelector<HTMLButtonElement>('.account-membership-refresh')!
    await act(async () => button.click())
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(button.className).toContain('is-refreshing')
    expect(button.disabled).toBe(true)
    await act(async () => resolveRefresh())
    expect(button.className).not.toContain('is-refreshing')
    expect(button.disabled).toBe(false)
  })
})
