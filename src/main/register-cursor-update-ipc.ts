import { ipcMain, type BrowserWindow } from 'electron'
import type { CursorUpdatePreferencesStore } from '../infrastructure/cursor/cursor-update-preferences'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

export function registerCursorUpdateIpc(
  store: CursorUpdatePreferencesStore,
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.cursorUpdateGetPreferences, (event) => {
    assertTrustedSender(event, getWindow)
    return store.load()
  })
  ipcMain.handle(IPC.cursorUpdateSetAutoUpdateDisabled, (event, disabled: unknown) => {
    assertTrustedSender(event, getWindow)
    return store.setAutoUpdateDisabled(disabled === true)
  })
  return () => {
    ipcMain.removeHandler(IPC.cursorUpdateGetPreferences)
    ipcMain.removeHandler(IPC.cursorUpdateSetAutoUpdateDisabled)
  }
}
