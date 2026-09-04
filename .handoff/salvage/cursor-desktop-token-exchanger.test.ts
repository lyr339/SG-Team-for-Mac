import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CursorDesktopTokenExchanger } from '../src/infrastructure/cursor/cursor-desktop-token-exchanger'

function jwt(input: { sub: string; type: 'web' | 'session'; exp?: number }): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode(input)}.signature`
}

function stateDatabase(root: string): string {
  const path = join(root, 'state.vscdb')
  const database = new DatabaseSync(path)
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value)')
  database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser',
    JSON.stringify({
      cursorCreds: {
        websiteUrl: 'https://cursor.com',
        backendUrl: 'https://api2.cursor.sh',
        authClientId: 'desktop-client-id'
      }
    })
  )
  database.close()
  return path
}

describe('CursorDesktopTokenExchanger', () => {
  const roots: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('type=session 已是 IDE Token，原样返回且不发兑换请求', async () => {
    const fetchImpl = vi.fn()
    const token = jwt({ sub: 'auth0|session-user', type: 'session', exp: 2_000_000_000 })
    const result = await new CursorDesktopTokenExchanger({ fetchImpl }).resolve(token, '/missing/state.vscdb')
    expect(result).toEqual({
      accessToken: token,
      refreshToken: token,
      sourceType: 'session',
      runtimeType: 'session',
      exchanged: false
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('type=web 直接确认 PKCE callback 并从 auth/poll 领取同账号 type=session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-token-exchange-'))
    roots.push(root)
    const database = stateDatabase(root)
    const web = jwt({ sub: 'auth0|target-user', type: 'web', exp: 2_000_000_000 })
    const session = jwt({ sub: 'auth0|target-user', type: 'session', exp: 2_000_000_000 })
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => (
      new URL(String(url)).pathname === '/api/auth/loginDeepCallbackControl'
        ? new Response('OK', { status: 200 })
        : new Response(JSON.stringify({ accessToken: session, refreshToken: session }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
    ))

    await expect(new CursorDesktopTokenExchanger({ fetchImpl, now: () => 1_900_000_000_000 })
      .resolve(web, database)).resolves.toEqual({
        accessToken: session,
        refreshToken: session,
        sourceType: 'web',
        runtimeType: 'session',
        exchanged: true
      })
    const confirmationUrl = new URL(String(fetchImpl.mock.calls[0]![0]))
    expect(confirmationUrl.origin + confirmationUrl.pathname).toBe('https://cursor.com/api/auth/loginDeepCallbackControl')
    const confirmationInit = fetchImpl.mock.calls[0]![1] as RequestInit
    expect(confirmationInit.method).toBe('POST')
    expect((confirmationInit.headers as Record<string, string>).cookie).toContain(encodeURIComponent(web))
    expect(JSON.parse(String(confirmationInit.body))).toMatchObject({
      uuid: expect.any(String),
      challenge: expect.any(String)
    })
    const pollUrl = new URL(String(fetchImpl.mock.calls[1]![0]))
    expect(pollUrl.origin + pollUrl.pathname).toBe('https://api2.cursor.sh/auth/poll')
    expect(pollUrl.searchParams.get('uuid')).toBeTruthy()
    expect(pollUrl.searchParams.get('verifier')).toBeTruthy()
  })

  it('兑换仍返回 web Token 或账号 subject 改变时拒绝进入切换链', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-token-exchange-invalid-'))
    roots.push(root)
    const database = stateDatabase(root)
    const web = jwt({ sub: 'auth0|target-user', type: 'web', exp: 2_000_000_000 })
    const returnedWeb = jwt({ sub: 'auth0|target-user', type: 'web', exp: 2_000_000_000 })
    const wrongSession = jwt({ sub: 'auth0|other-user', type: 'session', exp: 2_000_000_000 })
    const responses = [returnedWeb, wrongSession]
    let responseIndex = 0
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (new URL(String(url)).pathname === '/api/auth/loginDeepCallbackControl') {
        return new Response('OK', { status: 200 })
      }
      const token = responses[responseIndex++]
      return new Response(JSON.stringify({ accessToken: token, refreshToken: token }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const exchanger = new CursorDesktopTokenExchanger({
      fetchImpl,
      now: () => 1_900_000_000_000
    })

    await expect(exchanger.resolve(web, database)).rejects.toThrow(/期望 type=session/)
    await expect(exchanger.resolve(web, database)).rejects.toThrow(/账号不一致/)
  })

  it('服务端 shouldLogout/HTTP 拒绝时保留明确兑换错误', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-token-exchange-reject-'))
    roots.push(root)
    const database = stateDatabase(root)
    const web = jwt({ sub: 'auth0|target-user', type: 'web', exp: 2_000_000_000 })
    const fetchImpl = vi.fn().mockResolvedValue(new Response('desktop authorization revoked', { status: 401 }))

    await expect(new CursorDesktopTokenExchanger({ fetchImpl }).resolve(web, database))
      .rejects.toThrow(/desktop authorization revoked/)
  })
})
