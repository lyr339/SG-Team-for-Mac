import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AozaiCardVault } from '../src/application/aozai-card-vault'
import { AozaiService, type AozaiFetch } from '../src/application/aozai-service'
import type { CursorAccountVaultCrypto } from '../src/application/cursor-account-vault'

const crypto: CursorAccountVaultCrypto = {
  available: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${value}`).reverse(),
  decrypt: (value) => Buffer.from(value).reverse().toString().replace(/^encrypted:/, '')
}

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

interface StubResponse {
  ok?: boolean
  status: number
  data?: unknown
  setCookie?: string[]
}

function createFetch(queue: StubResponse[], calls: RecordedCall[]): AozaiFetch {
  return async (url, init) => {
    const next = queue.shift()
    if (!next) throw new Error('fetch 队列已空')
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined
    })
    return {
      ok: next.ok ?? (next.status >= 200 && next.status < 300),
      status: next.status,
      json: async () => next.data,
      getSetCookie: () => next.setCookie ?? []
    }
  }
}

function createContext(queue: StubResponse[]) {
  const calls: RecordedCall[] = []
  const path = join(mkdtempSync(join(tmpdir(), 'qingtian-aozai-')), 'card.json')
  const vault = new AozaiCardVault(path, crypto, () => 123)
  const service = new AozaiService(vault, createFetch(queue, calls), { pollIntervalMs: 0, sleep: async () => {} })
  return { calls, path, vault, service }
}

const LOGIN_OK: StubResponse = {
  status: 200,
  data: { ok: true, card_code: 'CARD-XXXX-6l8Q', type: '50次卡', remaining: 46 },
  setCookie: ['session=abc123; Path=/; HttpOnly']
}

describe('AozaiCardVault', () => {
  it('加密落盘且可读取明文，权限 0o600', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-aozai-card-')), 'card.json')
    const vault = new AozaiCardVault(path, crypto, () => 123)
    expect(vault.maskedCode()).toBeUndefined()
    expect(vault.save('CARD-SECRET-6l8Q')).toBe('••••6l8Q')
    expect(vault.maskedCode()).toBe('••••6l8Q')
    expect(readFileSync(path, 'utf8')).not.toContain('CARD-SECRET-6l8Q')
    // POSIX 权限位断言只在类 Unix 平台生效：Windows 的 statSync 恒报 0666
    // （Node 仅映射只读位，无 0600 语义）；macOS 行为不变。
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(vault.credential()).toBe('CARD-SECRET-6l8Q')
    vault.clear()
    expect(vault.maskedCode()).toBeUndefined()
  })

  it('拒绝过短卡密', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-aozai-card-')), 'card.json')
    const vault = new AozaiCardVault(path, crypto)
    expect(() => vault.save('abc')).toThrowError(/卡密长度无效/)
  })

  it('系统钥匙变化时返回可操作提示而不是暴露 safeStorage 底层异常', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-aozai-card-')), 'card.json')
    const vault = new AozaiCardVault(path, crypto)
    vault.save('CARD-SECRET-6l8Q')
    const unreadable = new AozaiCardVault(path, {
      ...crypto,
      decrypt: () => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.') }
    })
    expect(() => unreadable.credential()).toThrowError(/重新粘贴卡密/)
    expect(() => unreadable.credential()).not.toThrowError(/safeStorage/)
  })
})

describe('AozaiService', () => {
  it('verifyCard 走登录接口并返回余额', async () => {
    const { service, calls } = createContext([LOGIN_OK])
    const info = await service.verifyCard('CARD-XXXX-6l8Q')
    expect(info).toEqual({ type: '50次卡', remaining: 46 })
    expect(calls[0]).toMatchObject({
      url: 'https://getdoubao.com/api/v1/auth/login',
      method: 'POST',
      body: { card_code: 'CARD-XXXX-6l8Q' }
    })
  })

  it('卡密错误时抛出服务端 detail', async () => {
    const { service } = createContext([{ status: 200, data: { ok: false, detail: '卡密不存在或已停用' } }])
    await expect(service.verifyCard('BAD')).rejects.toThrowError(/卡密不存在或已停用/)
  })

  it('processToken 完整流程：登录→提交→轮询→完成，并携带会话 Cookie', async () => {
    const { service, vault, calls } = createContext([
      LOGIN_OK,
      { status: 200, data: { operation_id: 'op-1' } },
      { status: 200, data: { status: 'processing', steps: [{ status: 'ok', message: '验证账号' }] } },
      { status: 200, data: { status: 'completed', steps: [{ status: 'ok', message: '写入完成' }] } },
      { status: 200, data: { ok: true, card_code: 'CARD-XXXX-6l8Q', type: '50次卡', remaining: 45 } }
    ])
    vault.save('CARD-XXXX-6l8Q')
    const progress: string[] = []
    const result = await service.processToken('user_123::jwt', (state, message) => progress.push(`${state}:${message}`))
    expect(result).toEqual({ ok: true, message: '处理成功', remaining: 45 })
    expect(calls[1]).toMatchObject({
      url: 'https://getdoubao.com/api/v1/process',
      method: 'POST',
      body: { session_token: 'user_123::jwt' }
    })
    expect(calls[1]?.headers.Cookie).toBe('session=abc123')
    expect(calls[2]?.url).toBe('https://getdoubao.com/api/v1/operations/op-1')
    expect(progress).toContain('processing:验证账号')
  })

  it('维护中时返回维护提示且不轮询', async () => {
    const { service, vault, calls } = createContext([
      LOGIN_OK,
      { status: 200, data: { maintenance: true, message: '系统维护升级中' } }
    ])
    vault.save('CARD-XXXX-6l8Q')
    const result = await service.processToken('user_123::jwt')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('系统维护升级中')
    expect(calls).toHaveLength(2)
  })

  it('提交 401 时重新登录并重试一次', async () => {
    const { service, vault, calls } = createContext([
      LOGIN_OK,
      { status: 401, data: { detail: '未登录' } },
      LOGIN_OK,
      { status: 200, data: { operation_id: 'op-2' } },
      { status: 200, data: { status: 'completed', steps: [] } },
      { status: 200, data: { ok: true, type: '50次卡', remaining: 44 } }
    ])
    vault.save('CARD-XXXX-6l8Q')
    const result = await service.processToken('user_123::jwt')
    expect(result.ok).toBe(true)
    expect(calls.filter((call) => call.url.endsWith('/auth/login'))).toHaveLength(3)
  })

  it('处理失败时取失败步骤的 message', async () => {
    const { service, vault } = createContext([
      LOGIN_OK,
      { status: 200, data: { operation_id: 'op-3' } },
      { status: 200, data: { status: 'failed', steps: [{ status: 'ok', message: '验证账号' }, { status: 'fail', message: 'Token 已过期' }] } },
      { status: 200, data: { ok: true, type: '50次卡', remaining: 46 } }
    ])
    vault.save('CARD-XXXX-6l8Q')
    const result = await service.processToken('user_123::jwt')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Token 已过期')
    expect(result.message).toContain('退还')
  })

  it('轮询网络错误超过上限后失败', async () => {
    const queue: StubResponse[] = [
      LOGIN_OK,
      { status: 200, data: { operation_id: 'op-4' } },
      ...Array.from({ length: 5 }, () => ({ status: 0, ok: false }) as StubResponse)
    ]
    const calls: RecordedCall[] = []
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-aozai-')), 'card.json')
    const vault = new AozaiCardVault(path, crypto)
    vault.save('CARD-XXXX-6l8Q')
    const failingFetch: AozaiFetch = async (url, init) => {
      if (url.includes('/operations/')) throw new Error('socket hang up')
      const next = queue.shift()
      if (!next) throw new Error('fetch 队列已空')
      calls.push({ url, method: init.method, headers: init.headers })
      return {
        ok: true,
        status: next.status,
        json: async () => next.data,
        getSetCookie: () => next.setCookie ?? []
      }
    }
    const service = new AozaiService(vault, failingFetch, { pollIntervalMs: 0, sleep: async () => {} })
    const result = await service.processToken('user_123::jwt')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('网络错误')
  })

  it('warmup 预热后 processToken 跳过重复登录直接提交', async () => {
    const { service, vault, calls } = createContext([
      LOGIN_OK,
      { status: 200, data: { operation_id: 'op-9' } },
      { status: 200, data: { status: 'completed', steps: [] } },
      { status: 200, data: { ok: true, type: '50次卡', remaining: 45 } }
    ])
    vault.save('CARD-XXXX-6l8Q')
    await service.warmup()
    const result = await service.processToken('user_123::jwt')
    expect(result.ok).toBe(true)
    // 全程仅 warmup 的一次登录（末尾 refreshRemaining 一次），处理前不再重复登录
    const logins = calls.filter((call) => call.url.endsWith('/auth/login'))
    expect(logins).toHaveLength(2)
    expect(calls[1]?.url).toBe('https://getdoubao.com/api/v1/process')
  })

  it('refreshRemaining:false 时完成即返回，省去末尾登录', async () => {
    const { service, vault, calls } = createContext([
      LOGIN_OK,
      { status: 200, data: { operation_id: 'op-10' } },
      { status: 200, data: { status: 'completed', steps: [] } }
    ])
    vault.save('CARD-XXXX-6l8Q')
    const result = await service.processToken('user_123::jwt', () => {}, { refreshRemaining: false })
    expect(result).toEqual({ ok: true, message: '处理成功' })
    expect(result.remaining).toBeUndefined()
    expect(calls.filter((call) => call.url.endsWith('/auth/login'))).toHaveLength(1)
  })

  it('并发处理被拒绝', async () => {
    const { service, vault } = createContext([
      LOGIN_OK,
      { status: 200, data: { operation_id: 'op-5' } },
      { status: 200, data: { status: 'completed', steps: [] } },
      { status: 200, data: { ok: true, type: '50次卡', remaining: 45 } }
    ])
    vault.save('CARD-XXXX-6l8Q')
    const first = service.processToken('user_123::jwt')
    await expect(service.processToken('user_123::jwt')).rejects.toThrowError(/进行中/)
    await first
  })
})
