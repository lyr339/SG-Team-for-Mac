import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cursorInstallRoots } from './cursor-install-paths'

/**
 * Windows 版 Cursor 进程操作共享辅助（账号切换器 cursor-account-switcher 与
 * CDP 重启 cursor-cdp-restart 共用——单一来源，两处行为必须一致）。
 *
 * 与 macOS 版彻底分离：mac 走 open/pkill/pgrep；win 走 cmd start/taskkill/tasklist。
 * 拉起一律通过 `cmd.exe /d /s /c start "" <exe> ...`——/s 保证带引号参数的解析稳定，
 * start 立即返回（cmd 不等待 GUI 进程），并免去逐参数转义坑。
 */

export interface WindowsCursorLaunchSpec {
  /** Cursor 可执行文件（已解析的绝对路径或裸名）。 */
  executable: string
  /** 拉起后打开的工作区（无效路径由调用方先行过滤）。 */
  workspacePath?: string
  /** 附带的 CDP 调试端口（undefined = 普通拉起）。 */
  cdpPort?: number
}

type ExecFileFn = (file: string, args: string[]) => Promise<{ stdout: string }>

/**
 * Cursor 的 Inno Setup 安装器有「仅当前用户」与「所有用户」两种位置；后者落在
 * Program Files 且不注册 App Paths，裸名 `Cursor.exe` 对 cmd start 不可见。
 */
export function cursorWindowsExecutableCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return cursorInstallRoots('win32', env).map((root) => join(root, 'Cursor.exe'))
}

/** powershell.exe 解析：PATH 优先；System32 缺失的异常会话回退绝对路径。 */
export function windowsPowerShellCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const systemRoot = env.SystemRoot?.trim() || 'C:\\Windows'
  return ['powershell.exe', join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
}

const RUNNING_CURSOR_PATH_ARGS = [
  '-NoProfile',
  '-Command',
  'Get-Process -Name Cursor -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path'
]

/**
 * 正在运行的 Cursor 主进程可执行路径——用户实际在用的那份安装，比任何候选目录都可靠。
 * 必须在终止 Cursor 之前采集；未运行 / 查询失败返回 undefined，调用方回退候选目录。
 */
export async function runningCursorWindowsExecutable(execFileFn: ExecFileFn): Promise<string | undefined> {
  for (const powershell of windowsPowerShellCandidates()) {
    try {
      const { stdout } = await execFileFn(powershell, RUNNING_CURSOR_PATH_ARGS)
      const path = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      return path && /\\Cursor\.exe$/i.test(path) ? path : undefined
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'ENOENT') return undefined
    }
  }
  return undefined
}

/**
 * 解析 Windows Cursor 可执行文件：运行中进程路径（刚从活进程读到，直接信任）→ 常见安装目录
 * → 裸名（App Paths / PATH）。裸名是最后手段：没有 App Paths 注册时 cmd start 会报「找不到 Cursor.exe」。
 */
export function resolveCursorWindowsExecutable(options: {
  runningPath?: string
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
} = {}): string {
  if (options.runningPath) return options.runningPath
  const exists = options.exists ?? existsSync
  return cursorWindowsExecutableCandidates(options.env).find((candidate) => exists(candidate)) ?? 'Cursor.exe'
}

/** 组装 cmd start 命令串（cmd.exe 的 args 形态；引号包裹空格路径）。 */
export function buildCursorWindowsStartArgs(spec: WindowsCursorLaunchSpec): string[] {
  const parts = [`start "" "${spec.executable}"`]
  if (spec.workspacePath) parts.push(`"${spec.workspacePath}"`)
  if (spec.cdpPort) {
    parts.push(`--remote-debugging-port=${spec.cdpPort}`)
    parts.push('--disable-features=LocalNetworkAccessChecks')
  }
  return ['/d', '/s', '/c', parts.join(' ')]
}

/**
 * 统计运行中的 Cursor 主进程数（含 Helper——与 mac 侧 pgrep -f 的匹配语义对齐：
 * 只要还有任一 Cursor 进程就视为「未退净」）。
 * 探测真实失败（超时/命令被策略禁用）时抛错：调用方（CDP 重启）必须 fail-closed，
 * 否则会误判「未运行」跳过退出流程，直接 start 出第二个 Cursor 实例。
 * 退出码 1 = 过滤器无匹配（部分 tasklist 版本语义，同 pgrep），按 0 处理。
 */
export async function countWindowsCursorProcesses(execFileFn: ExecFileFn): Promise<number> {
  try {
    const { stdout } = await execFileFn('tasklist', ['/NH', '/FI', 'IMAGENAME eq Cursor.exe'])
    return stdout.split(/\r?\n/).filter((line) => line.includes('Cursor.exe')).length
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 1) return 0
    throw error
  }
}
