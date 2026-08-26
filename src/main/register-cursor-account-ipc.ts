import { ipcMain, type BrowserWindow } from 'electron'
import type { CursorAccountVault } from '../application/cursor-account-vault'
import { CursorTokenImporter } from '../infrastructure/cursor/cursor-token-importer'
import { CursorTokenInjector } from '../infrastructure/cursor/cursor-token-injector'
import { CursorBrowserTokenReader } from '../infrastructure/cursor/cursor-browser-token-reader'
import { CursorWebLogin } from '../infrastructure/cursor/cursor-web-login'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

function accountIdOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Cursor 账号 ID 无效')
  return value.trim()
}

export function registerCursorAccountIpc(
  vault: CursorAccountVault,
  getWindow: () => BrowserWindow | undefined
): () => void {
  const importer = new CursorTokenImporter()
  const injector = new CursorTokenInjector()
  const browserReader = new CursorBrowserTokenReader()
  const webLogin = new CursorWebLogin()

  ipcMain.handle(IPC.cursorAccountsList, (event) => {
    assertTrustedSender(event, getWindow)
    return vault.list()
  })
  ipcMain.handle(IPC.cursorAccountsSave, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!value || typeof value !== 'object') throw new Error('Cursor 账号参数无效')
    const input = value as Record<string, unknown>
    if (typeof input.label !== 'string' || typeof input.token !== 'string') throw new Error('Cursor 账号参数无效')
    return vault.save({
      label: input.label,
      token: input.token,
      makeActive: typeof input.makeActive === 'boolean' ? input.makeActive : undefined
    })
  })
  ipcMain.handle(IPC.cursorAccountsSelect, (event, accountId: unknown) => {
    assertTrustedSender(event, getWindow)
    return vault.select(accountIdOf(accountId))
  })
  ipcMain.handle(IPC.cursorAccountsRemove, (event, accountId: unknown) => {
    assertTrustedSender(event, getWindow)
    return vault.remove(accountIdOf(accountId))
  })
  ipcMain.handle(IPC.cursorAccountsImportFromLocal, (event) => {
    assertTrustedSender(event, getWindow)
    const imported = importer.import()
    const label = imported.email
      ? `${imported.email}（本机 Cursor）`
      : imported.sub
        ? `${imported.sub}（本机 Cursor）`
        : '本机 Cursor'
    return vault.save({ label, token: imported.token, makeActive: true })
  })
  ipcMain.handle(IPC.cursorAccountsWebLogin, async (event) => {
    assertTrustedSender(event, getWindow)
    const result = await webLogin.login(getWindow())
    return vault.save({
      label: `${result.userId}（网页登录）`,
      token: result.token,
      makeActive: true
    })
  })
  ipcMain.handle(IPC.cursorAccountsImportFromBrowser, (event) => {
    assertTrustedSender(event, getWindow)
    const result = browserReader.read()
    return vault.save({
      label: `${result.userId}（${result.browser}）`,
      token: result.token,
      makeActive: true
    })
  })
  ipcMain.handle(IPC.cursorAccountsInject, (event, accountId: unknown, options: unknown) => {
    assertTrustedSender(event, getWindow)
    const id = accountIdOf(accountId)
    const token = vault.credential(id)
    const account = vault.list().find((item) => item.id === id)
    // restart 默认 false：重启 Cursor 会断开全部群枢通道，仅 UI 确认后才放行
    const restart = typeof options === 'object' && options !== null
      && (options as Record<string, unknown>).restart === true
    return injector.inject({ token, email: account?.label, restart })
  })
  return () => {
    ipcMain.removeHandler(IPC.cursorAccountsList)
    ipcMain.removeHandler(IPC.cursorAccountsSave)
    ipcMain.removeHandler(IPC.cursorAccountsSelect)
    ipcMain.removeHandler(IPC.cursorAccountsRemove)
    ipcMain.removeHandler(IPC.cursorAccountsImportFromLocal)
    ipcMain.removeHandler(IPC.cursorAccountsWebLogin)
    ipcMain.removeHandler(IPC.cursorAccountsImportFromBrowser)
    ipcMain.removeHandler(IPC.cursorAccountsInject)
  }
}
