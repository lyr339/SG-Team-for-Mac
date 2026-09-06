import { ipcMain, shell, type BrowserWindow } from 'electron'
import type { WorkspaceReviewReader } from '../infrastructure/git/workspace-review-reader'
import { WorkspaceReviewWatcher } from '../infrastructure/git/workspace-review-watcher'
import type {
  WorkspaceOpenFileResult,
  WorkspaceReviewAction,
  WorkspaceReviewActionInput,
  WorkspaceReviewScope
} from '../domain/workspace-review'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

function scopeOf(value: unknown): WorkspaceReviewScope | undefined {
  if (!value || typeof value !== 'object') return undefined
  const scope = (value as Record<string, unknown>).scope
  return scope === 'branch' ? 'branch' : scope === 'uncommitted' ? 'uncommitted' : undefined
}

function fileInputOf(value: unknown): { path: string; scope?: WorkspaceReviewScope } {
  if (!value || typeof value !== 'object') throw new Error('差异文件参数无效')
  const raw = value as Record<string, unknown>
  if (typeof raw.path !== 'string' || !raw.path.trim()) throw new Error('差异文件参数无效')
  return { path: raw.path, scope: scopeOf(value) }
}

const ACTIONS: ReadonlySet<WorkspaceReviewAction> = new Set(['stage', 'unstage', 'revert'])

function actionInputOf(value: unknown): WorkspaceReviewActionInput {
  if (!value || typeof value !== 'object') throw new Error('Git 操作参数无效')
  const raw = value as Record<string, unknown>
  if (typeof raw.path !== 'string' || !raw.path.trim()) throw new Error('Git 操作参数无效')
  if (typeof raw.action !== 'string' || !ACTIONS.has(raw.action as WorkspaceReviewAction)) throw new Error('Git 操作类型无效')
  const hunkHeader = typeof raw.hunkHeader === 'string' && raw.hunkHeader.startsWith('@@ ') ? raw.hunkHeader : undefined
  return { path: raw.path, action: raw.action as WorkspaceReviewAction, ...(hunkHeader ? { hunkHeader } : {}) }
}

function openInputOf(value: unknown): { path: string; line?: number } {
  const { path } = fileInputOf(value)
  const line = (value as Record<string, unknown>).line
  return { path, ...(typeof line === 'number' && Number.isInteger(line) && line > 0 ? { line } : {}) }
}

export interface WorkspaceReviewIpcOptions {
  /**
   * 文件系统监听：变更时向渲染层推送刷新信号（替代渲染层 2s 轮询）；缺省只剩轮询。
   * 监听器由本模块创建并随 IPC 一起释放。
   */
  watchWorkspace?: {
    workspacePath: () => string | undefined
    /** 活动工作区变化时重绑监听（团队快照订阅）。 */
    subscribeWorkspaceChange?: (listener: () => void) => () => void
    /** 测试注入：替代真实 WorkspaceReviewWatcher。 */
    createWatcher?: (onChange: () => void) => WorkspaceReviewWatcher
  }
  /** 编辑器深链 scheme（Cursor：cursor://file/<abs>:<line>）。 */
  editorScheme?: string
}

export function registerWorkspaceReviewIpc(
  reader: WorkspaceReviewReader,
  getWindow: () => BrowserWindow | undefined,
  options: WorkspaceReviewIpcOptions = {}
): () => void {
  const editorScheme = options.editorScheme ?? 'cursor'
  const notifyChanged = (): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.workspaceReviewChanged)
  }
  const watchOptions = options.watchWorkspace
  const watcher = watchOptions
    ? watchOptions.createWatcher?.(notifyChanged)
      ?? new WorkspaceReviewWatcher({ workspacePath: watchOptions.workspacePath, onChange: notifyChanged })
    : undefined
  const unsubscribeWorkspace = watcher && watchOptions?.subscribeWorkspaceChange
    ? watchOptions.subscribeWorkspaceChange(() => void watcher.refresh())
    : undefined
  watcher?.start()

  ipcMain.handle(IPC.workspaceReviewGet, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    const summary = await reader.summary({ scope: scopeOf(input) })
    return watcher ? { ...summary, liveUpdates: watcher.active } : summary
  })
  ipcMain.handle(IPC.workspaceReviewFile, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    return reader.fileDiff(fileInputOf(input))
  })
  ipcMain.handle(IPC.workspaceReviewApply, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    const result = await reader.apply(actionInputOf(input))
    // 监听器同样会收到变化，但显式动作后立即推一次，避免等 debounce。
    if (result.ok) notifyChanged()
    return result
  })
  ipcMain.handle(IPC.workspaceReviewReveal, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    const absolute = await reader.resolveWorkspaceFile(fileInputOf(input).path)
    shell.showItemInFolder(absolute)
    return true
  })
  ipcMain.handle(IPC.workspaceReviewOpen, async (event, input: unknown): Promise<WorkspaceOpenFileResult> => {
    assertTrustedSender(event, getWindow)
    const { path, line } = openInputOf(input)
    const absolute = await reader.resolveWorkspaceFile(path)
    // 编辑器深链（不依赖 CDP）：Cursor 注册了 cursor://file/<absolute>[:line[:column]]。
    // 未注册 scheme 时 openExternal 会 reject，退到系统默认程序。
    const target = `${editorScheme}://file${encodeURI(absolute)}${line ? `:${line}` : ''}`
    try {
      await shell.openExternal(target)
      return { ok: true, method: 'editor' }
    } catch (error) {
      const fallback = await shell.openPath(absolute)
      if (!fallback) return { ok: true, method: 'system' }
      return { ok: false, message: fallback || (error instanceof Error ? error.message : String(error)) }
    }
  })

  return () => {
    unsubscribeWorkspace?.()
    watcher?.stop()
    ipcMain.removeHandler(IPC.workspaceReviewGet)
    ipcMain.removeHandler(IPC.workspaceReviewFile)
    ipcMain.removeHandler(IPC.workspaceReviewApply)
    ipcMain.removeHandler(IPC.workspaceReviewReveal)
    ipcMain.removeHandler(IPC.workspaceReviewOpen)
  }
}
