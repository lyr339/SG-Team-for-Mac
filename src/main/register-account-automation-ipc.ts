import { ipcMain, type BrowserWindow } from 'electron'
import type { AccountAutomationService } from '../application/account-automation-service'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

export function registerAccountAutomationIpc(
  service: AccountAutomationService,
  getWindow: () => BrowserWindow | undefined
): () => void {
  const emitRun = (): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.accountAutomationProgress, service.getRun())
  }
  const unsubscribe = service.subscribe(() => emitRun())

  ipcMain.handle(IPC.accountAutomationGetSettings, (event) => {
    assertTrustedSender(event, getWindow)
    return service.getSettings()
  })
  ipcMain.handle(IPC.accountAutomationSaveSettings, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    return service.saveSettings(value)
  })
  ipcMain.handle(IPC.accountAutomationGetRun, (event) => {
    assertTrustedSender(event, getWindow)
    return service.getRun()
  })
  ipcMain.handle(IPC.accountAutomationCancel, (event) => {
    assertTrustedSender(event, getWindow)
    return service.cancel()
  })
  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.accountAutomationGetSettings)
    ipcMain.removeHandler(IPC.accountAutomationSaveSettings)
    ipcMain.removeHandler(IPC.accountAutomationGetRun)
    ipcMain.removeHandler(IPC.accountAutomationCancel)
  }
}
