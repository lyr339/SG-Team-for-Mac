/**
 * 渲染层 localStorage 键前缀迁移：品牌统一后布局/右栏偏好键从上一代前缀改为
 * `sg-team.`。启动时一次性把旧键搬到新键（新键已存在则以新键为准），随后删除旧键，
 * 保证用户保存的栏宽、右栏开合、标签页等偏好不因改名丢失。
 */
const LEGACY_PREFIX = 'qingtian-team.'
const CURRENT_PREFIX = 'sg-team.'

export function migrateLegacyStorageKeys(storage: Storage = localStorage): number {
  const legacyKeys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(LEGACY_PREFIX)) legacyKeys.push(key)
  }
  let migrated = 0
  for (const key of legacyKeys) {
    const next = `${CURRENT_PREFIX}${key.slice(LEGACY_PREFIX.length)}`
    const value = storage.getItem(key)
    if (value !== null && storage.getItem(next) === null) {
      storage.setItem(next, value)
      migrated += 1
    }
    storage.removeItem(key)
  }
  return migrated
}
