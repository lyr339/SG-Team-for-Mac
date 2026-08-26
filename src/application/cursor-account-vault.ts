import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CursorAccountMetadata } from '../domain/cursor-account'

export interface CursorAccountVaultCrypto {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

interface StoredCursorAccount {
  id: string
  label: string
  encryptedToken: string
  tokenSuffix: string
  createdAt: number
  updatedAt: number
}

interface CursorAccountVaultFile {
  version: 1
  activeId?: string
  accounts: StoredCursorAccount[]
}

const EMPTY_VAULT: CursorAccountVaultFile = { version: 1, accounts: [] }

export class CursorAccountVault {
  constructor(
    readonly path: string,
    private readonly crypto: CursorAccountVaultCrypto,
    private readonly now: () => number = Date.now
  ) {}

  list(): CursorAccountMetadata[] {
    const vault = this.load()
    return vault.accounts.map((account) => ({
      id: account.id,
      label: account.label,
      maskedToken: `••••${account.tokenSuffix}`,
      active: account.id === vault.activeId,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt
    }))
  }

  save(input: { label: string; token: string; makeActive?: boolean }): CursorAccountMetadata[] {
    this.assertEncryption()
    const label = input.label.trim()
    const token = input.token.trim()
    if (!label || label.length > 80) throw new Error('账号备注必须为 1–80 个字符')
    if (token.length < 8 || token.length > 8_192) throw new Error('Cursor Token 长度无效')
    const vault = this.load()
    const at = this.now()
    const account: StoredCursorAccount = {
      id: `cursor-account:${randomUUID()}`,
      label,
      encryptedToken: this.crypto.encrypt(token).toString('base64'),
      tokenSuffix: token.slice(-4),
      createdAt: at,
      updatedAt: at
    }
    vault.accounts.push(account)
    if (input.makeActive !== false || !vault.activeId) vault.activeId = account.id
    this.store(vault)
    return this.list()
  }

  select(accountId: string): CursorAccountMetadata[] {
    const vault = this.load()
    const id = accountId.trim()
    if (!vault.accounts.some((account) => account.id === id)) throw new Error('Cursor 账号不存在')
    vault.activeId = id
    this.store(vault)
    return this.list()
  }

  /** 原地更新账号 token（保留 id/备注/选中态），供自动化流程刷新凭据。 */
  replaceToken(accountId: string, token: string): CursorAccountMetadata[] {
    this.assertEncryption()
    const id = accountId.trim()
    const next = token.trim()
    if (next.length < 8 || next.length > 8_192) throw new Error('Cursor Token 长度无效')
    const vault = this.load()
    const account = vault.accounts.find((candidate) => candidate.id === id)
    if (!account) throw new Error('Cursor 账号不存在')
    account.encryptedToken = this.crypto.encrypt(next).toString('base64')
    account.tokenSuffix = next.slice(-4)
    account.updatedAt = this.now()
    this.store(vault)
    return this.list()
  }

  remove(accountId: string): CursorAccountMetadata[] {
    const vault = this.load()
    const id = accountId.trim()
    const next = vault.accounts.filter((account) => account.id !== id)
    if (next.length === vault.accounts.length) throw new Error('Cursor 账号不存在')
    vault.accounts = next
    if (vault.activeId === id) vault.activeId = next[0]?.id
    this.store(vault)
    return this.list()
  }

  credential(accountId?: string): string {
    this.assertEncryption()
    const vault = this.load()
    const id = accountId?.trim() || vault.activeId
    const account = vault.accounts.find((candidate) => candidate.id === id)
    if (!account) throw new Error('尚未选择 Cursor 账号')
    return this.crypto.decrypt(Buffer.from(account.encryptedToken, 'base64'))
  }

  private assertEncryption(): void {
    if (!this.crypto.available()) throw new Error('macOS 系统凭据加密当前不可用')
  }

  private load(): CursorAccountVaultFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CursorAccountVaultFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) return structuredClone(EMPTY_VAULT)
      return {
        version: 1,
        activeId: typeof parsed.activeId === 'string' ? parsed.activeId : undefined,
        accounts: parsed.accounts.filter((account): account is StoredCursorAccount => Boolean(
          account && typeof account.id === 'string' && typeof account.label === 'string'
          && typeof account.encryptedToken === 'string' && typeof account.tokenSuffix === 'string'
          && typeof account.createdAt === 'number' && typeof account.updatedAt === 'number'
        ))
      }
    } catch {
      return structuredClone(EMPTY_VAULT)
    }
  }

  private store(vault: CursorAccountVaultFile): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(vault, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
  }
}
