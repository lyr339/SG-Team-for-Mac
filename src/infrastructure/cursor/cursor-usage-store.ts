import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CursorSessionUsage, CursorUsageSnapshot } from '../../domain/cursor-usage'

const STORE_VERSION = 2
const MAX_SESSIONS = 1_000

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function sessionUsage(value: unknown, composerId: string): CursorSessionUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const turns = finiteNonNegative(row.turns)
  const inputTokens = finiteNonNegative(row.inputTokens)
  const outputTokens = finiteNonNegative(row.outputTokens)
  const cacheReadTokens = finiteNonNegative(row.cacheReadTokens)
  const cacheWriteTokens = finiteNonNegative(row.cacheWriteTokens)
  const estimatedCostUsd = finiteNonNegative(row.estimatedCostUsd)
  const lastTurnAt = finiteNonNegative(row.lastTurnAt)
  // 请求级采样基线：缺失（事件通道会话/旧版本快照）= undefined，存在则随快照恢复
  const contextLastUsed = finiteNonNegative(row.contextLastUsed)
  if (
    turns === undefined || inputTokens === undefined || outputTokens === undefined
    || cacheReadTokens === undefined || cacheWriteTokens === undefined
    || estimatedCostUsd === undefined || lastTurnAt === undefined
    || typeof row.pricedModel !== 'string'
  ) return undefined
  return {
    composerId,
    turns: Math.floor(turns),
    inputTokens: Math.floor(inputTokens),
    outputTokens: Math.floor(outputTokens),
    cacheReadTokens: Math.floor(cacheReadTokens),
    cacheWriteTokens: Math.floor(cacheWriteTokens),
    estimatedCostUsd,
    pricedModel: row.pricedModel.slice(0, 120),
    lastTurnAt: Math.floor(lastTurnAt),
    ...(contextLastUsed !== undefined ? { contextLastUsed: Math.floor(contextLastUsed) } : {})
  }
}

/** Cursor 用量的本地持久化；只保存计数与费用估算，不含正文或凭据。 */
export class CursorUsageStore {
  constructor(readonly path: string) {}

  load(runId?: string): CursorUsageSnapshot {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as {
        version?: unknown
        runId?: unknown
        sessions?: unknown
      }
      const storedRunId = typeof parsed.runId === 'string' ? parsed.runId : undefined
      if (parsed.version !== STORE_VERSION || storedRunId !== runId || !parsed.sessions || typeof parsed.sessions !== 'object') return {}
      const rows = Object.entries(parsed.sessions as Record<string, unknown>)
        .flatMap(([composerId, value]) => {
          const normalizedId = composerId.trim().slice(0, 200)
          const usage = normalizedId ? sessionUsage(value, normalizedId) : undefined
          return usage ? [[normalizedId, usage] as const] : []
        })
        .sort((left, right) => right[1].lastTurnAt - left[1].lastTurnAt)
        .slice(0, MAX_SESSIONS)
      return Object.fromEntries(rows)
    } catch {
      return {}
    }
  }

  save(runId: string | undefined, snapshot: CursorUsageSnapshot): void {
    const sessions = Object.fromEntries(Object.entries(snapshot)
      .sort((left, right) => right[1].lastTurnAt - left[1].lastTurnAt)
      .slice(0, MAX_SESSIONS))
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: STORE_VERSION, runId, sessions }), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
