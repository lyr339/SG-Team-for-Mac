// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, type AccountAutomationSettings } from '../src/domain/account-automation'
import { AccountBrowserPanel } from '../src/renderer/src/lobby/AccountBrowserPanel'

describe('AccountBrowserPanel', () => {
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

  it('renders the environment cleanup action with two-click confirmation and result feedback', async () => {
    const cleanupCalls: number[] = []
    function Harness(): React.JSX.Element {
      const [settings, setSettings] = useState<AccountAutomationSettings>({
        ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
        browserHost: 'fingerprint',
        bitProfileId: 'win-1'
      })
      return (
        <AccountBrowserPanel
          settings={settings}
          disabled={false}
          isWindows={false}
          providerLabel="Roxy"
          profiles={[
            { id: 'win-1', name: '代理窗口', seq: 4 },
            { id: 'win-2', name: '直连窗口', seq: 5 }
          ]}
          apiKeyStatus={{ saved: true, maskedKey: '6192****eada' }}
          onSettingsChange={setSettings}
          onCleanupEnvironment={async () => {
            cleanupCalls.push(1)
            if (cleanupCalls.length === 1) throw new Error('Roxy 本地缓存清理失败：window is open')
          }}
        />
      )
    }

    await act(async () => root.render(<Harness />))
    const button = () => container.querySelector<HTMLButtonElement>('.account-browser__cleanup-button')!

    // 首次点击：进入确认态（琥珀提示），不触发清理。
    expect(container.querySelector('.account-browser__cleanup')).toBeTruthy()
    expect(button().textContent).toContain('一键清理')
    await act(async () => button().click())
    expect(cleanupCalls).toHaveLength(0)
    expect(button().textContent).toContain('确认清理')
    expect(button().classList.contains('is-confirming')).toBe(true)

    // 二次点击：执行清理；失败信息就地反馈。
    await act(async () => button().click())
    expect(cleanupCalls).toHaveLength(1)
    expect(container.textContent).toContain('Roxy 本地缓存清理失败：window is open')

    // 切换 profile 解除确认态并清空反馈（选项经 portal 渲染到 document.body）。
    await act(async () => button().click())
    expect(button().textContent).toContain('确认清理')
    const windowSelect = container.querySelector('.menu-select__button') as HTMLButtonElement
    await act(async () => windowSelect.click())
    const option = Array.from(document.body.querySelectorAll('.menu-select__menu button'))
      .find((element) => element.textContent?.includes('#5')) as HTMLButtonElement
    await act(async () => option.click())
    expect(button().textContent).toContain('一键清理')
  })

  it('switches the whole-pipeline browser source and renders provider-specific configuration', async () => {
    function Harness(): React.JSX.Element {
      const [settings, setSettings] = useState<AccountAutomationSettings>({
        ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
        browserHost: 'fingerprint',
        bitProfileId: 'win-1'
      })
      return (
        <AccountBrowserPanel
          settings={settings}
          disabled={false}
          isWindows={false}
          providerLabel="Roxy"
          profiles={[{ id: 'win-1', name: '代理窗口', seq: 4 }]}
          apiKeyStatus={{ saved: true, maskedKey: '6192****eada' }}
          onSettingsChange={setSettings}
        />
      )
    }

    await act(async () => root.render(<Harness />))
    expect(container.textContent).toContain('会话浏览器')
    expect(container.textContent).toContain('贯穿全流程')
    expect(container.textContent).toContain('#4 代理窗口')
    expect(container.querySelectorAll('.account-browser__connection-row')).toHaveLength(1)
    expect(container.querySelector('.account-browser__key-row')).toBeNull()
    expect(container.querySelector('.account-browser__window-row')).toBeNull()
    const system = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent?.includes('系统浏览器'))!
    await act(async () => system.click())
    expect(system.getAttribute('aria-selected')).toBe('true')
    expect(container.textContent).toContain('使用现有登录会话')
    expect(container.textContent).toContain('Edge / Chrome')
  })
})
