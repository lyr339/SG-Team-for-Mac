import { describe, expect, it } from 'vitest'
import { CursorBrowserSessionRefresher } from '../src/infrastructure/cursor/cursor-browser-session-refresher'

interface HarnessOptions {
  /** 每次 readToken 调用依次返回的值（最后一个值之后复用）；抛错用 !前缀表示。 */
  tokenSequence?: string[]
  execError?: string
}

function createHarness(options: HarnessOptions = {}) {
  const execCalls: string[] = []
  let reads = 0
  let clock = 0
  const refresher = new CursorBrowserSessionRefresher({
    readToken: () => {
      const seq = options.tokenSequence ?? ['new-token']
      const value = seq[Math.min(reads, seq.length - 1)] ?? 'new-token'
      reads += 1
      if (value.startsWith('!')) throw new Error(value.slice(1))
      return value
    },
    execFileFn: (async (file: string, args?: readonly string[]) => {
      execCalls.push(`${file} ${(args ?? []).join(' ')}`)
      if (options.execError) throw new Error(options.execError)
      return { stdout: 'reloaded', stderr: '' }
    }) as never,
    sleep: async (ms) => { clock += ms },
    now: () => clock,
    selfUpdateWindowMs: 2,
    refreshTimeoutMs: 10,
    pollIntervalMs: 1
  })
  return { refresher, execCalls, getReads: () => reads }
}

describe('CursorBrowserSessionRefresher', () => {
  it('cookie 自行更新：零打扰直接返回（不调用浏览器）', async () => {
    const { refresher, execCalls } = createHarness({ tokenSequence: ['new-token'] })
    const token = await refresher.refresh('old-token')
    expect(token).toBe('new-token')
    expect(execCalls).toHaveLength(0)
  })

  it('cookie 未自行更新：触发浏览器刷新后轮询到变化', async () => {
    // 自更新窗口含 deadline 末尾复读，全部仍是旧 token；浏览器刷新后变为新 token
    const { refresher, execCalls } = createHarness({ tokenSequence: ['old-token', 'old-token', 'old-token', 'new-token'] })
    const token = await refresher.refresh('old-token')
    expect(token).toBe('new-token')
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]).toContain('osascript')
    expect(execCalls[0]).toContain('cursor.com')
  })

  it('强制真实导航：刷新 URL 携带 cache-bust 参数（同 URL set 在 Chromium 下是 no-op）', async () => {
    const { refresher, execCalls } = createHarness({ tokenSequence: ['old-token', 'old-token', 'old-token', 'new-token'] })
    await refresher.refresh('old-token')
    expect(execCalls[0]).toMatch(/cursor\.com\/dashboard\?qtrefresh=\d+/)
  })

  it('浏览器未运行 → 明确提示', async () => {
    const { refresher } = createHarness({
      tokenSequence: ['old-token'],
      execError: 'browser_not_running'
    })
    await expect(refresher.refresh('old-token')).rejects.toThrowError(/请先打开/)
  })

  it('刷新后 cookie 迟迟不变 → 超时明确报错', async () => {
    const { refresher } = createHarness({ tokenSequence: ['old-token'] })
    await expect(refresher.refresh('old-token')).rejects.toThrowError(/刷新超时/)
  })

  it('deadline 边界仍会做最后一次读取，避免刚落盘的 cookie 被漏掉', async () => {
    const { refresher } = createHarness({ tokenSequence: [
      'old-token',
      'old-token',
      'old-token',
      'old-token',
      'old-token',
      'old-token',
      'old-token',
      'old-token',
      'old-token',
      'old-token',
      'old-token',
      'old-token',
      'old-token',
      'new-token'
    ] })
    await expect(refresher.refresh('old-token')).resolves.toBe('new-token')
  })

  it('读取异常按未变化处理并继续轮询', async () => {
    const { refresher } = createHarness({ tokenSequence: ['!db locked', '!db locked', 'new-token'] })
    expect(await refresher.refresh('old-token')).toBe('new-token')
  })
})
