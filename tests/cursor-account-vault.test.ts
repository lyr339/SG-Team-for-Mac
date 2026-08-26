import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CursorAccountVault, type CursorAccountVaultCrypto } from '../src/application/cursor-account-vault'

const crypto: CursorAccountVaultCrypto = {
  available: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${value}`).reverse(),
  decrypt: (value) => Buffer.from(value).reverse().toString().replace(/^encrypted:/, '')
}

describe('CursorAccountVault', () => {
  it('persists only ciphertext and returns masked account metadata', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-cursor-accounts-')), 'accounts.json')
    const vault = new CursorAccountVault(path, crypto, () => 123)
    const accounts = vault.save({ label: '工作账号', token: 'cursor-secret-token-1234' })

    expect(accounts).toEqual([
      expect.objectContaining({ label: '工作账号', maskedToken: '••••1234', active: true })
    ])
    expect(readFileSync(path, 'utf8')).not.toContain('cursor-secret-token-1234')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(vault.credential()).toBe('cursor-secret-token-1234')
  })

  it('supports multiple accounts, active selection and recoverable metadata deletion', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-cursor-accounts-')), 'accounts.json')
    const vault = new CursorAccountVault(path, crypto)
    let accounts = vault.save({ label: '账号 A', token: 'cursor-token-aaaa' })
    accounts = vault.save({ label: '账号 B', token: 'cursor-token-bbbb' })
    const first = accounts.find((account) => account.label === '账号 A')!
    const second = accounts.find((account) => account.label === '账号 B')!
    expect(second.active).toBe(true)
    expect(vault.select(first.id).find((account) => account.id === first.id)?.active).toBe(true)
    expect(vault.remove(first.id)).toEqual([
      expect.objectContaining({ id: second.id, active: true })
    ])
  })

  it('refuses to persist plaintext when system encryption is unavailable', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-cursor-accounts-')), 'accounts.json')
    const vault = new CursorAccountVault(path, { ...crypto, available: () => false })
    expect(() => vault.save({ label: '账号', token: 'cursor-token-abcd' })).toThrowError(/系统凭据加密/)
  })
})
