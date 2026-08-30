import { ipcMain, type BrowserWindow } from 'electron'
import type { AccountAutomationService } from '../application/account-automation-service'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

export interface BitProfilesResult {
  ok: boolean
  profiles?: Array<{ id: string; name: string; seq?: number }>
  message?: string
}

/** Roxy API Key 状态：已保存则只回显掩码，不回显明文。 */
export interface RoxyApiKeyStatus {
  saved: boolean
  maskedKey?: string
}

export interface AccountAutomationIpcDeps {
  /** 列出 RoxyBrowser（统一指纹提供方）的窗口。 */
  listWindows: () => Promise<Array<{ id: string; name: string; seq?: number }>>
  /** 读取 Roxy API Key（无则 undefined）。 */
  readRoxyApiKey: () => string | undefined
  /** 保存 Roxy API Key（持久化由实现负责）。 */
  saveRoxyApiKey: (key: string) => void
}

export function registerAccountAutomationIpc(
  service: AccountAutomationService,
  getWindow: () => BrowserWindow | undefined,
  deps: AccountAutomationIpcDeps
): () => void {
  const emitRun = (): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.accountAutomationProgress, service.getRun())
  }
  const unsubscribe = service.subscribe(() => emitRun())

  const roxyKeyStatus = (): RoxyApiKeyStatus => {
    const key = deps.readRoxyApiKey()
    if (!key) return { saved: false }
    return { saved: true, maskedKey: `${key.slice(0, 4)}****${key.slice(-4)}` }
  }

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
  ipcMain.handle(IPC.accountAutomationListBitProfiles, async (event): Promise<BitProfilesResult> => {
    assertTrustedSender(event, getWindow)
    try {
      const profiles = await deps.listWindows()
      return { ok: true, profiles: profiles.map((item) => ({ id: item.id, name: item.name, seq: item.seq })) }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, message: detail.replace(/\s+/g, ' ').slice(0, 160) }
    }
  })
  ipcMain.handle(IPC.accountAutomationGetRoxyApiKey, (event): RoxyApiKeyStatus => {
    assertTrustedSender(event, getWindow)
    return roxyKeyStatus()
  })
  ipcMain.handle(IPC.accountAutomationSaveRoxyApiKey, (event, key: unknown): RoxyApiKeyStatus => {
    assertTrustedSender(event, getWindow)
    const value = typeof key === 'string' ? key.trim() : ''
    if (value) deps.saveRoxyApiKey(value)
    return roxyKeyStatus()
  })
  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.accountAutomationGetSettings)
    ipcMain.removeHandler(IPC.accountAutomationSaveSettings)
    ipcMain.removeHandler(IPC.accountAutomationGetRun)
    ipcMain.removeHandler(IPC.accountAutomationCancel)
    ipcMain.removeHandler(IPC.accountAutomationListBitProfiles)
    ipcMain.removeHandler(IPC.accountAutomationGetRoxyApiKey)
    ipcMain.removeHandler(IPC.accountAutomationSaveRoxyApiKey)
  }
}
