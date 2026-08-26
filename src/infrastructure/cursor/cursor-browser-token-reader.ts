import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface BrowserCursorToken {
  token: string
  userId: string
  browser: string
}

interface BrowserProfile {
  name: string
  cookiePath: string
  keychainService: string
  keychainAccount: string
}

const COOKIE_NAME = 'WorkosCursorSessionToken'
const HOST = 'cursor.com'
const CHROMIUM_SALT = 'saltysalt'
const CHROMIUM_ITERATIONS = 1003

/**
 * 从本机 Chromium 内核浏览器的 Cookie 数据库中读取 `WorkosCursorSessionToken`
 * （`user_xxx::eyJ...` 格式）。
 *
 * 数据来源与解密（与浏览器一致）：
 *  - Cookie 存于 `<profile>/Cookies`（SQLite），value 为 `v10` + IV + AES-128-CBC 密文；
 *  - 加密密码存于 macOS Keychain（`<Browser> Safe Storage`）；
 *  - 实际加密密钥 = PBKDF2-HMAC-SHA1(password, salt='saltysalt', iterations=1003, dkLen=16)。
 */
export class CursorBrowserTokenReader {
  private resolveProfiles(): BrowserProfile[] {
    const system = platform()
    if (system !== 'darwin') return []
    const home = homedir()
    const support = join(home, 'Library', 'Application Support')
    return [
      {
        name: 'Microsoft Edge',
        cookiePath: join(support, 'Microsoft Edge', 'Default', 'Cookies'),
        keychainService: 'Microsoft Edge Safe Storage',
        keychainAccount: 'Microsoft Edge'
      },
      {
        name: 'Google Chrome',
        cookiePath: join(support, 'Google', 'Chrome', 'Default', 'Cookies'),
        keychainService: 'Chrome Safe Storage',
        keychainAccount: 'Chrome'
      }
    ].filter((profile) => existsSync(profile.cookiePath))
  }

  private fetchKeychainPassword(service: string, account: string): string {
    try {
      return execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
        encoding: 'utf8',
        timeout: 10_000
      }).trim()
    } catch {
      return ''
    }
  }

  private decryptCookieValue(encrypted: Uint8Array, password: string): string | undefined {
    if (!password) return undefined
    const buf = Buffer.from(encrypted)
    // Chromium 的 v10 格式：`v10` + 16 字节 IV + AES-128-CBC 密文。
    if (buf.subarray(0, 3).toString('utf8') !== 'v10') return undefined
    const iv = buf.subarray(3, 19)
    const ciphertext = buf.subarray(19)
    if (ciphertext.length % 16 !== 0 || ciphertext.length === 0) return undefined

    const key = pbkdf2Sync(password, CHROMIUM_SALT, CHROMIUM_ITERATIONS, 16, 'sha1')
    try {
      const decipher = createDecipheriv('aes-128-cbc', key, iv)
      decipher.setAutoPadding(false)
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      // 去掉 PKCS7 padding 与明文开头的 16 字节随机前缀。
      const padLength = plain[plain.length - 1]
      if (!padLength || padLength < 1 || padLength > 16) return undefined
      const unpadded = plain.subarray(0, plain.length - padLength)
      const value = unpadded.subarray(16).toString('utf8')
      return value || undefined
    } catch {
      return undefined
    }
  }

  /** 按浏览器顺序（Edge → Chrome）尝试读取，返回第一个成功的结果。 */
  read(): BrowserCursorToken {
    const profiles = this.resolveProfiles()
    if (profiles.length === 0) {
      throw new Error('未找到 Chromium 浏览器的 Cookie 文件（当前仅支持 macOS 的 Edge / Chrome）')
    }

    let lastError = ''
    for (const profile of profiles) {
      try {
        const db = new DatabaseSync(profile.cookiePath, { readOnly: true, open: false })
        try {
          db.open()
          const row = db
            .prepare('SELECT encrypted_value FROM cookies WHERE host_key = ? AND name = ?')
            .get(HOST, COOKIE_NAME) as { encrypted_value: Uint8Array } | undefined
          if (!row) {
            lastError = `${profile.name} 中未找到 ${COOKIE_NAME}，请先在浏览器登录 cursor.com`
            continue
          }
          const password = this.fetchKeychainPassword(profile.keychainService, profile.keychainAccount)
          if (!password) {
            lastError = `无法从钥匙串读取 ${profile.name} 的加密密钥`
            continue
          }
          const raw = this.decryptCookieValue(row.encrypted_value, password)
          if (!raw) {
            lastError = `${profile.name} 的 ${COOKIE_NAME} 解密失败`
            continue
          }
          const decoded = decodeURIComponent(raw)
          const separator = decoded.indexOf('::')
          const userId = separator >= 0 ? decoded.slice(0, separator) : ''
          return { token: decoded, userId, browser: profile.name }
        } finally {
          try {
            db.close()
          } catch {
            // ignore close errors
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    throw new Error(`读取浏览器中的 Cursor Token 失败：${lastError}`)
  }
}

/** 仅用于运行时/测试可观测性（不输出 token 本身）。 */
export function summarizeBrowserToken(token: string): { userId: string; jwtLength: number; suffix: string } {
  const decoded = decodeURIComponent(token)
  const separator = decoded.indexOf('::')
  const userId = separator >= 0 ? decoded.slice(0, separator) : ''
  const jwt = separator >= 0 ? decoded.slice(separator + 2) : decoded
  return { userId, jwtLength: jwt.length, suffix: jwt.slice(-4) }
}
