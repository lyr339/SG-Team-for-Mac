import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { switchCursorAccountWithVault } from '../src/application/cursor-account-switch'
import { CursorAccountVault, type CursorAccountVaultCrypto } from '../src/application/cursor-account-vault'
import type {
  CursorAccountSwitchInput,
  CursorAccountSwitchResult
} from '../src/infrastructure/cursor/cursor-account-switcher'
import {
  generateCursorMachineIdentity,
  type CursorMachineIdentity
} from '../src/infrastructure/cursor/cursor-machine-identity'

const crypto: CursorAccountVaultCrypto = {
  available: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${value}`).reverse(),
  decrypt: (value) => Buffer.from(value).reverse().toString().replace(/^encrypted:/, '')
}

function successResult(): CursorAccountSwitchResult {
  return {
    switched: true,
    killedCursor: true,
    relaunchMode: 'cdp',
    cdpPortReady: true,
    machineIdentityApplied: true,
    runtimeVerified: true
  }
}

interface SwitchSpy {
  calls: CursorAccountSwitchInput[]
  result: () => CursorAccountSwitchResult
  identityAt: (index: number) => CursorMachineIdentity
}

function switchSpy(result: () => CursorAccountSwitchResult): SwitchSpy {
  const calls: CursorAccountSwitchInput[] = []
  return {
    calls,
    result,
    identityAt: (index) => calls[index]!.identity
  }
}

function vaultWithTwoAccounts(): { vault: CursorAccountVault; firstId: string; secondId: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-account-switch-orchestration-')), 'accounts.json')
  const vault = new CursorAccountVault(path, crypto)
  // save 返回全账号列表；按备注定位，避免下标歧义
  const firstId = vault.save({ label: 'a@example.com（网页登录）', token: 'token-account-a-000000' })[0]!.id
  const secondId = vault.save({ label: 'b@example.com（网页登录）', token: 'token-account-b-000000', makeActive: false })
    .find((account) => account.id !== firstId)!.id
  // 初始活跃账号固定为 A（save 默认会激活最后保存的账号，显式归位避免歧义）
  vault.select(firstId)
  return { vault, firstId, secondId }
}

describe('switchCursorAccountWithVault（vault 与 switcher 时序契约）', () => {
  it('syncs the vault active account only after a successful switch', async () => {
    const { vault, firstId, secondId } = vaultWithTwoAccounts()
    const spy = switchSpy(successResult)
    let suppressed = 0

    const result = await switchCursorAccountWithVault(
      {
        vault,
        switcher: { switchAccount: async (input) => {
          spy.calls.push(input)
          // 切换进行中 active 仍指向原账号（失败可回退的时序保证）
          expect(vault.list().find((account) => account.active)?.id).toBe(firstId)
          return spy.result()
        } },
        suppressCdpAutoHeal: () => { suppressed += 1 }
      },
      secondId
    )

    expect(result.switched).toBe(true)
    expect(suppressed).toBe(1)
    expect(vault.list().find((account) => account.active)?.id).toBe(secondId)
    expect(spy.calls[0]).toMatchObject({ token: 'token-account-b-000000', email: 'b@example.com' })
  })

  it('keeps the previous active account untouched when the switch fails', async () => {
    const { vault, firstId, secondId } = vaultWithTwoAccounts()
    const spy = switchSpy(successResult)

    await expect(switchCursorAccountWithVault(
      {
        vault,
        switcher: { switchAccount: async (input) => {
          spy.calls.push(input)
          throw new Error('Cursor 未能在限定时间内退出')
        } }
      },
      secondId
    )).rejects.toThrowError(/未能.*退出/)
    expect(spy.calls).toHaveLength(1)

    // 关键回归防线：切换失败时 Cursor 仍运行原账号，active 必须保持原值，
    // 否则账号自动化会拿新账号 token 作用于仍登录旧账号的 Cursor。
    expect(vault.list().find((account) => account.active)?.id).toBe(firstId)
  })

  it('binds the machine identity on first switch and replays it afterwards', async () => {
    const { vault, secondId } = vaultWithTwoAccounts()
    const spy = switchSpy(successResult)
    const fixed = generateCursorMachineIdentity()

    const run = (index: number) => switchCursorAccountWithVault(
      {
        vault,
        switcher: { switchAccount: async (input) => {
          spy.calls.push(input)
          return successResult()
        } },
        generateIdentity: () => fixed
      },
      secondId
    ).then(() => spy.identityAt(index))

    const first = await run(0)
    const second = await run(1)
    expect(first).toEqual(fixed)
    expect(second).toEqual(fixed)
    expect(vault.machineIdentity(secondId)).toEqual(fixed)
  })

  it('propagates credential failures before touching the switcher or vault state', async () => {
    const { vault, firstId } = vaultWithTwoAccounts()
    const unreadable = new CursorAccountVault(vault.path, {
      ...crypto,
      decrypt: () => { throw new Error('keychain changed') }
    })
    const spy = switchSpy(successResult)

    await expect(switchCursorAccountWithVault(
      {
        vault: unreadable,
        switcher: { switchAccount: async (input) => {
          spy.calls.push(input)
          return successResult()
        } }
      },
      firstId
    )).rejects.toThrowError(/重新导入 Token/)

    expect(spy.calls).toHaveLength(0)
    // active 保持 save() 时的默认（首个账号），未被切换流程改动
    expect(unreadable.list().find((account) => account.active)?.id).toBe(firstId)
  })

  it('omits the email for labels that are not plain addresses', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-account-switch-orchestration-')), 'accounts.json')
    const vault = new CursorAccountVault(path, crypto)
    const [account] = vault.save({ label: 'user_01ABC（浏览器导入）', token: 'user_01ABC::token-value-0000' })
    const spy = switchSpy(successResult)

    await switchCursorAccountWithVault(
      {
        vault,
        switcher: { switchAccount: async (input) => {
          spy.calls.push(input)
          return successResult()
        } }
      },
      account!.id
    )

    // userId 非邮箱格式 → email 缺省（切换器将旧 cachedEmail 清空）
    expect(spy.calls[0]!.email).toBeUndefined()
    expect(spy.calls[0]!.token).toBe('user_01ABC::token-value-0000')
  })
})
