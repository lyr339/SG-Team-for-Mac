import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

/** 与渲染层 .desktop-shell 的 grid-template-rows（54px 顶栏）对齐。 */
export const WINDOW_TOPBAR_HEIGHT = 54

/** 覆盖层实色取自 claude-theme.css --color-background-primary 的 light-dark 值。 */
const CHROME_COLORS = {
  light: { color: '#ffffff', symbolColor: '#171b24' },
  dark: { color: '#181d25', symbolColor: '#f4f7fb' }
} as const

/**
 * Windows 标题栏覆盖层（titleBarOverlay）主题同步：
 * 覆盖层由系统原生绘制，读不到渲染层 CSS 主题，需渲染层显式推送。
 * macOS 无覆盖层（hiddenInset），调用静默生效。
 */
export function registerWindowChromeIpc(getWindow: () => BrowserWindow | undefined): () => void {
  const apply = (mode: unknown): void => {
    if (process.platform !== 'win32') return
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    const palette = mode === 'dark' ? CHROME_COLORS.dark : CHROME_COLORS.light
    window.setTitleBarOverlay({ ...palette, height: WINDOW_TOPBAR_HEIGHT })
  }
  ipcMain.handle(IPC.windowSetChromeColorMode, (event, mode: unknown) => {
    assertTrustedSender(event, getWindow)
    apply(mode)
    return true
  })
  return () => ipcMain.removeHandler(IPC.windowSetChromeColorMode)
}
