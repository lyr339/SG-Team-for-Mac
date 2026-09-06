import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** 当前品牌的数据目录名（打包 / 开发各一份，互不串数据）。 */
export const USER_DATA_DIRECTORY_NAME = 'sg-team'
const LEGACY_USER_DATA_DIRECTORY_NAME = 'qingtian-team'

interface UserDataFs {
  existsSync(path: string): boolean
  renameSync(from: string, to: string): void
}

/**
 * 解析 Electron userData 目录，并把上一代品牌的数据目录原地改名迁移过来：
 * SQLite 任务库、账号保险库、交接记录、渲染层 localStorage 全部随目录一起搬迁。
 *
 * - 改名是同卷原子操作，不复制、不会出现半迁移状态；
 * - 新目录已存在时不动旧目录（不覆盖任何现有数据）；
 * - 改名失败（权限、被占用）时退回继续使用旧目录——绝不让用户"看起来丢了数据"。
 */
export function resolveUserDataDirectory(
  appDataRoot: string,
  packaged: boolean,
  fs: UserDataFs = { existsSync, renameSync },
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`)
): string {
  const suffix = packaged ? '' : '-dev'
  const current = join(appDataRoot, `${USER_DATA_DIRECTORY_NAME}${suffix}`)
  const legacy = join(appDataRoot, `${LEGACY_USER_DATA_DIRECTORY_NAME}${suffix}`)
  if (fs.existsSync(current) || !fs.existsSync(legacy)) return current
  try {
    fs.renameSync(legacy, current)
    return current
  } catch (error) {
    warn(`[sg-team] 数据目录迁移失败，继续使用旧目录 ${legacy}：${String(error)}`)
    return legacy
  }
}
