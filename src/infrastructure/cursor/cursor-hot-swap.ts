import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface HotSwapResult {
  ok: boolean
  message: string
  /** 是否通过 CDP 成功注入。 */
  cdpInjected: boolean
  /** 是否成功触发 Cursor 内部刷新。 */
  refreshTriggered: boolean
}

/**
 * Cursor 账号热切换（无需重启）。
 *
 * 原理：Cursor 基于 Electron，其登录态同时存在于：
 * 1. state.vscdb（持久化）
 * 2. 渲染进程内存（运行时）
 *
 * 热切换 = 写入 state.vscdb + 通过 CDP 刷新运行时状态。
 *
 * 注意：Cursor 的 CDP 端口需要用户提前开启（--remote-debugging-port），
 * 或依赖 CDP keeper 自动重启开启。
 */
export class CursorHotSwap {
  private readonly cdpPort: number

  constructor(options: { cdpPort?: number } = {}) {
    this.cdpPort = options.cdpPort ?? 9222
  }

  /**
   * 执行热切换。
   *
   * 步骤：
   * 1. 写入 state.vscdb（通过 CursorTokenInjector）
   * 2. 尝试连接 Cursor 的 CDP 端口
   * 3. 注入脚本刷新认证状态
   * 4. 如果 CDP 不可用，回退到文件监听方案
   */
  async swap(input: { token: string; email?: string }): Promise<HotSwapResult> {
    // 步骤 1：写入 state.vscdb（由调用方完成，这里假设已写入）
    // 步骤 2：尝试 CDP 注入
    const cdpResult = await this.tryCdpInject(input)
    if (cdpResult.ok) {
      return {
        ok: true,
        message: '热切换成功：已通过 CDP 刷新 Cursor 运行时状态',
        cdpInjected: true,
        refreshTriggered: true
      }
    }

    // 步骤 3：CDP 不可用，尝试文件监听方案
    const watchResult = await this.tryFileWatchTrigger(input)
    if (watchResult.ok) {
      return {
        ok: true,
        message: '热切换成功：已触发 Cursor 配置文件重载',
        cdpInjected: false,
        refreshTriggered: true
      }
    }

    return {
      ok: false,
      message: '热切换失败：CDP 端口不可用且无法触发配置重载。请手动重启 Cursor。',
      cdpInjected: false,
      refreshTriggered: false
    }
  }

  /**
   * 尝试通过 CDP 注入新 token。
   *
   * Cursor 的认证状态存储在渲染进程的：
   * - localStorage（键：cursorAuth/accessToken）
   * - 内存中的 AuthService（需要触发重新初始化）
   */
  private async tryCdpInject(input: { token: string; email?: string }): Promise<{ ok: boolean }> {
    try {
      // 检查 CDP 端口是否可用
      const versionCheck = await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`, {
        signal: AbortSignal.timeout(2_000)
      })
      if (!versionCheck.ok) return { ok: false }

      // 获取所有可调试的页面
      const targets = await fetch(`http://127.0.0.1:${this.cdpPort}/json`, {
        signal: AbortSignal.timeout(2_000)
      }).then((res) => res.json())

      // 找到 Cursor 的主窗口（通常是第一个 page 类型）
      const cursorPage = targets.find((target: { type: string; url: string }) =>
        target.type === 'page' && target.url.includes('cursor.com')
      ) ?? targets.find((target: { type: string }) => target.type === 'page')

      if (!cursorPage) return { ok: false }

      // 连接到页面
      const wsUrl = cursorPage.webSocketDebuggerUrl
      if (!wsUrl) return { ok: false }

      // 使用 WebSocket 发送 CDP 命令
      const ws = new WebSocket(wsUrl)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
        setTimeout(() => reject(new Error('CDP 连接超时')), 5_000)
      })

      try {
        // 注入脚本：更新 localStorage 并触发刷新
        const script = `
          (() => {
            try {
              // 更新 localStorage
              localStorage.setItem('cursorAuth/accessToken', ${JSON.stringify(input.token)});
              ${input.email ? `localStorage.setItem('cursorAuth/cachedEmail', ${JSON.stringify(input.email)});` : ''}

              // 触发存储事件（通知其他标签页）
              window.dispatchEvent(new StorageEvent('storage', {
                key: 'cursorAuth/accessToken',
                newValue: ${JSON.stringify(input.token)},
                oldValue: null,
                storageArea: localStorage
              }));

              // 尝试触发 Cursor 内部认证刷新（如果存在）
              if (window.cursorAuthRefresh) {
                window.cursorAuthRefresh();
              }

              // 强制刷新当前页面（保守方案）
              setTimeout(() => location.reload(), 100);

              return { ok: true };
            } catch (error) {
              return { ok: false, error: String(error) };
            }
          })()
        `

        const result = await this.sendCdpCommand(ws, 'Runtime.evaluate', {
          expression: script,
          returnByValue: true
        }) as { ok?: boolean } | undefined

        return { ok: result?.ok === true }
      } finally {
        ws.close()
      }
    } catch {
      return { ok: false }
    }
  }

  /**
   * 尝试通过文件监听触发 Cursor 重载。
   *
   * 原理：Cursor 可能会监听 state.vscdb 的变化（通过 fs.watch 或类似机制）。
   * 我们写入后，Cursor 应该能检测到变化并重新加载。
   */
  private async tryFileWatchTrigger(input: { token: string; email?: string }): Promise<{ ok: boolean }> {
    // 这个方案依赖于 Cursor 是否实现了文件监听
    // 目前无法确定，先返回失败，让上层回退到重启方案
    return { ok: false }
  }

  /**
   * 发送 CDP 命令。
   */
  private sendCdpCommand(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1_000_000)
      const message = JSON.stringify({ id, method, params })

      const handler = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data)
          if (data.id === id) {
            ws.removeEventListener('message', handler)
            resolve(data.result)
          }
        } catch {
          // ignore parse errors
        }
      }

      ws.addEventListener('message', handler)
      ws.send(message)
      setTimeout(() => {
        ws.removeEventListener('message', handler)
        reject(new Error('CDP 命令超时'))
      }, 5_000)
    })
  }

  /**
   * 检查 Cursor 是否开启了 CDP 调试端口。
   */
  async isCdpAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`, {
        signal: AbortSignal.timeout(1_000)
      })
      return response.ok
    } catch {
      return false
    }
  }
}
