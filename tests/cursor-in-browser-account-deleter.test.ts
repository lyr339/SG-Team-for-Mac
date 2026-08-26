import { describe, expect, it } from 'vitest'
import { CursorInBrowserAccountDeleter } from '../src/infrastructure/cursor/cursor-in-browser-account-deleter'

interface PageState {
  h: string
  p: string
  s: string
  t: string
}

interface HarnessOptions {
  navigateStdout?: string
  navigateError?: string
  /** 就绪探测依次返回的页面状态（最后一个复用）。 */
  readiness?: PageState[]
  fireStdout?: string
  /** 删除结果轮询依次返回的 __qtDel 值（最后一个复用）。 */
  pollResults?: string[]
  jsDisabled?: boolean
  tabGone?: boolean
}

const DASHBOARD: PageState = { h: 'cursor.com', p: '/dashboard', s: 'complete', t: 'Dashboard' }
const AUTH_CHAIN: PageState = { h: 'authenticator.cursor.sh', p: '/authorize', s: 'loading', t: '' }
const CHALLENGE: PageState = { h: 'cursor.com', p: '/dashboard', s: 'complete', t: 'Just a moment...' }

function createHarness(options: HarnessOptions = {}) {
  const calls: string[] = []
  let clock = 0
  let readinessCalls = 0
  let pollCalls = 0
  let fireScript = ''
  const deleter = new CursorInBrowserAccountDeleter({
    execFileFn: (async (_file: string, args?: readonly string[]) => {
      const script = (args ?? []).join(' ')
      if (script.includes('execute javascript')) {
        if (options.jsDisabled) {
          throw new Error('execution error: Microsoft Edge got an error: Executing JavaScript through AppleScript is turned off. To turn it on, from the menu bar, go to View > Developer > Allow JavaScript from Apple Events. (12)')
        }
        if (options.tabGone) return { stdout: 'tab_gone', stderr: '' }
        if (script.includes('location.hostname')) {
          const seq = options.readiness ?? [DASHBOARD]
          const state = seq[Math.min(readinessCalls, seq.length - 1)]
          readinessCalls += 1
          return { stdout: JSON.stringify(state), stderr: '' }
        }
        if (script.includes('delete-account')) {
          calls.push('fire')
          fireScript = script
          return { stdout: options.fireStdout ?? 'armed', stderr: '' }
        }
        if (script.includes('__qtDel')) {
          const seq = options.pollResults ?? ['{"st":200,"body":"{}"}']
          const value = seq[Math.min(pollCalls, seq.length - 1)]
          pollCalls += 1
          return { stdout: value, stderr: '' }
        }
      }
      calls.push('navigate')
      if (options.navigateError) throw new Error(options.navigateError)
      return { stdout: options.navigateStdout ?? '100:200', stderr: '' }
    }) as never,
    sleep: async (ms) => { clock += ms },
    now: () => clock,
    readyTimeoutMs: 10,
    resultTimeoutMs: 10,
    authChainGraceMs: 4,
    pollIntervalMs: 1
  })
  return { deleter, calls, getFireScript: () => fireScript }
}

describe('CursorInBrowserAccountDeleter', () => {
  it('秒级删除成功：导航刷新 → 页面就绪 → 页面内删除 200', async () => {
    const { deleter, calls } = createHarness()
    await deleter.prepareRefresh()
    const result = await deleter.deleteWhenReady()
    expect(result.kind).toBe('deleted')
    expect(calls).toEqual(['navigate', 'fire'])
  })

  it('认证链短暂弹跳（authenticator）后回到 cursor.com → 正常删除', async () => {
    const { deleter } = createHarness({ readiness: [AUTH_CHAIN, AUTH_CHAIN, DASHBOARD] })
    await deleter.prepareRefresh()
    expect((await deleter.deleteWhenReady()).kind).toBe('deleted')
  })

  it('持续停留认证/登录页超过宽限 → 判定未登录（硬失败）', async () => {
    const { deleter } = createHarness({ readiness: [AUTH_CHAIN] })
    await deleter.prepareRefresh()
    const result = await deleter.deleteWhenReady()
    expect(result.kind).toBe('not_logged_in')
    expect(result).toMatchObject({ message: expect.stringContaining('退出登录') })
  })

  it('Cloudflare 挑战页不就绪 → 等待至超时后回退慢速通道', async () => {
    const { deleter } = createHarness({ readiness: [CHALLENGE] })
    await deleter.prepareRefresh()
    const result = await deleter.deleteWhenReady()
    expect(result.kind).toBe('retry_legacy')
    expect(result).toMatchObject({ message: expect.stringContaining('超时') })
  })

  it('JS 权限未开启 → retry_legacy 且给出一次性开启指引', async () => {
    const { deleter } = createHarness({ jsDisabled: true })
    await deleter.prepareRefresh()
    const result = await deleter.deleteWhenReady()
    expect(result.kind).toBe('retry_legacy')
    expect(result).toMatchObject({ message: expect.stringContaining('Allow JavaScript from Apple Events') })
  })

  it('页面内删除被拒（HTTP 500）→ retry_legacy 并携带状态码', async () => {
    const { deleter } = createHarness({ pollResults: ['{"st":500,"body":"server error"}'] })
    await deleter.prepareRefresh()
    const result = await deleter.deleteWhenReady()
    expect(result.kind).toBe('retry_legacy')
    expect(result).toMatchObject({ message: expect.stringContaining('500') })
  })

  it('页面内删除结果等待超时 → retry_legacy', async () => {
    const { deleter } = createHarness({ pollResults: ['pending'] })
    await deleter.prepareRefresh()
    const result = await deleter.deleteWhenReady()
    expect(result.kind).toBe('retry_legacy')
    expect(result).toMatchObject({ message: expect.stringContaining('超时') })
  })

  it('刷新标签页被关闭 → retry_legacy', async () => {
    const { deleter } = createHarness({ tabGone: true })
    await deleter.prepareRefresh()
    const result = await deleter.deleteWhenReady()
    expect(result.kind).toBe('retry_legacy')
    expect(result).toMatchObject({ message: expect.stringContaining('已被关闭') })
  })

  it('页面内删除 JS 自带「退团等待」自愈：leave the team 自动重试而非一次识败', async () => {
    const { deleter, getFireScript } = createHarness()
    await deleter.prepareRefresh()
    await deleter.deleteWhenReady()
    const js = getFireScript()
    expect(js).toContain('/api/csrf-token')
    expect(js).toContain('invalid_csrf_token')
    expect(js).toContain('500')
    expect(js).toContain('leave the team')
    expect(js).toContain('setTimeout')
    expect(js).toContain('500') // 快速重试间隔 500ms
  })

  it('放宽就绪条件：readyState 为 loading 但已在 cursor.com 域名下即视为就绪', async () => {
    const { deleter } = createHarness({
      readiness: [{ h: 'cursor.com', p: '/dashboard', s: 'loading', t: 'Dashboard' }]
    })
    await deleter.prepareRefresh()
    const result = await deleter.deleteWhenReady()
    expect(result.kind).toBe('deleted')
  })

  it('浏览器未运行 → prepare 明确报错，deleteWhenReady 回退并携带原因', async () => {
    const { deleter } = createHarness({ navigateError: 'browser_not_running' })
    await expect(deleter.prepareRefresh()).rejects.toThrowError(/请先打开/)
    const result = await deleter.deleteWhenReady()
    expect(result.kind).toBe('retry_legacy')
    expect(result).toMatchObject({ message: expect.stringContaining('请先打开') })
  })
})
