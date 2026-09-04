import { ipcMain, type BrowserWindow } from 'electron'
import type { WorkspaceReviewReader } from '../infrastructure/git/workspace-review-reader'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

function fileInputOf(value: unknown): { path: string } {
  if (!value || typeof value !== 'object') throw new Error('差异文件参数无效')
  const raw = value as Record<string, unknown>
  if (typeof raw.path !== 'string' || !raw.path.trim()) throw new Error('差异文件参数无效')
  return { path: raw.path }
}

export function registerWorkspaceReviewIpc(
  reader: WorkspaceReviewReader,
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.workspaceReviewGet, (event) => {
    assertTrustedSender(event, getWindow)
    return reader.summary()
  })
  ipcMain.handle(IPC.workspaceReviewFile, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    return reader.fileDiff(fileInputOf(input))
  })
  return () => {
    ipcMain.removeHandler(IPC.workspaceReviewGet)
    ipcMain.removeHandler(IPC.workspaceReviewFile)
  }
}
