import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CursorUsageStore } from '../src/infrastructure/cursor/cursor-usage-store'

describe('CursorUsageStore', () => {
  it('原子保存并恢复按 composer 聚合的用量', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shiguang-usage-')), 'usage.json')
    const store = new CursorUsageStore(path)
    store.save('run-1', {
      'composer-1': {
        composerId: 'composer-1', turns: 2,
        inputTokens: 12_000, outputTokens: 300,
        cacheReadTokens: 8_000, cacheWriteTokens: 0,
        estimatedCostUsd: 0.123, pricedModel: 'Claude Sonnet', lastTurnAt: 2_000
      }
    })
    expect(store.load('run-1')['composer-1']).toMatchObject({ turns: 2, inputTokens: 12_000 })
    expect(store.load('run-2')).toEqual({})
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 2, runId: 'run-1' })
  })

  it('坏文件与非法行不进入运行快照', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shiguang-usage-')), 'usage.json')
    const store = new CursorUsageStore(path)
    writeFileSync(path, '{bad json')
    expect(store.load('run-1')).toEqual({})
    writeFileSync(path, JSON.stringify({ version: 2, runId: 'run-1', sessions: {
      broken: { turns: -1 },
      valid: {
        turns: 1, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
        estimatedCostUsd: 0.1, pricedModel: 'GPT', lastTurnAt: 5
      }
    }}))
    expect(store.load('run-1')).toEqual({ valid: expect.objectContaining({ composerId: 'valid', turns: 1 }) })
  })
})
