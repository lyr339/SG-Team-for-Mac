import { BrowserWindow, session, type Cookie } from 'electron'
import { buildFullStealthScript } from './cursor-stealth'

export interface CursorWebLoginResult {
  /** `WorkosCursorSessionToken` Cookie 的值（`user_xxx::eyJ...` 格式）。 */
  token: string
  /** 从 token 前缀解析出的 Cursor 用户 ID（`user_xxx`）。 */
  userId: string
}

const SESSION_TOKEN_NAME = 'WorkosCursorSessionToken'
const CURSOR_DOMAIN = 'cursor.com'
const LOGIN_URL = 'https://authenticator.cursor.sh'

/**
 * 通过内嵌登录窗口完成 cursor.com 网页登录授权，并读取写入的
 * `WorkosCursorSessionToken` Cookie（`user_xxx::eyJ...` 格式）。
 *
 * 流程：
 *  1. 用独立的 Electron session 打开一个可见的登录窗口；
 *  2. 用户在其中正常登录（GitHub / Google / 邮箱等）；
 *  3. 登录成功后，`authenticator.cursor.sh` 会向 `cursor.com` 域写入
 *     `WorkosCursorSessionToken` Cookie；
 *  4. 从该 Cookie 读取值，解析出 userId 后返回。
 */
export class CursorWebLogin {
  async login(parent?: BrowserWindow): Promise<CursorWebLoginResult> {
    const partition = `cursor-web-login-${Date.now()}`
    const webSession = session.fromPartition(partition)

    const window = new BrowserWindow({
      width: 980,
      height: 760,
      minWidth: 800,
      minHeight: 600,
      show: false,
      autoHideMenuBar: true,
      title: 'Cursor 登录授权',
      backgroundColor: '#ffffff',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition
      }
    })
    if (parent) {
      window.setParentWindow(parent)
    }
    // Electron 默认会在 User-Agent 里带 `Electron/x.y.z`，Cloudflare Turnstile
    // 看到这个字符串就会判定为自动化浏览器并弹出人机验证。
    // 这里把 UA 改成与 macOS Chrome 完全一致的字符串，并把 navigator.webdriver
    // 隐藏为 false（Cloudflare 也会通过 `navigator.webdriver` 反自动化）。
    window.webContents.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    )
    // 完整 stealth 注入：覆盖 Cloudflare 全部已知检测点
    const injectStealth = async (): Promise<void> => {
      try {
        await window.webContents.executeJavaScript(buildFullStealthScript({ platform: 'macos' }), true)
      } catch {
        // ignore — older pages may have navigated away
      }
    }
    window.webContents.on('did-start-navigation', () => { void injectStealth() })
    window.webContents.on('dom-ready', () => { void injectStealth() })
    window.once('ready-to-show', () => window.show())

    try {
      // 清掉旧会话可能残留的该 Cookie，确保读到的是本次登录结果。
      await webSession.cookies.remove(`https://${CURSOR_DOMAIN}`, SESSION_TOKEN_NAME)

      const settled = new Promise<CursorWebLoginResult>((resolve, reject) => {
        let done = false
        const finish = (result: CursorWebLoginResult | Error): void => {
          if (done) return
          done = true
          if (result instanceof Error) reject(result)
          else resolve(result)
          window.destroy()
        }
        const timer = setTimeout(() => finish(new Error('登录超时，请重试')), 10 * 60 * 1000)

        const poll = async (): Promise<void> => {
          try {
            const cookie = await webSession.cookies
              .get({ name: SESSION_TOKEN_NAME, url: `https://${CURSOR_DOMAIN}` })
              .then((cookies: Cookie[]) => cookies[0])
            const value = cookie?.value
            if (value && value.includes('::')) {
              clearTimeout(timer)
              const userId = value.split('::')[0]
              if (userId) {
                finish({ token: value, userId })
                return
              }
            }
          } catch {
            // 继续轮询
          }
          setTimeout(() => void poll(), 800)
        }

        window.webContents.on('did-fail-load', (_event, code, description) => {
          if (code !== -3 && code !== -1) finish(new Error(`登录页面加载失败：${description}`))
        })
        window.on('closed', () => {
          clearTimeout(timer)
          finish(new Error('登录窗口已关闭'))
        })
        void poll()
      })

      await window.loadURL(LOGIN_URL)
      return await settled
    } finally {
      if (!window.isDestroyed()) window.destroy()
      try {
        await webSession.clearStorageData()
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
