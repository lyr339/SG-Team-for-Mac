import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CursorAccountVaultCrypto } from './cursor-account-vault'

interface AozaiCardFile {
  version: 1
  encryptedCode: string
  codeSuffix: string
  updatedAt: number
}

export const AOZAI_CREDENTIAL_UNREADABLE_MESSAGE = '已保存的奥仔卡密读取失败；应用升级期间系统加密钥匙发生变化，请重新粘贴卡密后验证'

export class AozaiCardVault {
  constructor(
    readonly path: string,
    private readonly crypto: CursorAccountVaultCrypto,
    private readonly now: () => number = Date.now
  ) {}

  maskedCode(): string | undefined {
    const card = this.load()
    return card ? `••••${card.codeSuffix}` : undefined
  }

  save(cardCode: string): string {
    this.assertEncryption()
    const code = cardCode.trim()
    if (code.length < 6 || code.length > 200) throw new Error('卡密长度无效')
    this.store({
      version: 1,
      encryptedCode: this.crypto.encrypt(code).toString('base64'),
      codeSuffix: code.slice(-4),
      updatedAt: this.now()
    })
    return `••••${code.slice(-4)}`
  }

  credential(): string {
    this.assertEncryption()
    const card = this.load()
    if (!card) throw new Error('尚未保存奥仔卡密')
    try {
      return this.crypto.decrypt(Buffer.from(card.encryptedCode, 'base64'))
    } catch {
      throw new Error(AOZAI_CREDENTIAL_UNREADABLE_MESSAGE)
    }
  }

  clear(): void {
    try {
      if (existsSync(this.path)) rmSync(this.path)
    } catch {
      // 文件不存在或权限不足时视为已清除
    }
  }

  private assertEncryption(): void {
    if (!this.crypto.available()) throw new Error('macOS 系统凭据加密当前不可用')
  }

  private load(): AozaiCardFile | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AozaiCardFile>
      if (parsed.version !== 1) return undefined
      if (typeof parsed.encryptedCode !== 'string' || typeof parsed.codeSuffix !== 'string') return undefined
      if (typeof parsed.updatedAt !== 'number') return undefined
      return { version: 1, encryptedCode: parsed.encryptedCode, codeSuffix: parsed.codeSuffix, updatedAt: parsed.updatedAt }
    } catch {
      return undefined
    }
  }

  private store(card: AozaiCardFile): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(card, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
  }
}
