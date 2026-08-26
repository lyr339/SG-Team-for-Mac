import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AccountAutomationService } from '../src/application/account-automation-service'
import { AccountAutomationSettingsStore } from '../src/application/account-automation-store'
import type { AccountAutomationRun } from '../src/domain/account-automation'

interface FakeAccount {
  id: string
  label: string
  active: boolean
  token: string
  removed?: boolean
}

interface HarnessOptions {
  enabled?: boolean
  delaySec?: number
  cardSaved?: boolean
  accounts?: FakeAccount[]
  processResult?: { ok: boolean; message: string; remaining?: number }
  browserToken?: string
  browserTokenError?: string
  readBrowserToken?: string
  readBrowserTokenError?: string
  deleteResult?: { ok: boolean; message: string; authExpired?: boolean; needLeaveTeam?: boolean }
  /** 逐次返回的删除结果队列（优先于 deleteResult）。 */
  deleteResults?: Array<{ ok: boolean; message: string; authExpired?: boolean; needLeaveTeam?: boolean }>
  /** 秒级通道行为（提供时注入 inBrowserDeleter）。 */
  inBrowser?: { kind: 'deleted' } | { kind: 'retry_legacy'; message?: string } | { kind: 'not_logged_in'; message?: string }
}

function createHarness(options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'account-automation-test-'))
  const store = new AccountAutomationSettingsStore(join(dir, 'settings.json'))
  store.save({ enabled: options.enabled ?? true, delaySec: options.delaySec ?? 7 })

  const accounts = (options.accounts ?? [{ id: 'acc-1', label: 'A', active: true, token: 'old-token' }])
    .map((account) => ({ ...account }))
  let clock = 0
  const processCalls: string[] = []
  const processOptions: Array<{ refreshRemaining?: boolean } | undefined> = []
  const warmupCalls: number[] = []
  const replacedTokens: Array<{ id: string; token: string }> = []
  const deleteCalls: string[] = []
  const refreshCalls: string[] = []
  const prepareCalls: number[] = []
  const fastDeleteCalls: number[] = []

  const service = new AccountAutomationService({
    settings: store,
    aozai: {
      processToken: async (token, _onProgress, processOptionsArg) => {
        processCalls.push(token)
        processOptions.push(processOptionsArg)
        return options.processResult ?? { ok: true, message: '处理完成', remaining: 45 }
      },
      warmup: async () => {
        warmupCalls.push(1)
      }
    },
    cardVault: {
      maskedCode: () => (options.cardSaved ?? true) ? 'C***1234' : undefined
    },
    accounts: {
      list: () => accounts.filter((a) => !a.removed).map((a) => ({
        id: a.id, label: a.label, maskedToken: '••••', active: a.active, createdAt: 0, updatedAt: 0
      })),
      credential: (id?: string) => {
        const account = accounts.find((a) => (id ? a.id === id : a.active))
        if (!account) throw new Error('尚未选择 Cursor 账号')
        return account.token
      },
      replaceToken: (id, token) => {
        const account = accounts.find((a) => a.id === id)
        if (!account) throw new Error('Cursor 账号不存在')
        account.token = token
        replacedTokens.push({ id, token })
        return []
      },
      remove: (id) => {
        const account = accounts.find((a) => a.id === id)
        if (!account) throw new Error('Cursor 账号不存在')
        account.removed = true
        return []
      }
    },
    refreshBrowserToken: async (previousToken: string) => {
      refreshCalls.push(previousToken)
      if (options.browserTokenError) throw new Error(options.browserTokenError)
      if (previousToken !== 'old-token') throw new Error('previousToken 未正确传递')
      return options.browserToken ?? 'new-token-from-browser'
    },
    ...(options.readBrowserToken !== undefined || options.readBrowserTokenError !== undefined
      ? {
          readBrowserToken: () => {
            if (options.readBrowserTokenError) throw new Error(options.readBrowserTokenError)
            return options.readBrowserToken ?? ''
          }
        }
      : {}),
    deleter: {
      deleteAccount: async (token) => {
        deleteCalls.push(token)
        if (options.deleteResults?.length) return options.deleteResults.shift()!
        return options.deleteResult ?? { ok: true, message: 'Cursor 官网账号已删除' }
      }
    },
    ...(options.inBrowser
      ? {
          inBrowserDeleter: {
            prepareRefresh: async () => {
              prepareCalls.push(1)
            },
            deleteWhenReady: async () => {
              fastDeleteCalls.push(1)
              const spec = options.inBrowser!
              if (spec.kind === 'deleted') return { kind: 'deleted' as const }
              if (spec.kind === 'not_logged_in') {
                return { kind: 'not_logged_in' as const, message: spec.message ?? '浏览器会话已退出登录（页面停留在认证/登录页）' }
              }
              return { kind: 'retry_legacy' as const, message: spec.message ?? '页面加载超时' }
            }
          }
        }
      : {}),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    }
  })
  return {
    service,
    store,
    dir,
    accounts,
    processCalls,
    processOptions,
    warmupCalls,
    replacedTokens,
    deleteCalls,
    refreshCalls,
    prepareCalls,
    fastDeleteCalls,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

async function waitForTerminal(service: AccountAutomationService): Promise<AccountAutomationRun> {
  for (let i = 0; i < 1_000; i += 1) {
    const run = service.getRun()
    if (['done', 'failed', 'cancelled'].includes(run.phase)) return run
    await Promise.resolve()
  }
  throw new Error('run did not reach terminal phase')
}

describe('AccountAutomationService', () => {
  let cleanup = (): void => {}
  afterEach(() => cleanup())

  it('完整链（会话仍有效）：倒计时→奥仔→当前会话直接删官网→移除本地，全程不碰浏览器', async () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.processCalls).toEqual(['old-token'])
    expect(harness.deleteCalls).toEqual(['old-token'])
    expect(harness.refreshCalls).toHaveLength(0)
    expect(harness.replacedTokens).toHaveLength(0)
    expect(harness.accounts[0]?.removed).toBe(true)
  })

  it('完整链（会话已失效）：奥仔→删除遇 307→浏览器换新 token 入库→新会话删除→移除本地', async () => {
    const harness = createHarness({
      deleteResults: [
        { ok: false, authExpired: true, message: '会话已失效（官网要求重新登录）' },
        { ok: true, message: 'Cursor 官网账号已删除' }
      ]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.processCalls).toEqual(['old-token'])
    expect(harness.refreshCalls).toEqual(['old-token'])
    expect(harness.replacedTokens).toEqual([{ id: 'acc-1', token: 'new-token-from-browser' }])
    expect(harness.deleteCalls).toEqual(['old-token', 'new-token-from-browser'])
    expect(harness.accounts[0]?.removed).toBe(true)
  })

  it('删除被拒（非会话失效，如仍有有效订阅）→ 不轮换、直接失败并保留本地记录', async () => {
    const harness = createHarness({
      deleteResults: [{ ok: false, message: 'workspace has active subscription' }]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('active subscription')
    expect(harness.refreshCalls).toHaveLength(0)
    expect(harness.accounts[0]?.removed).not.toBe(true)
  })

  it('提速策略：倒计时末预热登录，且链内跳过余额刷新', async () => {
    const harness = createHarness({ delaySec: 7 })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.warmupCalls).toHaveLength(1)
    expect(harness.processOptions[0]).toEqual({ refreshRemaining: false })
  })

  it('开关关闭时不触发', async () => {
    const harness = createHarness({ enabled: false })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    await Promise.resolve()
    expect(harness.service.getRun().phase).toBe('idle')
    expect(harness.processCalls).toHaveLength(0)
  })

  it('浏览器会话与凭据一致 → 校验通过并走完整链', async () => {
    const harness = createHarness({ readBrowserToken: 'old-token' })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.processCalls).toEqual(['old-token'])
  })

  it('浏览器会话与群枢凭据不一致 → 消耗卡密前中止', async () => {
    const harness = createHarness({ readBrowserToken: 'some-other-token' })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('凭据不一致')
    expect(harness.processCalls).toHaveLength(0)
    expect(harness.deleteCalls).toHaveLength(0)
  })

  it('浏览器会话读取失败 → 消耗卡密前中止', async () => {
    const harness = createHarness({ readBrowserTokenError: '钥匙串读取失败' })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('浏览器会话读取失败')
    expect(harness.processCalls).toHaveLength(0)
  })

  it('同一 plan 只执行一次（重复事件去重）', async () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.processCalls).toHaveLength(1)
  })

  it('倒计时阶段可取消，不消耗卡密', async () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    harness.service.cancel()
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('cancelled')
    expect(harness.processCalls).toHaveLength(0)
  })

  it('未配置卡密 → 倒计时后明确失败，不动账号', async () => {
    const harness = createHarness({ cardSaved: false })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('奥仔卡密')
    expect(harness.processCalls).toHaveLength(0)
  })

  it('未选择账号 → 明确失败', async () => {
    const harness = createHarness({ accounts: [{ id: 'acc-1', label: 'A', active: false, token: 't' }] })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('尚未选择')
  })

  it('奥仔处理失败 → 中止并保留本地账号', async () => {
    const harness = createHarness({ processResult: { ok: false, message: '卡密次数用尽' } })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('卡密次数用尽')
    expect(run.message).toContain('已保留')
    expect(harness.accounts[0]?.removed).toBeFalsy()
    expect(harness.deleteCalls).toHaveLength(0)
  })

  it('浏览器会话刷新失败（会话已失效路径）→ 中止并保留本地账号', async () => {
    const harness = createHarness({
      browserTokenError: '浏览器会话刷新超时',
      deleteResults: [{ ok: false, authExpired: true, message: '会话已失效（官网要求重新登录）' }]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('浏览器会话刷新超时')
    expect(run.message).toContain('已保留')
    expect(harness.accounts[0]?.removed).toBeFalsy()
    expect(harness.deleteCalls).toEqual(['old-token'])
  })

  it('官网删除失败（新会话路径）→ 新 token 已入库但本地记录保留', async () => {
    const harness = createHarness({
      deleteResults: [
        { ok: false, authExpired: true, message: '会话已失效（官网要求重新登录）' },
        { ok: false, message: '官网拒绝了删除请求' }
      ]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('官网拒绝了删除请求')
    expect(harness.replacedTokens).toHaveLength(1)
    expect(harness.deleteCalls).toEqual(['old-token', 'new-token-from-browser'])
    expect(harness.accounts[0]?.removed).toBeFalsy()
  })

  it('秒级通道：会话已失效 → 浏览器会话内直接删除（不轮换、不入库）', async () => {
    const harness = createHarness({
      inBrowser: { kind: 'deleted' }
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(run.message).toContain('秒级')
    expect(harness.prepareCalls).toHaveLength(1)
    expect(harness.fastDeleteCalls).toHaveLength(1)
    expect(harness.deleteCalls).toHaveLength(0)
    expect(harness.refreshCalls).toHaveLength(0)
    expect(harness.replacedTokens).toHaveLength(0)
    expect(harness.accounts[0]?.removed).toBe(true)
  })

  it('秒级通道不可用 → 回退 cookie 轮换链完成删除', async () => {
    const harness = createHarness({
      inBrowser: { kind: 'retry_legacy', message: '页面加载超时' },
      deleteResults: [{ ok: true, message: 'Cursor 官网账号已删除' }]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.fastDeleteCalls).toHaveLength(1)
    expect(harness.refreshCalls).toEqual(['old-token'])
    expect(harness.replacedTokens).toEqual([{ id: 'acc-1', token: 'new-token-from-browser' }])
    expect(harness.deleteCalls).toEqual(['new-token-from-browser'])
    expect(harness.accounts[0]?.removed).toBe(true)
  })

  it('秒级通道检测未登录 → 硬失败并保留记录（不再轮换）', async () => {
    const harness = createHarness({
      inBrowser: { kind: 'not_logged_in' }
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('退出登录')
    expect(harness.refreshCalls).toHaveLength(0)
    expect(harness.accounts[0]?.removed).toBeFalsy()
  })

  it('秒级通道作为主路径：不先打旧 token 删除，避免旧会话错误拖慢', async () => {
    const harness = createHarness({ inBrowser: { kind: 'deleted' } })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.prepareCalls).toHaveLength(1)
    expect(harness.fastDeleteCalls).toHaveLength(1)
    expect(harness.deleteCalls).toHaveLength(0)
    expect(harness.refreshCalls).toHaveLength(0)
  })

  it('官网要求先退团 → 自动等待重试直至成功（副作用落地延迟，不识败）', async () => {
    const harness = createHarness({
      deleteResults: [
        { ok: false, needLeaveTeam: true, message: '官网要求先退出团队：Please leave the team before deleting your account.' },
        { ok: false, needLeaveTeam: true, message: '官网要求先退出团队：Please leave the team before deleting your account.' },
        { ok: true, message: 'Cursor 官网账号已删除' }
      ]
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(harness.deleteCalls).toEqual(['old-token', 'old-token', 'old-token'])
    expect(harness.refreshCalls).toHaveLength(0)
    expect(harness.accounts[0]?.removed).toBe(true)
  })

  it('持续要求退团超过 60s 重试窗 → 明确失败并保留记录', async () => {
    const harness = createHarness({
      deleteResult: { ok: false, needLeaveTeam: true, message: '官网要求先退出团队：Please leave the team' }
    })
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('failed')
    expect(run.message).toContain('持续要求先退出团队')
    expect(harness.deleteCalls.length).toBeGreaterThan(10)
    expect(harness.accounts[0]?.removed).toBeFalsy()
  })

  it('倒计时中新一轮触发取代旧轮，只执行一次完整链', async () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    harness.service.onAllSessionsTriggered('plan-1')
    harness.service.onAllSessionsTriggered('plan-2')
    const run = await waitForTerminal(harness.service)
    expect(run.phase).toBe('done')
    expect(run.planId).toBe('plan-2')
    expect(harness.processCalls).toHaveLength(1)
  })

  it('设置持久化：非法值被钳制（0.5–60 秒），支持半秒步进', () => {
    const harness = createHarness()
    cleanup = harness.cleanup
    const saved = harness.store.save({ enabled: true, delaySec: 99999 })
    expect(saved.delaySec).toBe(60)
    expect(harness.store.load()).toEqual({ enabled: true, delaySec: 60 })
    const low = harness.store.save({ enabled: true, delaySec: 0 })
    expect(low.delaySec).toBe(0.5)
    // 半秒步进：保留 0.5 精度，非 0.5 倍数对齐到最近半秒
    expect(harness.store.save({ enabled: true, delaySec: 2.5 }).delaySec).toBe(2.5)
    expect(harness.store.save({ enabled: true, delaySec: 2.3 }).delaySec).toBe(2.5)
    expect(harness.store.save({ enabled: true, delaySec: 2.2 }).delaySec).toBe(2)
  })
})
