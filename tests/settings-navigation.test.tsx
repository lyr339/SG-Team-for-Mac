// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../src/renderer/src/settings/SettingsPage'
import type { SettingsPageProps } from '../src/renderer/src/settings/settings-view'

let root: Root
let container: HTMLDivElement
const props: SettingsPageProps = {
  accounts: [{ id: 'a', label: 'test@example.com', active: true, maskedToken: '***', createdAt: 1, updatedAt: 1 }],
  busy: false, error: '', onSave: vi.fn(async () => {}), onSelect: vi.fn(async () => {}),
  onRemove: vi.fn(async () => {}), onRestartWithAccount: vi.fn(async () => {}),
  onImportFromLocal: vi.fn(async () => {}), onImportFromBrowser: vi.fn(async () => {})
}
const navigate = async (label: string) => act(async () => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.settings-nav button')].find(b => b.textContent === label)!
  button.click()
})
const visible = () => container.querySelector('.settings-groups > div:not([hidden])')!
const clickText = async (text: string) => act(async () => {
  const button = [...visible().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(text))!
  button.click()
})
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  history.replaceState(null, '', '#account')
  vi.clearAllMocks()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

describe('settings navigation', () => {
  it('keeps the manual import form mounted across groups without saving or invoking services', async () => {
    await act(async () => root.render(<SettingsPage {...props} />))
    await navigate('导入来源'); await clickText('手动粘贴')
    const input = visible().querySelector<HTMLInputElement>('input[placeholder="例如：工作账号 A"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '未保存的备注')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await navigate('账号'); await navigate('导入来源')
    expect(visible().querySelector('input[placeholder="例如：工作账号 A"]')).toBe(input)
    expect(input.value).toBe('未保存的备注')
    expect(props.onSave).not.toHaveBeenCalled()
    expect(props.onImportFromBrowser).not.toHaveBeenCalled()
  })
  it('clears destructive confirmation when leaving the accounts group', async () => {
    await act(async () => root.render(<SettingsPage {...props} />))
    await clickText('删除')
    expect(props.onRemove).not.toHaveBeenCalled()
    await navigate('Cursor 维护'); await navigate('账号')
    expect(visible().querySelector('.account-remove')?.textContent).toBe('删除')
    await clickText('删除'); await clickText('确认')
    expect(props.onRemove).toHaveBeenCalledExactlyOnceWith('a')
  })
  it('restores valid deep links, handles external hash changes, and falls back for invalid groups', async () => {
    history.replaceState(null, '', '#account:import')
    await act(async () => root.render(<SettingsPage {...props} />))
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('导入来源')
    await act(async () => { history.replaceState(null, '', '#account:maintenance'); window.dispatchEvent(new HashChangeEvent('hashchange')) })
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Cursor 维护')
    await act(async () => { history.replaceState(null, '', '#account:bad'); window.dispatchEvent(new HashChangeEvent('hashchange')) })
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('账号')
    expect(container.querySelectorAll('.settings-groups > div:not([hidden])')).toHaveLength(1)
  })
})
