import { ipcMain, type BrowserWindow } from 'electron'
import type { CursorCdpKeeper } from '../infrastructure/cursor/cursor-cdp-keeper'
import type { CursorCdpSettingsStore } from '../application/cursor-cdp-settings-store'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

/**
 * CDP auto-heal 的 IPC 面：设置读写 + 倒计时取消 + 事件推送。
 * 事件推送由 keeper.emit 在装配处桥接（webContents.send）。
 */
export function registerCdpKeeperIpc(
  keeper: CursorCdpKeeper,
  store: CursorCdpSettingsStore,
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.cursorCdpGetSettings, (event) => {
    assertTrustedSender(event, getWindow)
    return store.load()
  })
  ipcMain.handle(IPC.cursorCdpSaveSettings, (event, settings: unknown) => {
    assertTrustedSender(event, getWindow)
    return store.save(settings)
  })
  ipcMain.handle(IPC.cursorCdpCancelCountdown, (event) => {
    assertTrustedSender(event, getWindow)
    keeper.cancelCountdown()
  })
  return () => {
    ipcMain.removeHandler(IPC.cursorCdpGetSettings)
    ipcMain.removeHandler(IPC.cursorCdpSaveSettings)
    ipcMain.removeHandler(IPC.cursorCdpCancelCountdown)
  }
}
