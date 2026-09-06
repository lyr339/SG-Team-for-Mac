import { clipboard, dialog, ipcMain, nativeImage, shell, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { RevealPathPolicy } from '../application/reveal-path-policy'
import type { SessionHandoffService } from '../application/session-handoff-service'
import { SESSION_HANDOFF_NOTE_MAX_CHARS, type SessionHandoffRequest } from '../domain/session-handoff'
import { IPC, type QueuedMessageRef } from '../shared/desktop-api'
import { parseImageInput, suggestedImageFileName } from './image-attachment-io'
import { assertTrustedSender } from './ipc-security'

function queuedRefOf(value: unknown): QueuedMessageRef {
  if (!value || typeof value !== 'object') throw new Error('队列消息参数无效')
  const raw = value as Record<string, unknown>
  if (typeof raw.channelId !== 'string' || !/^\d+$/.test(raw.channelId.trim())) throw new Error('通道号无效')
  if (typeof raw.entryId !== 'string' || !raw.entryId.startsWith('outbox:')) throw new Error('队列消息参数无效')
  return { channelId: raw.channelId.trim(), entryId: raw.entryId }
}

function channelInputOf(value: unknown): { channelId: string } {
  if (!value || typeof value !== 'object') throw new Error('通道参数无效')
  const raw = value as Record<string, unknown>
  if (typeof raw.channelId !== 'string' || !/^\d+$/.test(raw.channelId.trim())) throw new Error('通道号无效')
  return { channelId: raw.channelId.trim() }
}

function handoffRequestOf(value: unknown): SessionHandoffRequest {
  if (!value || typeof value !== 'object') throw new Error('交接参数无效')
  const raw = value as Record<string, unknown>
  if (typeof raw.sourceChannelId !== 'string' || !/^\d+$/.test(raw.sourceChannelId.trim())) throw new Error('来源通道无效')
  const target = raw.target as Record<string, unknown> | undefined
  if (!target || typeof target !== 'object') throw new Error('交接目标无效')
  let parsedTarget: SessionHandoffRequest['target']
  if (target.kind === 'self') {
    parsedTarget = { kind: 'self' }
  } else if (target.kind === 'channel' && typeof target.channelId === 'string' && /^\d+$/.test(target.channelId.trim())) {
    parsedTarget = { kind: 'channel', channelId: target.channelId.trim() }
  } else {
    throw new Error('交接目标无效')
  }
  const note = typeof raw.note === 'string' ? raw.note.slice(0, SESSION_HANDOFF_NOTE_MAX_CHARS) : undefined
  return { sourceChannelId: raw.sourceChannelId.trim(), target: parsedTarget, ...(note ? { note } : {}) }
}

function pathInputOf(value: unknown): { path: string } {
  if (!value || typeof value !== 'object') throw new Error('路径参数无效')
  const raw = value as Record<string, unknown>
  if (typeof raw.path !== 'string' || !raw.path.trim()) throw new Error('路径参数无效')
  return { path: raw.path }
}

/**
 * 会话队列、交接与附件 IPC：撤回/放行排队消息、定位上下文文档、投递交接消息、
 * 在文件管理器中显示拾光定位过的文件、复制/另存图片附件。
 */
export function registerSessionHandoffIpc(
  handoff: SessionHandoffService,
  queue: {
    withdrawQueuedMessage(channelId: string, entryId: string): boolean
    releaseQueuedMessage(channelId: string, entryId: string): boolean
  },
  reveal: RevealPathPolicy,
  getWindow: () => BrowserWindow | undefined,
  options: { downloadsPath?: () => string } = {}
): () => void {
  ipcMain.handle(IPC.withdrawQueuedMessage, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    const ref = queuedRefOf(input)
    return queue.withdrawQueuedMessage(ref.channelId, ref.entryId)
  })
  ipcMain.handle(IPC.releaseQueuedMessage, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    const ref = queuedRefOf(input)
    return queue.releaseQueuedMessage(ref.channelId, ref.entryId)
  })
  ipcMain.handle(IPC.sessionHandoffContext, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    return handoff.context(channelInputOf(input).channelId)
  })
  ipcMain.handle(IPC.sessionHandoffDeliver, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    return handoff.deliver(handoffRequestOf(input))
  })
  ipcMain.handle(IPC.revealPathInFolder, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    const { path } = pathInputOf(input)
    if (!reveal.allows(path)) return false
    shell.showItemInFolder(path)
    return true
  })
  ipcMain.handle(IPC.copyImageToClipboard, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    const { dataUrl, path, mimeType } = parseImageInput(input)
    // nativeImage 解码 PNG/JPEG；其他格式（gif/webp/svg）无法作为位图写入系统剪贴板。
    const image = path ? nativeImage.createFromPath(path) : nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) throw new Error(`当前格式（${mimeType}）无法复制为图片，请改用另存为`)
    clipboard.writeImage(image)
    return true
  })
  ipcMain.handle(IPC.saveImageAs, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    const { mimeType, bytes, path } = parseImageInput(input)
    const requestedName = (input as Record<string, unknown>).name
    const name = suggestedImageFileName(typeof requestedName === 'string' && requestedName ? requestedName : path ? basename(path) : undefined, mimeType)
    const window = getWindow()
    const dialogOptions = {
      title: '另存图片',
      defaultPath: options.downloadsPath ? join(options.downloadsPath(), name) : name,
      filters: [{ name: '图片', extensions: [extname(name).slice(1) || 'png'] }]
    }
    const result = window && !window.isDestroyed()
      ? await dialog.showSaveDialog(window, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return false
    writeFileSync(result.filePath, bytes)
    return true
  })
  return () => {
    ipcMain.removeHandler(IPC.withdrawQueuedMessage)
    ipcMain.removeHandler(IPC.releaseQueuedMessage)
    ipcMain.removeHandler(IPC.sessionHandoffContext)
    ipcMain.removeHandler(IPC.sessionHandoffDeliver)
    ipcMain.removeHandler(IPC.revealPathInFolder)
    ipcMain.removeHandler(IPC.copyImageToClipboard)
    ipcMain.removeHandler(IPC.saveImageAs)
  }
}
