import { ipcMain, type BrowserWindow } from 'electron'
import type { TeamCollaborationService } from '../application/team-collaboration-service'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

/** 协作只读投影：消息发送/回复/已读全部由 Agent 经 MCP 工具完成。 */
export function registerTeamCollaborationIpc(
  service: TeamCollaborationService,
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.teamCollaborationGet, (event) => {
    assertTrustedSender(event, getWindow)
    return service.getSnapshot()
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
  }
}
