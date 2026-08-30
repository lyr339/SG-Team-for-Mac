/**
 * SQLite 仓库共享的行类型与数值容错转换。
 * node:sqlite 返回 bigint/number 混合类型；各仓库逐份复制这两段，
 * 2026-08 收敛为唯一出口。
 */
export type SqliteRow = Record<string, string | number | bigint | null>

/** bigint→number 容错转换：非有限数值一律归 0（schema 保证列为数值时安全）。 */
export function numberOf(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}
