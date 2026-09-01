import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CursorAccountSwitcher,
  type CursorAccountSwitchInput
} from '../src/infrastructure/cursor/cursor-account-switcher'
import {
  generateCursorMachineIdentity,
  type CursorMachineIdentity
} from '../src/infrastructure/cursor/cursor-machine-identity'
import type {
  CursorRuntimeAccountBridgePort,
  CursorRuntimeSwitchPayload
} from '../src/infrastructure/cursor/cursor-runtime-account-bridge'
import type { CursorDesktopTokenExchangePort } from '../src/infrastructure/cursor/cursor-desktop-token-exchanger'

/** 与切换器内部的 reactiveStorage 持久层键保持一致（未导出，测试侧镜像）。 */
const APPLICATION_USER_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'

/** 构造三段式 JWT（base64url payload）。 */
function makeTypedJwt(sub: string, type: 'web' | 'session'): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub, type, exp: 2_000_000_000 })}.signature`
}

function makeJwt(sub: string, exp?: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub, ...(exp !== undefined ? { exp } : {}) })}.signature`
}

interface Fixture {
  root: string
  stateDbPath: string
  storageJsonPath: string
  machineIdPath: string
  calls: string[]
  setCursorAlive: (alive: boolean) => void
  setStubborn: (stubborn: boolean) => void
  bumpClock: () => void
  clockNow: () => number
  switcherFor: (options?: {
    cdpPort?: () => number | undefined
    workspacePath?: () => string | undefined
    fetchFn?: (url: string) => Promise<{ status: number }>
    portReadyTimeoutMs?: number
    platform?: () => NodeJS.Platform
    execFn?: (file: string, args: string[]) => Promise<{ stdout: string }>
    runtimeBridge?: CursorRuntimeAccountBridgePort
    tokenExchanger?: CursorDesktopTokenExchangePort
  }) => CursorAccountSwitcher
  input: (overrides?: Partial<CursorAccountSwitchInput>) => CursorAccountSwitchInput
}

let fixture: Fixture

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'qingtian-account-switcher-'))
  const stateDbPath = join(root, 'state.vscdb')
  const storageJsonPath = join(root, 'storage.json')
  const machineIdPath = join(root, 'machineid')

  const db = new DatabaseSync(stateDbPath)
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value)')
  const seed = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
  seed.run('cursorAuth/accessToken', 'old-token')
  seed.run('cursorAuth/refreshToken', 'old-token')
  seed.run('cursorAuth/cachedEmail', 'previous@example.com')
  seed.run('cursorAuth/cachedSignUpType', 'Google_2')
  seed.run('cursorAuth/stripeMembershipType', 'pro')
  seed.run('cursorAuth/onboardingDate', '2026-01-01T00:00:00.000Z')
  seed.run('cursor.accessToken', 'user_old::old-token')
  seed.run('storage.serviceMachineId', 'old-machine-guid')
  seed.run('cursorai/serverConfig', '{"bugConfigResponse":{}}')
  seed.run('aiSettings', '{}')
  seed.run('isUsagePricingEnabled', 'true')
  db.close()
  // storage.json 带 4 个遥测键 + 一个无关键（必须保留）
  writeFileSync(storageJsonPath, JSON.stringify({
    'telemetry.machineId': 'old-machine-id',
    'telemetry.macMachineId': 'old-mac',
    'telemetry.devDeviceId': 'old-dev',
    'telemetry.sqmId': 'old-sqm',
    'windowsState': { kept: true }
  }), 'utf8')
  writeFileSync(machineIdPath, 'old-machine-guid', 'utf8')

  const calls: string[] = []
  let cursorAlive = true
  let stubborn = false
  // 假时钟随每次 sleep 前进，否则 waitForExit 的 deadline 轮询永不终止
  let fakeNow = 1_788_000_000_000
  const advanceClock = () => { fakeNow += 500 }
  const execFn = async (file: string, args: string[]): Promise<{ stdout: string }> => {
    calls.push([file, ...args].join(' '))
    if (file === 'pgrep') return { stdout: cursorAlive ? '424242\n' : '' }
    if (file === 'pkill') {
      if (args.includes('-9')) cursorAlive = false
      else if (!stubborn) cursorAlive = false
      return { stdout: '' }
    }
    return { stdout: '' }
  }

  const identity: CursorMachineIdentity = generateCursorMachineIdentity()
  fixture = {
    root,
    stateDbPath,
    storageJsonPath,
    machineIdPath,
    calls,
    setCursorAlive: (alive) => { cursorAlive = alive },
    setStubborn: (value) => { stubborn = value },
    bumpClock: advanceClock,
    clockNow: () => fakeNow,
    switcherFor: (options) => new CursorAccountSwitcher({
      stateDatabasePath: stateDbPath,
      storageJsonPath,
      machineIdPath,
      // 默认锁定 darwin 分支：未注入平台的用例断言的是 macOS 终止/拉起链
      // （pgrep/pkill/open）。宿主跑在 Windows 时若走真实平台会误入 win32
      // 分支（tasklist/taskkill/cmd start），断言全部落空；Windows 行为由
      // 显式注入 platform: () => 'win32' 的用例覆盖。
      platform: () => 'darwin',
      execFn,
      sleep: async () => { advanceClock() },
      now: () => fakeNow,
      ...options
    }),
    input: (overrides) => ({
      token: makeJwt('auth0|user_new'),
      email: 'new@example.com',
      identity,
      ...overrides
    })
  }
})

