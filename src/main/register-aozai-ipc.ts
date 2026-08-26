import { ipcMain, type BrowserWindow } from 'electron'
import type { AozaiCardVault } from '../application/aozai-card-vault'
import type { AozaiService } from '../application/aozai-service'
import type { CursorAccountVault } from '../application/cursor-account-vault'
import type { AozaiCardStatus, AozaiProgressEvent } from '../domain/aozai-service'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

function cardCodeOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('卡密无效')
  return value.trim()
}

function processInputOf(value: unknown): { accountId: string; requestId: string } {
  if (!value || typeof value !== 'object') throw new Error('处理参数无效')
  const input = value as Record<string, unknown>
  if (typeof input.accountId !== 'string' || !input.accountId.trim() || input.accountId.length > 200) throw new Error('Cursor 账号 ID 无效')
  if (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 64) throw new Error('请求 ID 无效')
  return { accountId: input.accountId.trim(), requestId: input.requestId.trim() }
}

export function registerAozaiIpc(
  cardVault: AozaiCardVault,
  service: AozaiService,
  cursorAccounts: CursorAccountVault,
  getWindow: () => BrowserWindow | undefined
): () => void {
  const status = async (refresh: boolean): Promise<AozaiCardStatus> => {
    const maskedCode = cardVault.maskedCode()
    if (!maskedCode) return { saved: false }
    if (!refresh) return { saved: true, maskedCode }
    const info = await service.refreshBalance()
    return { saved: true, maskedCode, type: info.type, remaining: info.remaining }
  }

  ipcMain.handle(IPC.aozaiGetCardStatus, (event) => {
    assertTrustedSender(event, getWindow)
    return status(false)
  })
  ipcMain.handle(IPC.aozaiRefreshBalance, (event) => {
    assertTrustedSender(event, getWindow)
    return status(true)
  })
  ipcMain.handle(IPC.aozaiSaveCard, async (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    const cardCode = cardCodeOf(value)
    const info = await service.verifyCard(cardCode)
    const maskedCode = cardVault.save(cardCode)
    return { saved: true, maskedCode, type: info.type, remaining: info.remaining } satisfies AozaiCardStatus
  })
  ipcMain.handle(IPC.aozaiClearCard, (event) => {
    assertTrustedSender(event, getWindow)
    cardVault.clear()
    return { saved: false } satisfies AozaiCardStatus
  })
  ipcMain.handle(IPC.aozaiProcessAccount, async (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    const { accountId, requestId } = processInputOf(value)
    const token = cursorAccounts.credential(accountId)
    const emit = (state: AozaiProgressEvent['state'], message: string): void => {
      const window = getWindow()
      if (window && !window.isDestroyed()) {
        const payload: AozaiProgressEvent = { requestId, accountId, state, message }
        window.webContents.send(IPC.aozaiProgress, payload)
      }
    }
    return service.processToken(token, emit)
  })
  return () => {
    ipcMain.removeHandler(IPC.aozaiGetCardStatus)
    ipcMain.removeHandler(IPC.aozaiRefreshBalance)
    ipcMain.removeHandler(IPC.aozaiSaveCard)
    ipcMain.removeHandler(IPC.aozaiClearCard)
    ipcMain.removeHandler(IPC.aozaiProcessAccount)
  }
}
