import { ipcMain, type BrowserWindow } from 'electron'
import type { TaskPoolService } from '../application/task-pool-service'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

/** 任务池只读投影：桌面端是纯观察者，任务写操作全部由 Agent 经 MCP 工具完成。 */
export function registerTaskPoolIpc(
  service: TaskPoolService,
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.taskPoolGet, (event) => {
    assertTrustedSender(event, getWindow)
    return service.getSnapshot()
  })

  const unsubscribe = service.subscribe((snapshot) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.taskPoolSnapshot, snapshot)
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.taskPoolGet)
  }
}
