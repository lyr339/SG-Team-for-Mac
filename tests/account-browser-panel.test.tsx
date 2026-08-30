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
