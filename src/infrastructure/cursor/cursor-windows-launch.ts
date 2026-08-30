import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

/** 解析 Windows Cursor 可执行文件：优先用户级安装路径，回退裸名（走 App Paths 注册表）。 */
export function resolveCursorWindowsExecutable(): string {
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    const installed = join(localAppData, 'Programs', 'Cursor', 'Cursor.exe')
    if (existsSync(installed)) return installed
  }
  return 'Cursor.exe'
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
export async function countWindowsCursorProcesses(
  execFileFn: (file: string, args: string[]) => Promise<{ stdout: string }>
): Promise<number> {
  try {
    const { stdout } = await execFileFn('tasklist', ['/NH', '/FI', 'IMAGENAME eq Cursor.exe'])
    return stdout.split(/\r?\n/).filter((line) => line.includes('Cursor.exe')).length
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 1) return 0
    throw error
  }
}