afterEach(() => {
  fixture = undefined as unknown as Fixture
})

function itemTableValue(path: string, key: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)
  } finally {
    db.close()
  }
}

describe('CursorAccountSwitcher', () => {
  it('kills Cursor deterministically before touching the database, then writes auth + machine identity', async () => {
    const result = await fixture.switcherFor().switchAccount(fixture.input())

    // 时序铁证：pkill 先于 open（拉起）出现，且 open 带工作区参数
    const pkillIndex = fixture.calls.findIndex((call) => call.startsWith('pkill -x Cursor'))
    const openIndex = fixture.calls.findIndex((call) => call.startsWith('open '))
    expect(pkillIndex).toBeGreaterThanOrEqual(0)
    expect(openIndex).toBeGreaterThan(pkillIndex)
    expect(result).toMatchObject({ switched: true, killedCursor: true, machineIdentityApplied: true })

    // 认证键（FlyCursor 实证集）
    const token = fixture.input().token
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/accessToken')).toEqual({ value: token })
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/refreshToken')).toEqual({ value: token })
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/cachedEmail')).toEqual({ value: 'new@example.com' })
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/cachedSignUpType')).toEqual({ value: 'Auth_0' })
    // 机器码：state.vscdb 的 serviceMachineId 与 machineid 文件恒同值
    expect(itemTableValue(fixture.stateDbPath, 'storage.serviceMachineId'))
      .toEqual({ value: fixture.input().identity.machineGuid })
    expect(readFileSync(fixture.machineIdPath, 'utf8')).toBe(fixture.input().identity.machineGuid)

    // storage.json：遥测 4 键重写，无关键保留
    const storage = JSON.parse(readFileSync(fixture.storageJsonPath, 'utf8')) as Record<string, unknown>
    expect(storage['telemetry.machineId']).toBe(fixture.input().identity.machineId)
    expect(storage['telemetry.macMachineId']).toBe(fixture.input().identity.macMachineId)
    expect(storage['telemetry.devDeviceId']).toBe(fixture.input().identity.devDeviceId)
    expect(storage['telemetry.sqmId']).toBe(fixture.input().identity.sqmId)
    expect(storage['windowsState']).toEqual({ kept: true })

    // 痕迹与陈旧缓存清理
    for (const key of ['cursorai/serverConfig', 'aiSettings', 'isUsagePricingEnabled',
      'cursor.accessToken', 'cursorAuth/stripeMembershipType', 'cursorAuth/onboardingDate']) {
      expect(itemTableValue(fixture.stateDbPath, key)).toBeUndefined()
    }

    // 逻辑备份：itemtable.sqlite3 + storage.json + machineid
    expect(result.backupDir).toBeDefined()
    const backups = readdirSync(result.backupDir!)
    expect(backups).toContain('itemtable.sqlite3')
    expect(backups).toContain('storage.json')
    expect(backups).toContain('machineid')
  })

  it('requires Cursor runtime acknowledgement and verifies the flushed target account', async () => {
    let received: CursorRuntimeSwitchPayload | undefined
    const runtimeBridge: CursorRuntimeAccountBridgePort = {
      applyAfterLaunch: async (payload, launch) => {
        received = payload
        return { launchResult: await launch(), ack: { success: true, reason: '' } }
      }
    }
    const result = await fixture.switcherFor({ runtimeBridge }).switchAccount(fixture.input())
    expect(result.runtimeVerified).toBe(true)
    expect(received).toMatchObject({
      accessToken: fixture.input().token,
      refreshToken: fixture.input().token,
      email: 'new@example.com',
      signUpType: 'Auth_0',
      userId: 'auth0|user_new'
    })
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/userId'))
      .toEqual({ value: 'auth0|user_new' })
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/cachedUserId'))
      .toEqual({ value: 'auth0|user_new' })
  })

  it('exchanges browser type=web before killing Cursor and only writes/sends the IDE session token', async () => {
    const webToken = makeTypedJwt('auth0|user_new', 'web')
    const sessionToken = makeTypedJwt('auth0|user_new', 'session')
    const tokenExchanger: CursorDesktopTokenExchangePort = {
      resolve: async (token, stateDatabasePath) => {
        expect(fixture.calls).toHaveLength(0)
        expect(token).toBe(webToken)
        expect(stateDatabasePath).toBe(fixture.stateDbPath)
        return {
          accessToken: sessionToken,
          refreshToken: sessionToken,
          sourceType: 'web',
          runtimeType: 'session',
          exchanged: true
        }
      }
    }
    let runtimePayload: CursorRuntimeSwitchPayload | undefined
    const runtimeBridge: CursorRuntimeAccountBridgePort = {
      applyAfterLaunch: async (payload, launch) => {
        runtimePayload = payload
        return { launchResult: await launch(), ack: { success: true, reason: '' } }
      }
    }
    await fixture.switcherFor({ tokenExchanger, runtimeBridge }).switchAccount(fixture.input({ token: webToken }))

    expect(fixture.calls.some((call) => call.startsWith('pkill'))).toBe(true)
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/accessToken')).toEqual({ value: sessionToken })
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/refreshToken')).toEqual({ value: sessionToken })
    expect(runtimePayload).toMatchObject({ accessToken: sessionToken, refreshToken: sessionToken })
  })

  it('does not report success when Cursor runtime rejects the target token', async () => {
    const runtimeBridge: CursorRuntimeAccountBridgePort = {
      applyAfterLaunch: async (_payload, launch) => ({
        launchResult: await launch(),
        ack: { success: false, reason: 'readback-mismatch' }
      })
    }
    await expect(fixture.switcherFor({ runtimeBridge }).switchAccount(fixture.input()))
      .rejects.toThrowError(/readback-mismatch/)
  })

  it('skips the kill chain when Cursor is not running', async () => {
    fixture.setCursorAlive(false)
    const result = await fixture.switcherFor().switchAccount(fixture.input())

    expect(result.killedCursor).toBe(false)
    expect(fixture.calls.some((call) => call.startsWith('pkill'))).toBe(false)
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/accessToken'))
      .toEqual({ value: fixture.input().token })
  })

  it('escalates to pkill -9 when SIGTERM is ignored', async () => {
    fixture.setStubborn(true)
    const result = await fixture.switcherFor().switchAccount(fixture.input())

    expect(result.killedCursor).toBe(true)
    expect(fixture.calls.some((call) => call === 'pkill -9 -x Cursor')).toBe(true)
  })

  it('fails loudly when Cursor refuses to exit even after SIGKILL', async () => {
    fixture.setStubborn(true)
    // SIGKILL 也杀不死：pgrep 恒返回存活
    const immortalSwitcher = new CursorAccountSwitcher({
      stateDatabasePath: fixture.stateDbPath,
      storageJsonPath: fixture.storageJsonPath,
      machineIdPath: fixture.machineIdPath,
      platform: () => 'darwin',
      execFn: async (file, args) => {
        fixture.calls.push([file, ...args].join(' '))
        if (file === 'pgrep') return { stdout: '424242\n' }
        return { stdout: '' }
      },
      sleep: async () => { fixture.bumpClock() },
      now: () => fixture.clockNow()
    })

    await expect(immortalSwitcher.switchAccount(fixture.input()))
      .rejects.toThrowError(/未能.*退出/)
    // 失败时不落任何写入
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/accessToken')).toEqual({ value: 'old-token' })
  })

  it('windows: taskkill 后 Cursor 仍存活 → 同样大声失败且不落任何写入', async () => {
    // win32 无二次升级（taskkill /F 本身即强杀），存活即直接进入失败路径
    const immortalWinSwitcher = new CursorAccountSwitcher({
      stateDatabasePath: fixture.stateDbPath,
      storageJsonPath: fixture.storageJsonPath,
      machineIdPath: fixture.machineIdPath,
      platform: () => 'win32',
      execFn: async (file, args) => {
        fixture.calls.push([file, ...args].join(' '))
        if (file === 'tasklist') return { stdout: '"Cursor.exe","4242","Console","1","45,678 K"' }
        return { stdout: '' }
      },
      sleep: async () => { fixture.bumpClock() },
      now: () => fixture.clockNow()
    })

    await expect(immortalWinSwitcher.switchAccount(fixture.input()))
      .rejects.toThrowError(/未能.*退出/)
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/accessToken')).toEqual({ value: 'old-token' })
  })

  it('relaunches with the CDP port when provided, plain otherwise', async () => {
    const withCdp = await fixture.switcherFor({
      cdpPort: () => 9333,
      fetchFn: async () => ({ status: 200 }),
      portReadyTimeoutMs: 5_000
    }).switchAccount(fixture.input())
    expect(withCdp.relaunchMode).toBe('cdp')
    expect(withCdp.cdpPortReady).toBe(true)
    expect(fixture.calls.some((call) => call.includes('--remote-debugging-port=9333'))).toBe(true)

    // 第二次切换只看新增调用，避免上一次的 CDP 参数干扰断言
    const callsBefore = fixture.calls.length
    fixture.setCursorAlive(true)
    const plain = await fixture.switcherFor().switchAccount(fixture.input())
    expect(plain.relaunchMode).toBe('plain')
    expect(plain.cdpPortReady).toBeUndefined()
    expect(fixture.calls.slice(callsBefore).some((call) => call.includes('--remote-debugging-port'))).toBe(false)
  })

  it('windows: taskkill 终止链 + cmd start 带端口拉起（与 mac 链路彻底分离）', async () => {
    let alive = true
    const winCalls: string[] = []
    const result = await fixture.switcherFor({
      platform: () => 'win32',
      cdpPort: () => 9333,
      fetchFn: async () => ({ status: 200 }),
      portReadyTimeoutMs: 5_000,
      execFn: async (file, args) => {
        winCalls.push([file, ...args].join(' '))
        // tasklist：运行中回显 Cursor.exe 行；无匹配输出 INFO 行（不含 Cursor.exe）
        if (file === 'tasklist') {
          return { stdout: alive ? '"Cursor.exe","4242","Console","1","45,678 K"' : 'INFO: No tasks are running which match the specified criteria.' }
        }
        if (file === 'taskkill') alive = false
        return { stdout: '' }
      }
    }).switchAccount(fixture.input())

    expect(result.switched).toBe(true)
    expect(result.relaunchMode).toBe('cdp')
    expect(result.cdpPortReady).toBe(true)
    // 终止链：taskkill /F 强杀（切换器语义——一键完成优先）先于 cmd start 拉起
    const killIndex = winCalls.findIndex((call) => call.startsWith('taskkill /F /IM Cursor.exe'))
    const startIndex = winCalls.findIndex((call) => call.startsWith('cmd.exe'))
    expect(killIndex).toBeGreaterThanOrEqual(0)
    expect(startIndex).toBeGreaterThan(killIndex)
    const startCall = winCalls.find((call) => call.startsWith('cmd.exe'))
    expect(startCall).toContain('start ""')
    expect(startCall).toContain('--remote-debugging-port=9333')
    // 不走 mac 链路（pkill/pgrep/open）
    expect(winCalls.some((call) => call.startsWith('pkill') || call.startsWith('pgrep') || call.startsWith('open'))).toBe(false)
    // 登录态与机器码写入平台无关，照常生效
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/accessToken')).toEqual({ value: fixture.input().token })
    expect(readFileSync(fixture.machineIdPath, 'utf8')).toBe(fixture.input().identity.machineGuid)
  })

  it('windows: tasklist 探测真实失败 → fail-closed 中止切换（绝不带未确认的进程状态写库）', async () => {
    await expect(fixture.switcherFor({
      platform: () => 'win32',
      execFn: async (file: string) => {
        if (file === 'tasklist') {
          // 超时类真实失败（非退出码 1 的「无匹配」语义）：无法证明 Cursor 已死
          const error = new Error('spawn ETIMEDOUT') as Error & { code?: unknown }
          error.code = 'ETIMEDOUT'
          throw error
        }
        return { stdout: '' }
      }
    }).switchAccount(fixture.input())).rejects.toThrowError(/无法确认 Cursor 进程状态/)
    // 中止点在杀进程与写库之前：登录态仍是预置旧值（未被新 token 覆盖）
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/accessToken')).toEqual({ value: 'old-token' })
  })

  it('windows: tasklist 退出码 1（部分版本的无匹配语义）→ 视为未运行，正常完成切换', async () => {
    let killed = false
    const result = await fixture.switcherFor({
      platform: () => 'win32',
      cdpPort: () => 9333,
      fetchFn: async () => ({ status: 200 }),
      portReadyTimeoutMs: 5_000,
      execFn: async (file: string) => {
        if (file === 'tasklist') {
          if (killed) {
            const error = new Error('no tasks match the filter') as Error & { code?: unknown }
            error.code = 1
            throw error
          }
          return { stdout: '"Cursor.exe","4242","Console","1","45,678 K"' }
        }
        if (file === 'taskkill') killed = true
        return { stdout: '' }
      }
    }).switchAccount(fixture.input())
    expect(result.switched).toBe(true)
    expect(result.relaunchMode).toBe('cdp')
  })

  it('reports cdpPortReady=false when the port never becomes ready within the timeout', async () => {
    const result = await fixture.switcherFor({
      cdpPort: () => 9333,
      fetchFn: async () => { throw new Error('connect ECONNREFUSED') },
      portReadyTimeoutMs: 2_000
    }).switchAccount(fixture.input())

    // 端口未就绪不视为切换失败：登录态已写入
    expect(result.switched).toBe(true)
    expect(result.relaunchMode).toBe('cdp')
    expect(result.cdpPortReady).toBe(false)
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/accessToken')).toEqual({ value: fixture.input().token })
  })

  it('keeps trace keys when resetTraces is disabled', async () => {
    await fixture.switcherFor().switchAccount(fixture.input({ resetTraces: false }))

    expect(itemTableValue(fixture.stateDbPath, 'cursorai/serverConfig')).toEqual({ value: '{"bugConfigResponse":{}}' })
    expect(itemTableValue(fixture.stateDbPath, 'aiSettings')).toEqual({ value: '{}' })
    // 陈旧缓存键与痕迹键无关，仍然清理
    expect(itemTableValue(fixture.stateDbPath, 'cursor.accessToken')).toBeUndefined()
  })

  it('preserves device-level tool approval prefs while stripping account identity from applicationUser', async () => {
    // P0 回归：applicationUser 整键删除会让每次切换回到工厂默认，MCP 工具全部弹人工审批。
    const composerState = {
      yoloEnableRunEverything: true,
      mcpAllowedTools: ['sg team:team_check_in', 'sg team:record_reply'],
      modes4: [{ id: 'agent', autoRun: true, fullAutoRun: true }]
    }
    const applicationUser = {
      dashboardUserId: 411710535,
      membershipType: 'pro',
      subscriptionStatus: 'active',
      teamAdminSettings: { someAdmin: true },
      newUserData: { toolUsageCount: { plainChat: 'legacy' } },
      aiSettings: { modelConfig: { composer: { modelName: 'kimi-k3' } }, teamIds: ['team-1'] },
      availableDefaultModels2: [{ name: 'default' }],
      featureModelConfigs: { composer: { defaultModel: 'default' } },
      authenticationSettings: { githubLoggedIn: true },
      composerState,
      cppEnabled: true,
      dialogDontAskAgainPreferences: { someDialog: true },
      systemNotificationsEnabled: true
    }
    const db = new DatabaseSync(fixture.stateDbPath)
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
      .run(APPLICATION_USER_KEY, JSON.stringify(applicationUser))
    db.close()

    await fixture.switcherFor().switchAccount(fixture.input())

    const raw = itemTableValue(fixture.stateDbPath, APPLICATION_USER_KEY) as { value: string } | undefined
    expect(raw).toBeDefined()
    const after = JSON.parse(raw!.value) as Record<string, unknown>
    // 设备级偏好原样保留——工具放行是 P0 的核心
    expect(after.composerState).toEqual(composerState)
    expect(after.cppEnabled).toBe(true)
    expect(after.dialogDontAskAgainPreferences).toEqual({ someDialog: true })
    expect(after.systemNotificationsEnabled).toBe(true)
    // 账号身份字段全部摘除（服务端登录后重推）
    for (const field of ['dashboardUserId', 'membershipType', 'subscriptionStatus', 'teamAdminSettings',
      'newUserData', 'aiSettings', 'availableDefaultModels2', 'featureModelConfigs', 'authenticationSettings']) {
      expect(after[field]).toBeUndefined()
    }
  })

  it('falls back to full deletion when applicationUser is corrupt, and skips when missing', async () => {
    const db = new DatabaseSync(fixture.stateDbPath)
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(APPLICATION_USER_KEY, '{not-json')
    db.close()
    await fixture.switcherFor().switchAccount(fixture.input())
    expect(itemTableValue(fixture.stateDbPath, APPLICATION_USER_KEY)).toBeUndefined()

    // 键缺失（上一轮已清/全新安装）：照常切换，不崩不写
    const second = await fixture.switcherFor().switchAccount(fixture.input())
    expect(second.switched).toBe(true)
    expect(itemTableValue(fixture.stateDbPath, APPLICATION_USER_KEY)).toBeUndefined()
  })

  it('leaves applicationUser untouched when resetTraces is disabled', async () => {
    const db = new DatabaseSync(fixture.stateDbPath)
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
      .run(APPLICATION_USER_KEY, JSON.stringify({ dashboardUserId: 1, composerState: { yoloEnableRunEverything: true } }))
    db.close()
    await fixture.switcherFor().switchAccount(fixture.input({ resetTraces: false }))
    const raw = itemTableValue(fixture.stateDbPath, APPLICATION_USER_KEY) as { value: string } | undefined
    expect(JSON.parse(raw!.value)).toEqual({ dashboardUserId: 1, composerState: { yoloEnableRunEverything: true } })
  })

  it('rejects non-JWT tokens before any process or file operation', async () => {
    await expect(fixture.switcherFor().switchAccount(fixture.input({ token: 'not-a-jwt' })))
      .rejects.toThrowError(/JWT/)
    expect(fixture.calls).toEqual([])
  })

  it('flags expired tokens in the switch result', async () => {
    const expired = makeJwt('auth0|user_old', Math.floor(1_788_000_000_000 / 1000) - 10)
    const result = await fixture.switcherFor().switchAccount(fixture.input({ token: expired }))
    expect(result.tokenExpired).toBe(true)
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/cachedSignUpType')).toEqual({ value: 'Auth_0' })
  })

  it('clears cachedSignUpType for non-auth0 subjects while writing the token', async () => {
    // google-sub：cachedSignUpType 无法确定 → 写空串（与 Cursor 运行时服务一致）
    const otherIdp = makeJwt('google-oauth2|123')
    await fixture.switcherFor().switchAccount(fixture.input({ token: otherIdp }))
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/cachedSignUpType')).toEqual({ value: '' })
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/accessToken')).toEqual({ value: otherIdp })
  })

  it('normalizes WorkosCursorSessionToken composite format (user_xxx::JWT)', async () => {
    // 网页登录/浏览器导入链路保存 user_xxx::eyJ...；state.vscdb 需要裸 JWT
    const jwt = makeJwt('auth0|user_weblogin')
    await fixture.switcherFor().switchAccount(fixture.input({ token: `user_01WEBLOGIN::${jwt}` }))
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/accessToken')).toEqual({ value: jwt })
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/refreshToken')).toEqual({ value: jwt })
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/cachedSignUpType')).toEqual({ value: 'Auth_0' })
  })

  it('clears cachedEmail when it cannot be derived from the account label', async () => {
    await fixture.switcherFor().switchAccount(fixture.input({ email: undefined }))
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/cachedEmail')).toEqual({ value: '' })
  })

  it('treats pgrep exit code 1 as definitively not running and skips the kill chain', async () => {
    const switcher = new CursorAccountSwitcher({
      stateDatabasePath: fixture.stateDbPath,
      storageJsonPath: fixture.storageJsonPath,
      machineIdPath: fixture.machineIdPath,
      execFn: async (file, args) => {
        fixture.calls.push([file, ...args].join(' '))
        if (file === 'pgrep') {
          const error = new Error('pgrep: no matching processes') as Error & { code?: number }
          error.code = 1
          throw error
        }
        return { stdout: '' }
      },
      sleep: async () => { fixture.bumpClock() },
      now: () => fixture.clockNow()
    })

    const result = await switcher.switchAccount(fixture.input())
    expect(result.killedCursor).toBe(false)
    expect(fixture.calls.some((call) => call.startsWith('pkill'))).toBe(false)
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/accessToken')).toEqual({ value: fixture.input().token })
  })

  it('aborts without any write when the Cursor process state cannot be determined', async () => {
    const switcher = new CursorAccountSwitcher({
      stateDatabasePath: fixture.stateDbPath,
      storageJsonPath: fixture.storageJsonPath,
      machineIdPath: fixture.machineIdPath,
      platform: () => 'darwin',
      execFn: async (file, args) => {
        fixture.calls.push([file, ...args].join(' '))
        if (file === 'pgrep') throw new Error('spawn pgrep ETIMEDOUT')
        return { stdout: '' }
      },
      sleep: async () => { fixture.bumpClock() },
      now: () => fixture.clockNow()
    })

    // 无法证明 Cursor 已死 → 中止切换，绝不带不确定状态写库（卡死根因回归防线）
    await expect(switcher.switchAccount(fixture.input())).rejects.toThrowError(/无法确认/)
    expect(itemTableValue(fixture.stateDbPath, 'cursorAuth/accessToken')).toEqual({ value: 'old-token' })
    expect(readFileSync(fixture.machineIdPath, 'utf8')).toBe('old-machine-guid')
  })

  it('relaunches Cursor after a mid-switch write failure so the editor is not left dead', async () => {
    // 预置一个存在但非 SQLite 的「数据库」：kill 链正常执行，事务开启即失败
    const root = mkdtempSync(join(tmpdir(), 'qingtian-account-switcher-corrupt-'))
    const corruptDbPath = join(root, 'state.vscdb')
    writeFileSync(corruptDbPath, 'this is definitely not a sqlite database', 'utf8')

    let launchCount = 0
    let alive = true
    const switcher = new CursorAccountSwitcher({
      stateDatabasePath: corruptDbPath,
      storageJsonPath: join(root, 'storage.json'),
      machineIdPath: join(root, 'machineid'),
      platform: () => 'darwin',
      execFn: async (file, args) => {
        fixture.calls.push([file, ...args].join(' '))
        if (file === 'pgrep') return { stdout: alive ? '424242\n' : '' }
        if (file === 'pkill') { alive = false; return { stdout: '' } }
        if (file === 'open') launchCount += 1
        return { stdout: '' }
      },
      sleep: async () => { fixture.bumpClock() },
      now: () => fixture.clockNow()
    })

    // 写库失败必须上抛（用户看到失败），但 Cursor 已被我们杀死 → 必须先尽力拉起
    await expect(switcher.switchAccount(fixture.input())).rejects.toThrowError()
    expect(launchCount).toBe(1)
    expect(fixture.calls.some((call) => call.startsWith('open '))).toBe(true)
  })

  it('guards against concurrent switches', async () => {
    const switcher = fixture.switcherFor()
    const first = switcher.switchAccount(fixture.input())
    await expect(switcher.switchAccount(fixture.input())).rejects.toThrowError(/正在进行/)
    await first
  })

  it('requires the state database to exist', async () => {
    const switcher = new CursorAccountSwitcher({
      stateDatabasePath: join(fixture.root, 'missing.vscdb'),
      platform: () => 'darwin',
      execFn: async () => ({ stdout: '' }),
      sleep: async () => undefined
    })
    await expect(switcher.switchAccount(fixture.input())).rejects.toThrowError(/不存在/)
    expect(existsSync(join(fixture.root, 'missing.vscdb'))).toBe(false)
  })
})
