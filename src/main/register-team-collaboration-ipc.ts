import { ipcMain, type BrowserWindow } from 'electron'
import type { TeamCollaborationService } from '../application/team-collaboration-service'
import { IPC, type SendDesktopTeamMessageInput } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

const MESSAGE_KINDS = new Set(['directive', 'question', 'status', 'notice'])

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} 无效`)
  }
  return value.trim()
}

function sendInputOf(value: unknown): SendDesktopTeamMessageInput {
  if (!value || typeof value !== 'object') throw new Error('团队消息参数无效')
  const raw = value as Record<string, unknown>
  const kind = requiredString(raw.kind, '消息类型', 40)
  if (!MESSAGE_KINDS.has(kind)) throw new Error('消息类型无效')
  return {
    recipientSlotId: requiredString(raw.recipientSlotId, '目标 AgentSlot', 240),
    kind: kind as SendDesktopTeamMessageInput['kind'],
    subject: raw.subject === undefined ? undefined : requiredString(raw.subject, '消息主题', 160),
    content: requiredString(raw.content, '消息正文', 20_000)
  }
}

export function registerTeamCollaborationIpc(
  service: TeamCollaborationService,
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.teamCollaborationGet, (event) => {
    assertTrustedSender(event, getWindow)
    return service.getSnapshot()
  })
  ipcMain.handle(IPC.teamCollaborationSend, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    return service.send(sendInputOf(input))
  })
  ipcMain.handle(IPC.teamCollaborationReply, (event, messageId: unknown, content: unknown) => {
    assertTrustedSender(event, getWindow)
    return service.reply(
      requiredString(messageId, 'messageId', 240),
      requiredString(content, '回复正文', 20_000)
    )
  })
  ipcMain.handle(IPC.teamCollaborationRead, (event, messageId: unknown) => {
    assertTrustedSender(event, getWindow)
    return service.markRead(requiredString(messageId, 'messageId', 240))
  })

  const unsubscribe = service.subscribe((snapshot) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.teamCollaborationSnapshot, snapshot)
    }
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.teamCollaborationGet)
    ipcMain.removeHandler(IPC.teamCollaborationSend)
    ipcMain.removeHandler(IPC.teamCollaborationReply)
    ipcMain.removeHandler(IPC.teamCollaborationRead)
  }
}
