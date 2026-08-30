import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** S3-3 退役的桥接扩展 ID：启动时尽力卸载，失败静默（不阻塞主流程）。 */
const RETIRED_BRIDGE_EXTENSION_ID = 'qt.team-bridge'

function cursorCliCandidates(): string[] {
  // 平台分离：mac 的 CLI 是 shell 脚本；win 是安装目录下的 cursor.cmd
  const windowsCli = process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA}\\Programs\\Cursor\\resources\\app\\bin\\cursor.cmd`
    : ''
  return [
    process.env.QINGTIAN_CURSOR_CLI?.trim() ?? '',
    '/usr/local/bin/cursor',
    '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
    windowsCli
  ].filter(Boolean)
}

/**
 * 迁移清理（S3-3）：桥接扩展退役后，用户 Cursor 里可能仍装着旧版 vsix。
 * 尽力通过 Cursor CLI 卸载；CLI 不存在或扩展未安装时直接跳过。
 */
export async function uninstallRetiredBridgeExtension(
  log: (line: string) => void = () => undefined
): Promise<void> {
  const cursorCli = cursorCliCandidates().find((candidate) => existsSync(candidate))
  if (!cursorCli) return
  try {
    const { stdout } = await execFileAsync(cursorCli, ['--list-extensions'], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8'
    })
    const installed = stdout.split(/\r?\n/).map((line) => line.trim().toLowerCase())
    if (!installed.includes(RETIRED_BRIDGE_EXTENSION_ID)) return
    await execFileAsync(cursorCli, ['--uninstall-extension', RETIRED_BRIDGE_EXTENSION_ID], {
      timeout: 30_000,
      encoding: 'utf8'
    })
    log('[sg-team-legacy] retired bridge extension uninstalled')
  } catch (error) {
    log(`[sg-team-legacy] bridge extension uninstall skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
}
