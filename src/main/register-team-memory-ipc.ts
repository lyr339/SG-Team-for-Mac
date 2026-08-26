import { ipcMain, type BrowserWindow } from 'electron'
import type { TeamMemoryService } from '../application/team-memory-service'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

export function registerTeamMemoryIpc(
  service: TeamMemoryService,
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.teamMemoryGet, (event) => {
    assertTrustedSender(event, getWindow)
    return service.getSnapshot()
  })

  const unsubscribe = service.subscribe((snapshot) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.teamMemorySnapshot, snapshot)
    }
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.teamMemoryGet)
  }
}
