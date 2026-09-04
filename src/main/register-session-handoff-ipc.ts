import { ipcMain, shell, type BrowserWindow } from 'electron'
import type { SessionHandoffService } from '../application/session-handoff-service'
import { SESSION_HANDOFF_NOTE_MAX_CHARS, type SessionHandoffRequest } from '../domain/session-handoff'
import { IPC, type QueuedMessageRef } from '../shared/desktop-api'
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
 * 会话队列与交接 IPC：撤回/放行排队消息、定位上下文文档、投递交接消息、
 * 在文件管理器中显示拾光定位过的文件。
 */
export function registerSessionHandoffIpc(
  handoff: SessionHandoffService,
  queue: {
    withdrawQueuedMessage(channelId: string, entryId: string): boolean
    releaseQueuedMessage(channelId: string, entryId: string): boolean
  },
  getWindow: () => BrowserWindow | undefined
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
    if (!handoff.canReveal(path)) return false
    shell.showItemInFolder(path)
    return true
  })
  return () => {
    ipcMain.removeHandler(IPC.withdrawQueuedMessage)
    ipcMain.removeHandler(IPC.releaseQueuedMessage)
    ipcMain.removeHandler(IPC.sessionHandoffContext)
    ipcMain.removeHandler(IPC.sessionHandoffDeliver)
    ipcMain.removeHandler(IPC.revealPathInFolder)
  }
}
