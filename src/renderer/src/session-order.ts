/**
 * 会话卡片手动排序（localStorage 持久化，对齐 appearance-preferences 模式）。
 * 只作用于「全部」视图；过滤视图按语义分组，顺序对子集无意义。
 */

const STORAGE_KEY = 'shiguang.sessionOrder.v1'
const MAX_IDS = 100

/** 读取持久化顺序（坏数据静默忽略，与外观偏好同防御级别）。 */
export function readSessionOrder(storage?: Pick<Storage, 'getItem'>): string[] | undefined {
  try {
    const raw = (storage ?? window.localStorage).getItem(STORAGE_KEY)
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.length) return undefined
    const ids = parsed.filter((id): id is string => typeof id === 'string' && id.length <= 200)
    return ids.length ? [...new Set(ids)].slice(0, MAX_IDS) : undefined
  } catch {
    return undefined
  }
}

/** 稳定排序：手动顺序优先，未知会话（新席位）保持快照原序排在已知之后。 */
export function applySessionOrder<T>(
  sessions: readonly T[],
  order: string[] | undefined,
  idOf: (session: T) => string
): T[] {
  if (!order?.length) return [...sessions]
  const rank = new Map(order.map((id, index) => [id, index]))
  return [...sessions].sort((left, right) => {
    const leftRank = rank.get(idOf(left))
    const rightRank = rank.get(idOf(right))
    if (leftRank === undefined && rightRank === undefined) return 0
    if (leftRank === undefined) return 1
    if (rightRank === undefined) return -1
    return leftRank - rightRank
  })
}

/** 将指定会话移动到原列表的插入边界（N 个会话共有 N + 1 个边界）。 */
export function moveSessionToBoundary(
  ids: readonly string[],
  sessionId: string,
  insertionIndex: number
): string[] {
  const sourceIndex = ids.indexOf(sessionId)
  if (sourceIndex < 0) return [...ids]

  const boundary = Math.max(0, Math.min(insertionIndex, ids.length))
  const targetIndex = boundary > sourceIndex ? boundary - 1 : boundary
  if (targetIndex === sourceIndex) return [...ids]

  const next = [...ids]
  next.splice(sourceIndex, 1)
  next.splice(targetIndex, 0, sessionId)
  return next
}

/** 只重排当前状态组占据的全局槽位，其他组的相对顺序与位置保持不变。 */
export function moveSessionWithinGroup(
  ids: readonly string[],
  groupIds: readonly string[],
  sessionId: string,
  insertionIndex: number
): string[] {
  const reordered = moveSessionToBoundary(groupIds, sessionId, insertionIndex)
  if (reordered.every((id, index) => id === groupIds[index])) return [...ids]
  const groupSet = new Set(groupIds)
  let cursor = 0
  return ids.map((id) => groupSet.has(id) ? reordered[cursor++]! : id)
}

/** 顺序数组去重后写回（写入失败静默——排序只是偏好，不值得打扰用户）。 */
export function persistSessionOrder(ids: readonly string[], storage?: Pick<Storage, 'setItem'>): void {
  try {
    const unique = [...new Set(ids)].filter((id) => typeof id === 'string').slice(0, MAX_IDS)
    ;(storage ?? window.localStorage).setItem(STORAGE_KEY, JSON.stringify(unique))
  } catch {
    // 忽略：排序持久化失败不影响本轮会话内排序
  }
}
