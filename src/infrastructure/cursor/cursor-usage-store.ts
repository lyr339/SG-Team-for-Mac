import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { projectUsage, type CursorUsageLedger, type UsageTurn, type CursorSessionUsage, type CursorUsageSnapshot } from '../../domain/cursor-usage'

const STORE_VERSION = 3
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
  if (row.ledger && typeof row.ledger === 'object' && !Array.isArray(row.ledger)) {
    const raw = row.ledger as Record<string, unknown>
    if (!raw.turns || typeof raw.turns !== 'object' || Array.isArray(raw.turns)) return undefined
    const ledger: CursorUsageLedger = { turns: {} }
    const frozenAt = finiteNonNegative(raw.frozenAt)
    if (raw.frozenAt !== undefined && frozenAt === undefined) return undefined
    if (frozenAt !== undefined) ledger.frozenAt = frozenAt
    for (const [id, value] of Object.entries(raw.turns)) {
      if (!id || id.length > 200 || !value || typeof value !== 'object') return undefined
      const turn = value as UsageTurn
      const counts = [turn.inputTokens, turn.outputTokens, turn.cacheReadTokens, turn.cacheWriteTokens]
      if (counts.some((n) => !Number.isSafeInteger(n) || n < 0)
        || turn.cacheReadTokens + turn.cacheWriteTokens > turn.inputTokens
        || finiteNonNegative(turn.estimatedCostUsd) === undefined || finiteNonNegative(turn.at) === undefined
        || typeof turn.exact !== 'boolean' || !turn.price || typeof turn.price.label !== 'string'
        || [turn.price.inputPerM, turn.price.outputPerM, turn.price.cacheReadPerM, turn.price.cacheWritePerM].some((n) => finiteNonNegative(n) === undefined)
        || (turn.stopped !== undefined && typeof turn.stopped !== 'boolean')
        || (turn.estimateProfile !== undefined && !['claudeCode', 'fable', 'opus46', 'opus5', 'grok', 'default'].includes(turn.estimateProfile))
        || (turn.lastUsed !== undefined && (!Number.isSafeInteger(turn.lastUsed) || turn.lastUsed < 0))) return undefined
      Object.defineProperty(ledger.turns, id, { value: structuredClone(turn), enumerable: true, writable: true, configurable: true })
    }
    return projectUsage(composerId, ledger)
  }
  return {
    quality: 'legacy',
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
      if ((parsed.version !== STORE_VERSION && parsed.version !== 2) || storedRunId !== runId || !parsed.sessions || typeof parsed.sessions !== 'object') return {}
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
