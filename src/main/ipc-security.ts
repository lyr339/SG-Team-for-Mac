import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

export function assertTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | undefined
): void {
  const window = getWindow()
  const source = event.senderFrame?.url ?? ''
  const developmentUrl = process.env.ELECTRON_RENDERER_URL ?? ''
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error('拒绝未知窗口调用 IPC')
  }
  if (event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('拒绝子框架调用 IPC')
  }
  if (source === window.webContents.getURL() && source.startsWith('file://')) return
  if (developmentUrl && source === window.webContents.getURL() && source.startsWith(developmentUrl)) return
  throw new Error('拒绝非本应用页面调用 IPC')
}
