import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { promisify } from 'node:util'

/**
 * 一键重启 Cursor 并附加 --remote-debugging-port，使 CDP 会话创建可用。
 * 仅支持 macOS（与当前打包目标一致）。优雅退出优先，避免强杀丢失未保存状态。
 */

const execFileAsync = promisify(execFile)

const CURSOR_PROCESS_PATTERN = 'Cursor.app/Contents/MacOS/Cursor'
const QUIT_TIMEOUT_MS = 12_000
const PORT_READY_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500
const FETCH_TIMEOUT_MS = 2_000

/** 默认端口探测：带 AbortController 超时，端口无响应时快速失败而不是挂起。 */
async function defaultFetchWithTimeout(url: string): Promise<{ status: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return { status: response.status }
  } finally {
    clearTimeout(timer)
  }
}

export interface CursorCdpRestartResult {
  ok: boolean
  message: string
}

export interface CursorCdpRestartOptions {
  port: number
  workspacePath?: string
  execFileFn?: typeof execFileAsync
  fetchFn?: (url: string) => Promise<{ status: number }>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  platform?: NodeJS.Platform
}

async function cursorMainProcessCount(execFileFn: typeof execFileAsync): Promise<number> {
  try {
    const { stdout } = await execFileFn('pgrep', ['-f', CURSOR_PROCESS_PATTERN])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean).length
  } catch {
    // pgrep 无匹配时退出码为 1
    return 0
  }
}

export async function restartCursorWithCdp(options: CursorCdpRestartOptions): Promise<CursorCdpRestartResult> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    return { ok: false, message: '当前仅支持 macOS 自动重启 Cursor；请手动以 --remote-debugging-port 启动' }
  }
  const execFileFn = options.execFileFn ?? execFileAsync
  // 默认探测必须带超时：裸 fetch 在端口无响应时会挂起，拖延 PORT_READY_TIMEOUT_MS 的退出时机
  const fetchFn = options.fetchFn ?? defaultFetchWithTimeout
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const port = options.port
  const workspacePath = validWorkspacePath(options.workspacePath)
  if (options.workspacePath?.trim() && !workspacePath) {
    return { ok: false, message: `团队工作区路径不可用，已中止重启，避免打开错误 Cursor 窗口：${options.workspacePath.trim()}` }
  }

  try {
    if (await cursorMainProcessCount(execFileFn) > 0) {
      await execFileFn('osascript', ['-e', 'tell application "Cursor" to quit'])
      const quitDeadline = now() + QUIT_TIMEOUT_MS
      while (now() < quitDeadline && await cursorMainProcessCount(execFileFn) > 0) {
        await sleep(POLL_INTERVAL_MS)
      }
      if (await cursorMainProcessCount(execFileFn) > 0) {
        return { ok: false, message: 'Cursor 未能在限定时间内退出（可能有未保存的拦截弹窗），请手动关闭后重试' }
      }
    }

    const openArgs = workspacePath
      ? ['-a', 'Cursor', workspacePath, '--args', `--remote-debugging-port=${port}`]
      : ['-a', 'Cursor', '--args', `--remote-debugging-port=${port}`]
    await execFileFn('open', openArgs)

    const readyDeadline = now() + PORT_READY_TIMEOUT_MS
    while (now() < readyDeadline) {
      try {
        const response = await fetchFn(`http://127.0.0.1:${port}/json/version`)
        if (response.status >= 200 && response.status < 300) {
          return {
            ok: true,
            message: workspacePath
              ? `Cursor 已重启、打开团队工作区并启用会话创建端口（${port}）`
              : `Cursor 已重启并启用会话创建端口（${port}）`
          }
        }
      } catch {
        // 端口尚未就绪，继续等待
      }
      await sleep(POLL_INTERVAL_MS)
    }
    return { ok: false, message: `Cursor 已启动，但调试端口 ${port} 在限定时间内未就绪；请确认 Cursor 完全启动后重试` }
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim().slice(0, 200) : String(error)
    return { ok: false, message: `重启 Cursor 失败：${detail}` }
  }
}

function validWorkspacePath(input: string | undefined): string | undefined {
  const path = input?.trim()
  if (!path) return undefined
  try {
    return existsSync(path) && statSync(path).isDirectory() ? path : undefined
  } catch {
    return undefined
  }
}
