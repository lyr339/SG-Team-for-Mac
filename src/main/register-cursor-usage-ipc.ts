import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/desktop-api'
import type { CursorUsageTracker } from '../application/cursor-usage-tracker'

/**
 * Cursor 用量快照 IPC：拉取（renderer 挂载初始化）+ 推送（聚合器节流变更）。
 * 快照本体是 composerId → 用量的纯数据映射，无凭据、无回执，无需防重放。
 */
export function registerCursorUsageIpc(
  tracker: CursorUsageTracker,
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.cursorUsageGet, () => tracker.getSnapshot())

  const unsubscribe = tracker.subscribe((snapshot) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.cursorUsageSnapshot, snapshot)
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.cursorUsageGet)
  }
}
