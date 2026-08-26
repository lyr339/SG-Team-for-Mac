import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { CursorTokenInjector } from '../src/infrastructure/cursor/cursor-token-injector'

function makeJwt(expSeconds: number): string {
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment({ exp: expSeconds, aud: 'https://cursor.com' })}.signature`
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'qingtian-injector-'))
  const dbPath = join(dir, 'state.vscdb')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
  db.close()
  return { dir, dbPath, injector: new CursorTokenInjector({ stateDatabasePath: dbPath }) }
}

function readKeys(dbPath: string): Map<string, string> {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare('SELECT key, value FROM ItemTable').all() as { key: string; value: string }[]
    return new Map(rows.map((row) => [row.key, row.value]))
  } finally {
    db.close()
  }
}

describe('CursorTokenInjector', () => {
  it('写全三个 token key 且同值（漏写会导致重启后回登录页）', async () => {
    const { dbPath, injector } = fixture()
    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600)
    const result = await injector.inject({ token, hotSwap: false })
    expect(result.injected).toBe(true)
    const keys = readKeys(dbPath)
    expect(keys.get('cursorAuth/accessToken')).toBe(token)
    expect(keys.get('cursorAuth/refreshToken')).toBe(token)
    expect(keys.get('cursor.accessToken')).toBe(token)
    expect(injector.verify()).toBe(true)
  })

  it('默认不重启 Cursor（restartPerformed 缺省），且如实报告需要重启', async () => {
    const { injector } = fixture()
    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600)
    const result = await injector.inject({ token, hotSwap: false })
    expect(result.restartPerformed).toBe(false)
    expect(result.requiresRestart).toBe(true)
    expect(result.hotSwapped).toBe(false)
  })

  it('默认启用备份；backup=false 时不生成备份目录', async () => {
    const { dir, injector } = fixture()
    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600)
    const first = await injector.inject({ token, hotSwap: false })
    expect(first.backupPath).toBeTruthy()
    const second = await injector.inject({ token, hotSwap: false, backup: false })
    expect(second.backupPath).toBeUndefined()
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1)
  })

  it('识别过期 token 并如实上报，不阻断写入', async () => {
    const { injector } = fixture()
    const expired = await injector.inject({ token: makeJwt(1_600_000_000), hotSwap: false })
    expect(expired.injected).toBe(true)
    expect(expired.tokenExpired).toBe(true)
    expect(expired.tokenExpiresAt).toBe(1_600_000_000)
    const valid = await injector.inject({ token: makeJwt(Math.floor(Date.now() / 1000) + 3600), hotSwap: false })
    expect(valid.tokenExpired).toBe(false)
  })

  it('verify 在三 key 缺失或不一致时返回 false', async () => {
    const { dbPath, injector } = fixture()
    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600)
    expect(injector.verify()).toBe(false)
    await injector.inject({ token, hotSwap: false })
    expect(injector.verify()).toBe(true)
    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run('tampered', 'cursor.accessToken')
    db.close()
    expect(injector.verify()).toBe(false)
  })

  it('拒绝非 JWT 三段式 token', async () => {
    const { injector } = fixture()
    await expect(injector.inject({ token: 'not-a-jwt', hotSwap: false })).rejects.toThrowError(/JWT/)
  })
})
