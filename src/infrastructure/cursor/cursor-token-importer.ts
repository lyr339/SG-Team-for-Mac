import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cursorUserDataRoot } from './cursor-install-paths'

export interface ImportedCursorAccount {
  /** 从 Cursor 本地 state.vscdb 读到的完整 access token（JWT）。 */
  token: string
  /** Cursor 缓存的登录邮箱（如果有）。 */
  email?: string
  /** JWT payload 中的用户唯一标识（Cursor 的 auth0 user id）。 */
  sub?: string
}

export class CursorTokenImporter {
  private resolveCursorStateDatabasePath(): string {
    return join(cursorUserDataRoot(), 'User', 'globalStorage', 'state.vscdb')
  }

  private bufferToString(value: unknown): string | undefined {
    if (typeof value === 'string') return value
    if (value instanceof Buffer) return value.toString('utf8')
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
    if (Array.isArray(value)) return Buffer.from(value).toString('utf8')
    return undefined
  }

  private decodeJwtSub(token: string): string | undefined {
    const parts = token.split('.')
    if (parts.length !== 3) return undefined
    const payloadBase64 = parts[1]
    if (!payloadBase64) return undefined
    try {
      const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8'))
      return typeof payload.sub === 'string' ? payload.sub : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 从本机 Cursor 的 state.vscdb 读取当前登录账号的 access token。
   * Cursor 在 macOS/Windows/Linux 上均将 token 以明文 JWT 形式存放在
   * `ItemTable` 表的 `cursorAuth/accessToken` 键中。
   */
  import(): ImportedCursorAccount {
    const dbPath = this.resolveCursorStateDatabasePath()
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, open: false })
      db.open()

      const accessToken = this.readKey(db, 'cursorAuth/accessToken')
      if (!accessToken) {
        throw new Error(
          `未在 Cursor 配置文件中找到 access token。请先在 Cursor 客户端登录一次：${dbPath}`
        )
      }

      const email = this.readKey(db, 'cursorAuth/cachedEmail') || undefined
      const sub = this.decodeJwtSub(accessToken)

      return { token: accessToken, email, sub }
    } catch (error) {
      if (error instanceof Error) throw error
      throw new Error(`读取 Cursor 本地 token 失败：${String(error)}`)
    } finally {
      try {
        db?.close()
      } catch {
        // ignore close errors
      }
    }
  }

  private readKey(db: DatabaseSync, key: string): string | undefined {
    // state.vscdb 使用 VSCode globalStorage 的 ItemTable schema：key/value 两列。
    const statement = db.prepare('SELECT value FROM ItemTable WHERE key = ?')
    const row = statement.get(key) as { value: unknown } | undefined
    if (!row || row.value === undefined || row.value === null) return undefined
    return this.bufferToString(row.value)
  }
}
