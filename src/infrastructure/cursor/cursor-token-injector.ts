import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { execSync } from 'node:child_process'
import { existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { CursorHotSwap } from './cursor-hot-swap'

export interface InjectCursorTokenInput {
  /** 要注入的完整 access token（JWT）。 */
  token: string
  /** 可选：缓存邮箱（提升 Cursor 侧显示一致性）。 */
  email?: string
  /** 可选：注入前备份原 token。 */
  backup?: boolean
  /** 可选：尝试热切换（无需重启）。 */
  hotSwap?: boolean
  /**
   * 可选：注入后重启 Cursor 使登录态生效。
   * 默认 false——重启会关闭所有 Cursor 窗口并断开其中承载的 qunshu MCP 通道，
   * 必须由用户显式确认后才允许（UI 层负责确认弹窗）。
   */
  restart?: boolean
}

export interface InjectCursorTokenResult {
  /** 是否成功写入。 */
  injected: boolean
  /** 备份文件路径（如果启用备份）。 */
  backupPath?: string
  /** 是否需要重启 Cursor 生效。 */
  requiresRestart: boolean
  /** 检测到的 Cursor 进程 ID（如果正在运行）。 */
  cursorPid?: number
  /** 热切换是否成功（仅在 hotSwap=true 时有效）。 */
  hotSwapped?: boolean
  /** 是否按用户显式要求执行了重启（restart=true 且 Cursor 在运行）。 */
  restartPerformed?: boolean
  /** 热切换失败原因（hotSwap 尝试但未成功时给出，供 UI 如实展示）。 */
  hotSwapFailure?: string
  /** 注入的 token 过期时间（秒级时间戳；无法解析时缺省）。 */
  tokenExpiresAt?: number
  /** token 在注入时已过期。 */
  tokenExpired?: boolean
}

/** 解码 JWT payload 的 exp（秒级时间戳）；无法解析返回 undefined。只读，无副作用。 */
function decodeJwtExpiry(token: string): number | undefined {
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const parsed = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as { exp?: unknown }
    return typeof parsed.exp === 'number' && Number.isFinite(parsed.exp) ? parsed.exp : undefined
  } catch {
    return undefined
  }
}

export class CursorTokenInjector {
  constructor(private readonly options: { stateDatabasePath?: string } = {}) {}

  private resolveCursorStateDatabasePath(): string {
    if (this.options.stateDatabasePath) return this.options.stateDatabasePath
    const system = platform()
    let base: string
    switch (system) {
      case 'darwin':
        base = join(homedir(), 'Library', 'Application Support', 'Cursor')
        break
      case 'win32': {
        const appData = process.env.APPDATA
        if (!appData) throw new Error('无法获取本机 Cursor 配置：环境变量 APPDATA 未设置')
        base = join(appData, 'Cursor')
        break
      }
      default:
        base = join(homedir(), '.config', 'Cursor')
    }
    return join(base, 'User', 'globalStorage', 'state.vscdb')
  }

  private resolveCursorProcessName(): string {
    return platform() === 'win32' ? 'Cursor.exe' : 'Cursor'
  }

  /**
   * 检测 Cursor 是否正在运行，返回进程 ID。
   */
  private detectCursorProcess(): number | undefined {
    try {
      const processName = this.resolveCursorProcessName()
      if (platform() === 'win32') {
        // Windows: 使用 tasklist
        const output = execSync(`tasklist /FI "IMAGENAME eq ${processName}" /FO CSV /NH`, { encoding: 'utf8' })
        const lines = output.trim().split('\n').filter((line) => line.includes(processName))
        if (lines.length > 0) {
          const match = lines[0]?.match(/"(\d+)"/)
          return match ? parseInt(match[1]!, 10) : undefined
        }
      } else {
        // macOS/Linux: 使用 pgrep
        const output = execSync(`pgrep -x "${processName}"`, { encoding: 'utf8' }).trim()
        const pid = parseInt(output.split('\n')[0]!, 10)
        return Number.isFinite(pid) ? pid : undefined
      }
    } catch {
      return undefined
    }
  }

  /**
   * 优雅重启 Cursor（先尝试正常退出，再启动）。
   * 等待进程退出用异步轮询——Atomics.wait 会冻结主进程事件循环，
   * 最长 5s 内群枢界面整体无响应（backend 审查发现的缺陷）。
   */
  private async restartCursor(pid?: number): Promise<void> {
    const processName = this.resolveCursorProcessName()
    try {
      if (pid) {
        // 先尝试正常退出
        if (platform() === 'win32') {
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
        } else {
          execSync(`kill -TERM ${pid}`, { stdio: 'ignore' })
        }
        // 异步轮询等待进程退出（每 500ms 一次，最多 10 次；不冻结事件循环）
        let attempts = 0
        while (attempts < 10 && this.detectCursorProcess()) {
          await new Promise<void>((resolve) => setTimeout(resolve, 500))
          attempts += 1
        }
      }
      // 启动 Cursor
      if (platform() === 'darwin') {
        execSync('open -a Cursor', { stdio: 'ignore' })
      } else if (platform() === 'win32') {
        execSync(`start "" "${processName}"`, { stdio: 'ignore', shell: 'cmd.exe' })
      } else {
        execSync(processName.toLowerCase(), { stdio: 'ignore' })
      }
    } catch {
      // 重启失败不影响注入结果，用户可手动重启
    }
  }

