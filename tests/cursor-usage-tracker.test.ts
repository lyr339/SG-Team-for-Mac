import { describe, expect, it, vi } from 'vitest'
import { CursorUsageTracker, cursorUsageRunDecision } from '../src/application/cursor-usage-tracker'
import type { CursorUsageEvent } from '../src/domain/cursor-usage'

function event(overrides: Partial<CursorUsageEvent> = {}): CursorUsageEvent {
  return {
    composerId: 'composer-1',
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    occurredAt: 1_000,
    ...overrides
  }
}

function buildTracker(models: Record<string, string> = {}) {
  return new CursorUsageTracker({
    resolveModelForComposer: (composerId) => models[composerId],
    notifyDelayMs: 10
  })
}

describe('CursorUsageTracker', () => {
  it('TeamRun 状态决定启动清零、运行采集与结束冻结', () => {
    expect(cursorUsageRunDecision(
      { runId: 'run-1', status: 'running' },
      { runId: 'run-1', status: 'completed' }
    )).toEqual({ reset: false, collecting: false })
    expect(cursorUsageRunDecision(
      { runId: 'run-1', status: 'completed' },
      { runId: 'run-2', status: 'draft' }
    )).toEqual({ reset: true, collecting: false })
    expect(cursorUsageRunDecision(
      { runId: 'run-2', status: 'ready' },
      { runId: 'run-2', status: 'launching' }
    )).toEqual({ reset: true, collecting: true })
    expect(cursorUsageRunDecision(
      { runId: 'run-2', status: 'launching' },
      { runId: 'run-2', status: 'running' }
    )).toEqual({ reset: false, collecting: true })
  })
  it('按 composer 聚合回合并随事件推送快照（节流）', async () => {
    vi.useFakeTimers()
    try {
      const tracker = buildTracker({ 'composer-1': 'claude-sonnet-4-5' })
      const snapshots: Array<Record<string, { turns: number }>> = []
      tracker.subscribe((snapshot) => snapshots.push(snapshot as Record<string, { turns: number }>))

      tracker.record(event())
      tracker.record(event({ inputTokens: 2_000, occurredAt: 2_000 }))
      // 密集回合合并为一次推送
      expect(snapshots).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(20)

      expect(snapshots).toHaveLength(1)
      const usage = snapshots[0]!['composer-1']!
      expect(usage.turns).toBe(2)
      expect(tracker.getSnapshot()['composer-1']?.inputTokens).toBe(3_000)
      tracker.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('模型未知时按默认价格档估算', () => {
    const tracker = buildTracker()
    tracker.record(event({ composerId: 'unknown-model', inputTokens: 1_000_000, outputTokens: 0 }))
    const usage = tracker.getSnapshot()['unknown-model']
    expect(usage?.pricedModel).toContain('默认')
    expect(usage?.estimatedCostUsd).toBeCloseTo(3, 6)
    tracker.dispose()
  })

  it('快照为副本：外部修改不污染内部状态', () => {
    const tracker = buildTracker({ 'composer-1': 'gpt-5' })
    tracker.record(event())
    const snapshot = tracker.getSnapshot()
    snapshot['composer-1']!.turns = 999
    expect(tracker.getSnapshot()['composer-1']?.turns).toBe(1)
    tracker.dispose()
  })

  it('恢复同一 TeamRun 的持久化累计，并按运行状态暂停或重置', () => {
    const persisted = vi.fn()
    const tracker = new CursorUsageTracker({
      initialSnapshot: {
        'composer-1': {
          composerId: 'composer-1', turns: 3,
          inputTokens: 3_000, outputTokens: 300, cacheReadTokens: 1_000, cacheWriteTokens: 0,
          estimatedCostUsd: 0.03, pricedModel: 'Claude Sonnet', lastTurnAt: 3_000
        }
      },
      persistSnapshot: persisted,
      notifyDelayMs: 10
    })
    tracker.setCollecting(false)
    tracker.record(event({ composerId: 'composer-2', inputTokens: 5_000 }))
    expect(tracker.getSnapshot()['composer-1']?.turns).toBe(3)
    expect(tracker.getSnapshot()['composer-2']).toBeUndefined()
    tracker.setCollecting(true)
    tracker.reset()
    expect(tracker.getSnapshot()).toEqual({})
    tracker.record(event({ composerId: 'composer-2', inputTokens: 5_000 }))
    expect(tracker.getSnapshot()['composer-2']).toMatchObject({ turns: 1, inputTokens: 5_000 })
    expect(persisted).toHaveBeenCalled()
    tracker.dispose()
  })

  it('dispose 后停止记录与推送', async () => {
    vi.useFakeTimers()
    try {
      const tracker = buildTracker()
      const snapshots: unknown[] = []
      tracker.subscribe((snapshot) => snapshots.push(snapshot))
      tracker.dispose()
      tracker.record(event())
      await vi.advanceTimersByTimeAsync(50)
      expect(snapshots).toHaveLength(0)
      expect(tracker.getSnapshot()).toEqual({})
    } finally {
      vi.useRealTimers()
    }
  })
})
