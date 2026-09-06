import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { CURSOR_STREAM_HOOK_EXPRESSION } from '../src/infrastructure/cursor/cursor-stream-observer'
import { nativeUsagePayload } from '../src/infrastructure/cursor/cursor-native-usage'
import { CursorUsageTracker } from '../src/application/cursor-usage-tracker'
import { CursorUsageStore } from '../src/infrastructure/cursor/cursor-usage-store'
import { patchUsageSource } from '../scripts/patch-cursor-usage-hook'

describe('用量采集到持久化的事件链', () => {
  it('真实 hook 表达式：上下文变化→同 generation 四桶结算→持久化恢复不重算', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sg-usage-pipeline-'))
    const store = new CursorUsageStore(join(root, 'usage.json'))
    const tracker = new CursorUsageTracker({ persistSnapshot: (state) => store.save('run', state) })
    const data = { composerId: 'c', chatGenerationUUID: 'g', status: 'generating', contextTokensUsed: 10000,
      modelConfig: { modelName: 'claude-fable-5-1' }, fullConversationHeadersOnly: [], conversationMap: {},
      turnTokenUsage: undefined as undefined | { inputTokens: bigint; outputTokens: bigint; cacheReadTokens: bigint; cacheWriteTokens: bigint } }
    class Manager { markDirty(_input: unknown): void {} }
    const manager = new Manager()
    const payloads: Array<Record<string, any>> = []
    const consume = (payload: string): void => {
      const p = JSON.parse(payload)
      payloads.push(p)
      if (p.kind === 'sample') tracker.recordRequestSample({ composerId: p.c, generationId: p.g, modelId: p.m, used: p.used, stopped: p.stopped, occurredAt: p.t })
      else tracker.record({ composerId: p.c, generationId: p.g, modelId: p.m, inputTokens: p.i, outputTokens: p.o, cacheReadTokens: p.r, cacheWriteTokens: p.w, occurredAt: p.t })
    }
    let at = 1
    const globals = { __qtComposerService: { composerDataService: { composerDataHandleManager: manager, getComposerDataIfLoaded: () => data } }, __sgTeamUsage: consume, sgTeamStream: () => {} }
    try {
      runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, { globalThis: globals, queueMicrotask, setTimeout, Promise, Date: { now: () => ++at } })
      manager.markDirty({ composerId: 'c' }); await Promise.resolve()
      expect(tracker.getSnapshot().c?.inputTokens).toBe(10000)
      data.contextTokensUsed = 11000
      manager.markDirty({ composerId: 'c' }); await Promise.resolve()
      expect(tracker.getSnapshot().c?.inputTokens).toBe(21000)
      data.status = 'aborted'
      data.contextTokensUsed = 11500
      data.turnTokenUsage = { inputTokens: 0n, outputTokens: 0n, cacheReadTokens: 0n, cacheWriteTokens: 0n }
      manager.markDirty({ composerId: 'c' }); await Promise.resolve()
      // 中断帧穿过真实 hook 立即落盘，零值伪结算不会抹掉消费。
      const interrupted = store.load('run')
      expect(interrupted.c?.inputTokens).toBe(32500)
      expect(interrupted.c!.outputTokens).toBeGreaterThan(0)
      expect(interrupted.c?.ledger?.turns.g?.stopped).toBe(true)
      expect(interrupted.c?.ledger?.turns.g?.estimateProfile).toBe('claudeCode')
      const retry = new CursorUsageTracker({ initialSnapshot: interrupted })
      retry.recordRequestSample({ composerId: 'c', generationId: 'g', used: 11500, stopped: true, occurredAt: 9999 })
      expect(retry.getSnapshot()).toEqual(interrupted)
      retry.dispose()
      // 捕获过的真实 turnEnded 四桶数值；它与上面的估算不同，必须原子校准。
      data.turnTokenUsage = { inputTokens: 12168n, outputTokens: 42n, cacheReadTokens: 3968n, cacheWriteTokens: 0n }
      data.status = 'completed'
      manager.markDirty({ composerId: 'c' }); await Promise.resolve()
      tracker.dispose()
      const saved = store.load('run')
      expect(saved.c).toMatchObject({ inputTokens: 12168, outputTokens: 42, cacheReadTokens: 3968, cacheWriteTokens: 0, quality: 'exact' })
      const restored = new CursorUsageTracker({ initialSnapshot: saved })
      const p = payloads.at(-1)!
      restored.record({ composerId: p.c, generationId: p.g, inputTokens: p.i, outputTokens: p.o, cacheReadTokens: p.r, cacheWriteTokens: p.w, occurredAt: 999 })
      expect(restored.getSnapshot()).toEqual(saved)
      restored.setCollecting(false)
      store.save('run', restored.getSnapshot())
      expect(store.load('run').c?.ledger?.frozenAt).toBeDefined()
      expect(store.load('next-run')).toEqual({})
      restored.dispose()
      expect(JSON.parse(readFileSync(store.path, 'utf8')).version).toBe(3)
    } finally { tracker.dispose(); rmSync(root, { recursive: true, force: true }) }
  })

  it('Auto 原生上下文 fallback、中断后补收最终上下文、未知身份不虚构用量', () => {
    expect(nativeUsagePayload({ chatGenerationUUID: 'g', status: 'generating', conversationState: { tokenDetails: { usedTokens: 500 } } }, 'c')).toMatchObject({ used: 500, g: 'g', kind: 'sample' })
    expect(nativeUsagePayload({ latestChatGenerationUUID: 'g', status: 'aborted', contextTokensUsed: 500 }, 'c')).toMatchObject({ kind: 'sample', stopped: true, used: 500, g: 'g' })
    expect(nativeUsagePayload({ latestChatGenerationUUID: 'g', status: 'completed', contextTokensUsed: 501 }, 'c')).toMatchObject({ stopped: true, used: 501 })
    expect(nativeUsagePayload({ latestChatGenerationUUID: 'g', status: 'aborted', contextTokensUsed: 502,
      turnTokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    }, 'c')).toMatchObject({ kind: 'sample', stopped: true, used: 502 })
    expect(nativeUsagePayload({ status: 'generating', contextTokensUsed: 500 }, 'c')).toBeUndefined()
  })

  it('补丁纯函数双锚点、V3 幂等、旧版升级仅移除自有片段', () => {
    const local = '(d.inputTokens!==void 0||d.outputTokens!==void 0||d.cacheReadTokens!==void 0||d.cacheWriteTokens!==void 0)&&o.updateComposerDataSetStore(this.composerDataHandle'
    const cloud = 'if(V.message.case==="turnEnded"){await D(),E(),e.setData("status","completed")'
    const original = `other-patch;${local};${cloud}`
    const patched = patchUsageSource(original)
    expect(patchUsageSource(patched)).toBe(patched)
    expect(patched).toContain('g:String(this.generationUUID')
    const legacy = '/* __SG_TEAM_USAGE_PATCH__ */try{const __sg=globalThis.__sgTeamUsage;old()}catch(__q){}'
    expect(patchUsageSource(original.replace(local, legacy + local).replace(cloud, legacy + cloud))).toBe(patched)
    expect(() => patchUsageSource('no-anchor')).toThrow()
    expect(patched).toContain('other-patch;')
  })
})