  /**
   * 将 token 注入 Cursor 的 state.vscdb。
   *
   * 安全机制：
   * 1. 写入前自动备份原数据库（默认启用）
   * 2. 使用事务确保原子性
   * 3. 验证 token 格式（JWT 三段式）
   * 4. 默认不重启 Cursor——重启会断开全部群枢通道，只有调用方显式
   *    传 restart=true（用户已在 UI 确认）时才执行
   */
  async inject(input: InjectCursorTokenInput): Promise<InjectCursorTokenResult> {
    const token = input.token.trim()
    if (!token || token.length < 8 || token.length > 8_192) {
      throw new Error('Cursor Token 长度无效')
    }
    // 验证 JWT 格式（三段式）
    const parts = token.split('.')
    if (parts.length !== 3) {
      throw new Error('Cursor Token 格式无效：必须是 JWT 三段式')
    }

    const dbPath = this.resolveCursorStateDatabasePath()
    if (!existsSync(dbPath)) {
      throw new Error(`Cursor 配置文件不存在：${dbPath}。请先启动一次 Cursor 客户端。`)
    }

    // 备份原数据库（默认启用）
    let backupPath: string | undefined
    if (input.backup !== false) {
      const backupDir = join(dirname(dbPath), 'backups')
      mkdirSync(backupDir, { recursive: true })
      backupPath = join(backupDir, `state.vscdb.backup-${Date.now()}`)
      copyFileSync(dbPath, backupPath)
    }

    // 检测 Cursor 进程
    const cursorPid = this.detectCursorProcess()

    // 写入 token：Cursor 认证态分布在多个 key，漏写会导致重启后回登录页。
    // 本机实证：cursorAuth/accessToken 与 cursorAuth/refreshToken 同值（JWT 即刷新凭证），
    // cursor.accessToken 为运行时读取的独立 key，三者必须同时写入。
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(dbPath, { timeout: 5_000 })
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('BEGIN IMMEDIATE')
      try {
        const upsert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
        upsert.run('cursorAuth/accessToken', token)
        upsert.run('cursorAuth/refreshToken', token)
        upsert.run('cursor.accessToken', token)

        // 可选：写入缓存邮箱
        if (input.email?.trim()) {
          upsert.run('cursorAuth/cachedEmail', input.email.trim())
        }

        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } finally {
      try {
        db?.close()
      } catch {
        // ignore close errors
      }
    }

    // 尝试热切换（无需重启）。CDP 需 Cursor 以 --remote-debugging-port 启动，
    // 默认未开启时必然失败——失败只如实上报，绝不自动重启（重启会断开全部群枢通道）。
    let hotSwapped = false
    let hotSwapFailure: string | undefined
    if (input.hotSwap !== false && cursorPid) {
      const hotSwap = new CursorHotSwap()
      const swapResult = await hotSwap.swap({ token, email: input.email })
      hotSwapped = swapResult.ok
      if (!swapResult.ok) hotSwapFailure = swapResult.message
    } else if (input.hotSwap !== false && !cursorPid) {
      hotSwapFailure = 'Cursor 未在运行，跳过热切换'
    }

    // 重启生效：仅当调用方显式传入 restart=true（UI 已完成用户确认）才执行。
    const restartPerformed = Boolean(input.restart && cursorPid && !hotSwapped)
    if (restartPerformed) {
      await this.restartCursor(cursorPid)
    }

    const expiresAt = decodeJwtExpiry(token)
    return {
      injected: true,
      backupPath,
      requiresRestart: !hotSwapped,
      cursorPid,
      hotSwapped,
      restartPerformed,
      hotSwapFailure,
      tokenExpiresAt: expiresAt,
      tokenExpired: expiresAt !== undefined ? expiresAt * 1000 <= Date.now() : undefined
    }
  }

  /**
   * 检查注入是否成功（验证读取）。
   * 三个 token key 必须同时存在且同值——缺任何一个，重启后都会回登录页。
   */
  verify(): boolean {
    const dbPath = this.resolveCursorStateDatabasePath()
    if (!existsSync(dbPath)) return false
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 300 })
      const rows = db.prepare(
        `SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken', 'cursorAuth/refreshToken', 'cursor.accessToken')`
      ).all() as { key: string; value: unknown }[]
      if (rows.length < 3) return false
      const values = rows.map((row) => row.value)
      return values.every((value) => typeof value === 'string' && value === values[0])
    } catch {
      return false
    } finally {
      try {
        db?.close()
      } catch {
        // ignore
      }
    }
  }
}
