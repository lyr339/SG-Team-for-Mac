import { ipcMain, type BrowserWindow } from 'electron'
import type { DesktopSessionBridge } from '../application/desktop-session-service'
import {
  IPC,
  type SendMessageInput
} from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

function attachmentOf(value: unknown): SendMessageInput['attachments'] {
  if (!Array.isArray(value)) return undefined
  const attachments = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    if (typeof raw.name !== 'string' || typeof raw.mimeType !== 'string') return []
    return [{
      id: typeof raw.id === 'string' ? raw.id : '',
      name: raw.name,
      mimeType: raw.mimeType,
      size: typeof raw.size === 'number' ? raw.size : 0,
      ...(typeof raw.data === 'string' ? { data: raw.data } : {}),
      ...(typeof raw.path === 'string' ? { path: raw.path } : {}),
      ...(typeof raw.previewUrl === 'string' ? { previewUrl: raw.previewUrl } : {})
    }]
  })
  return attachments.length ? attachments : undefined
}

function sendInputOf(value: unknown): SendMessageInput {
  if (!value || typeof value !== 'object') throw new Error('消息参数无效')
  const raw = value as Record<string, unknown>
  if (typeof raw.channelId !== 'string' || typeof raw.text !== 'string') {
    throw new Error('消息参数无效')
  }
  return {
    channelId: raw.channelId,
    text: raw.text,
    attachments: attachmentOf(raw.attachments),
    ...(raw.silent === true ? { silent: true } : {})
  }
}

/**
 * 拾光本地会话 IPC（一体化后无外置连接面）：
 * 快照读取/推送与消息发送直连 DesktopSessionService，
 * 内嵌通道经 SQLite 队列分流，其余通道无传输可走。
 */
export function registerSessionIpc(
  bridge: DesktopSessionBridge,
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.getSnapshot, (event) => {
    assertTrustedSender(event, getWindow)
    return bridge.getSnapshot()
  })
  ipcMain.handle(IPC.sendMessage, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    return bridge.sendMessage(sendInputOf(input))
  })
  const unsubscribe = bridge.subscribe((snapshot) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.snapshot, snapshot)
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.getSnapshot)
    ipcMain.removeHandler(IPC.sendMessage)
  }
}
