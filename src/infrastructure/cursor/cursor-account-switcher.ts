import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { CursorMachineIdentity } from './cursor-machine-identity'
import type { CursorRuntimeAccountBridgePort } from './cursor-runtime-account-bridge'
import {
  CursorDesktopTokenExchanger,
  type CursorDesktopTokenExchangePort
} from './cursor-desktop-token-exchanger'
import { buildCursorWindowsStartArgs, resolveCursorWindowsExecutable } from './cursor-windows-launch'

const execFileAsync = promisify(execFile)

/** 主进程死亡后、写库前的静置时长（孤儿 Helper/utility 进程 flush 收尾窗口）。 */
const POST_EXIT_SETTLE_MS = 1_200

type CursorStateValue = string | number | bigint | Uint8Array | null

export interface CursorAccountSwitchInput {
  /** 目标账号 Token：允许 cursor.com type=web JWT，切换前会兑换为 IDE type=session JWT。 */
  token: string
  /** 缓存邮箱（可选，提升 Cursor 侧显示一致性）。 */
  email?: string
  /** 账号绑定的机器码身份（调用方负责生成/回放）。 */
  identity: CursorMachineIdentity
  /** 是否清理上一账号痕迹（默认 true，FlyCursor 一键换号推荐路径）。 */
  resetTraces?: boolean
}

export interface CursorAccountSwitchResult {
  switched: boolean
  /** 切换前 Cursor 是否在运行（true = 本轮执行了终止链）。 */
  killedCursor: boolean
  /** 拉起结果：cdp = 带调试端口、plain = 普通拉起、failed = 拉起失败（登录态已写入）。 */
  relaunchMode: 'cdp' | 'plain' | 'failed'
  /** CDP 端口是否在时限内就绪（仅 relaunchMode=cdp 时存在；false = 会话创建需再等或手动重启）。 */
  cdpPortReady?: boolean
  machineIdentityApplied: boolean
  /** 逻辑备份目录（备份失败时缺省）。 */
  backupDir?: string
  tokenExpiresAt?: number
  tokenExpired?: boolean
  /** Cursor authenticationService 已在运行时读回目标账号，并完成 storage flush。 */
  runtimeVerified: boolean
}

/**
 * 一键切换 Cursor 账号（逆向 FlyCursor「一键换号」，2026-08-29 本机实证）。
 *
 * 与旧「先写库后重启」路径的本质区别——时序倒转：
 *   ① 确定性杀掉 Cursor（pkill 广播 → pgrep 轮询确认 → pkill -9 兜底）
 *   ② Cursor 死透后独占写 state.vscdb（无锁竞争，同步 API 毫秒级完成，
 *      不再出现「Cursor 运行中抢写锁 → node:sqlite 同步阻塞 → 拾光主进程假死」）
 *   ③ 重置机器码身份（machineid 文件 + storage.serviceMachineId + storage.json 遥测 4 键）
 *   ④ 拉起 Cursor（auto-heal 开启时附带 --remote-debugging-port，保住拾光 CDP 能力）
 *
 * 实证依据：machineid 文件 mtime 与账号 onboardingDate 仅差 4 秒（同一轮换号写入痕迹）；
 * FlyCursor bytecode 含完整 pkill/pgrep/SQL 常量链。
 */
export class CursorAccountSwitcher {
  private inFlight?: Promise<CursorAccountSwitchResult>

  constructor(private readonly options: {
    stateDatabasePath?: string
    storageJsonPath?: string
    machineIdPath?: string
    /** 拉起 Cursor 时附带的 CDP 端口（undefined = 普通拉起）。 */
    cdpPort?: () => number | undefined
    /** 拉起时打开的团队工作区路径（无效路径自动忽略）。 */
    workspacePath?: () => string | undefined
    /** 进程命令注入点（测试替身）；生产执行真实 pkill/pgrep/open。 */
    execFn?: (file: string, args: string[]) => Promise<{ stdout: string }>
    /** 端口探测注入点（测试替身）。 */
    fetchFn?: (url: string) => Promise<{ status: number }>
    /** 拉起后等待 CDP 端口就绪的时限（默认 30s）。 */
    portReadyTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    /** 平台注入点（测试替身）；生产取 node:os。 */
    platform?: () => NodeJS.Platform
    /** Cursor Companion 运行时换号桥；生产必传，测试可省略。 */
    runtimeBridge?: CursorRuntimeAccountBridgePort
    /** 网页 Token → IDE session Token 兑换器（测试注入点）。 */
    tokenExchanger?: CursorDesktopTokenExchangePort
  } = {}) {}

  private get platform(): () => NodeJS.Platform {
    return this.options.platform ?? platform
  }

  private get exec(): (file: string, args: string[]) => Promise<{ stdout: string }> {
    return this.options.execFn ?? ((file, args) => execFileAsync(file, args, {
      encoding: 'utf8',
      timeout: 5_000
    }))
  }

  private get sleep(): (ms: number) => Promise<void> {
    return this.options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  private get now(): () => number {
    return this.options.now ?? Date.now
  }

  async switchAccount(input: CursorAccountSwitchInput): Promise<CursorAccountSwitchResult> {
    if (this.inFlight) throw new Error('账号切换正在进行，请等待当前操作完成')
    const operation = this.switchAccountOnce(input)
    this.inFlight = operation
    try {
      return await operation
    } finally {
      if (this.inFlight === operation) this.inFlight = undefined
    }
  }

  private async switchAccountOnce(input: CursorAccountSwitchInput): Promise<CursorAccountSwitchResult> {
    const rawToken = input.token.trim()
    if (rawToken.length < 8 || rawToken.length > 8_192) throw new Error('Cursor Token 长度无效')
    // 网页登录/浏览器导入链路保存的是 WorkosCursorSessionToken（user_xxx::eyJ...）；
    // state.vscdb 的 cursorAuth/accessToken 实值为裸 JWT，写入前必须归一化。
    const sourceJwt = rawToken.replace(/^user_[A-Za-z0-9]+::/, '')
    if (sourceJwt.split('.').length !== 3) throw new Error('Cursor Token 格式无效：必须是 JWT 三段式')

    const stateDbPath = this.resolveStateDatabasePath()
    if (!existsSync(stateDbPath)) {
      throw new Error(`Cursor 配置文件不存在：${stateDbPath}。请先启动一次 Cursor 客户端。`)
    }

    // 浏览器导入拿到的是 type=web，会让 Cursor 设置页显示已登录/Pro，但 AI 后端拒绝。
    // 在杀进程和改库之前，先按 Cursor 自身 PKCE 流程兑换 type=session；
    // 兑换失败保持 Cursor 与本地数据库原样（零副作用失败）。
    const tokens = await (this.options.tokenExchanger ?? new CursorDesktopTokenExchanger())
      .resolve(rawToken, stateDbPath)
    const token = tokens.accessToken

    // ① 确定性退出：不确认死透不动数据库（旧路径卡死根因）。
    const killedCursor = await this.killCursor()
    // 主进程死亡 ≠ 孤儿 Helper/utility 进程停止 flush state.vscdb（Chromium 收尸有
    // 窗口）；写库前静置，关闭最后一格写竞争窗口。
    if (killedCursor) await this.sleep(POST_EXIT_SETTLE_MS)

    // ②③④ 任何一步失败且 Cursor 已被我们杀死时，必须尽力拉起 Cursor 再抛错——
    // 事务回滚保证旧登录态完整，部分失败的 sane 终态是「Cursor 复活 + 旧账号」，
    // 而不是把用户的编辑器留在死亡状态。
    let backupDir: string | undefined
    try {
      // ② 逻辑备份（Cursor 已死，读库无竞争；恒为 KB 级，不复制可能巨大的主库文件）。
      backupDir = this.backupTouchedState(stateDbPath)

      // ③ 认证 + 机器码写入。
      this.applyDatabaseState(stateDbPath, tokens, input)
      this.applyStorageJson(input.identity)
      this.applyMachineIdFile(input.identity.machineGuid)
    } catch (error) {
      if (killedCursor) await this.launchCursor()
      throw error
    }

    // ④ 拉起后必须再走 Cursor 内部 authenticationService：仅离线改库会在启动阶段
    // 被旧运行时状态覆盖。Companion 回执同时证明目标 Token 已被当前进程读回并 flush。
    const userId = decodeJwtSubject(token)
    let relaunchMode: CursorAccountSwitchResult['relaunchMode']
    let runtimeVerified = false
    if (this.options.runtimeBridge) {
      const applied = await this.options.runtimeBridge.applyAfterLaunch({
        accessToken: token,
        refreshToken: tokens.refreshToken,
        email: input.email?.trim() || undefined,
        signUpType: isAuth0Token(token) ? 'Auth_0' : '',
        userId
      }, async () => {
        const mode = await this.launchCursor()
        if (mode === 'failed') throw new Error('Cursor 拉起失败，运行时账号尚未切换')
        return mode
      })
      relaunchMode = applied.launchResult
      if (!applied.ack.success) {
        throw new Error(`Cursor 运行时拒绝账号切换：${applied.ack.reason || 'unknown'}`)
      }
      this.verifyDatabaseAccount(stateDbPath, userId, tokens.runtimeType)
      runtimeVerified = true
    } else {
      relaunchMode = await this.launchCursor()
    }
    const cdpPortReady = relaunchMode === 'cdp'
      ? await this.waitForCdpPort(this.options.cdpPort?.())
      : undefined

    const expiresAt = decodeJwtExpiry(token)
    return {
      switched: true,
      killedCursor,
      relaunchMode,
      cdpPortReady,
      machineIdentityApplied: true,
      backupDir,
      tokenExpiresAt: expiresAt,
      tokenExpired: expiresAt !== undefined ? expiresAt * 1000 <= this.now() : undefined,
      runtimeVerified
    }
  }

  // ── 进程生命周期 ────────────────────────────────────────────────

  private cursorProcessName(): string {
    return this.platform() === 'win32' ? 'Cursor.exe' : 'Cursor'
  }

  /** pgrep/tasklist 探测主进程是否存活。 */
  private async cursorRunning(): Promise<boolean> {
    if (this.platform() === 'win32') {
      try {
        const { stdout } = await this.exec('tasklist', ['/NH', '/FI', `IMAGENAME eq ${this.cursorProcessName()}`])
        return stdout.includes(this.cursorProcessName())
      } catch (error) {
        // 部分 tasklist 版本对过滤器无匹配返回退出码 1（同 pgrep 语义 = 确定未运行）；
        // 其他失败（超时/命令被策略禁用）意味着无法证明 Cursor 已死——必须中止切换，
        // 绝不带不确定的进程状态写 state.vscdb（macOS 侧同款冻结防线，win 对齐）。
        if ((error as { code?: unknown } | null)?.code === 1) return false
        throw new Error(`无法确认 Cursor 进程状态，已中止切换：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      const { stdout } = await this.exec('pgrep', ['-x', this.cursorProcessName()])
      return stdout.trim().length > 0
    } catch (error) {
      // pgrep 退出码 1 = 确定无匹配进程。其他失败（超时/命令缺失）意味着无法证明
      // Cursor 已死——必须中止切换，绝不带着不确定的进程状态写 state.vscdb
      // （「Cursor 运行中抢写锁冻结主进程」卡死根因的回归防线）。
      if ((error as { code?: unknown } | null)?.code === 1) return false
      throw new Error(`无法确认 Cursor 进程状态，已中止切换：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * FlyCursor 同款终止链：SIGTERM 广播（pkill 命中全部主进程）→ 轮询确认 →
   * SIGKILL 兜底 → 仍存活即失败。返回「此前是否在运行」。
   */
  private async killCursor(): Promise<boolean> {
    const running = await this.cursorRunning()
    if (!running) return false
    const name = this.cursorProcessName()
    if (this.platform() === 'win32') {
      await this.exec('taskkill', ['/F', '/IM', name])
    } else {
      await this.exec('pkill', ['-x', name])
    }
    if (!(await this.waitForExit(10_000))) {
      if (this.platform() !== 'win32') await this.exec('pkill', ['-9', '-x', name])
      if (!(await this.waitForExit(3_000))) {
        throw new Error('Cursor 未能在限定时间内退出；请手动关闭 Cursor 后重试')
      }
    }
    return true
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    while (this.now() < deadline) {
      if (!(await this.cursorRunning())) return true
      await this.sleep(300)
    }
    return !(await this.cursorRunning())
  }

  /** 拉起 Cursor；CDP 端口可用时附带调试参数，保住拾光会话创建能力。 */
  private async launchCursor(): Promise<'cdp' | 'plain' | 'failed'> {
    try {
      if (this.platform() === 'darwin') {
        const port = this.options.cdpPort?.()
        const workspace = this.validWorkspacePath(this.options.workspacePath?.())
        const args = ['-a', 'Cursor']
        if (workspace) args.push(workspace)
        if (port) {
          args.push(
            '--args',
            `--remote-debugging-port=${port}`,
            '--disable-features=LocalNetworkAccessChecks'
          )
        }
        // macOS LaunchServices 在应用刚退出时可能短暂返回 -609；按固定上限重试，
        // 避免“数据库已切换但 Cursor 没重新打开”的半成功状态。
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            await this.exec('open', args)
            return port ? 'cdp' : 'plain'
          } catch {
            if (attempt === 4) return 'failed'
            await this.sleep(800)
          }
        }
        return 'failed'
      }
      if (this.platform() === 'win32') {
        const port = this.options.cdpPort?.()
        const workspace = this.validWorkspacePath(this.options.workspacePath?.())
        // cmd start 立即返回（不等待 GUI 进程），经 this.exec 走注入链可测试；
        // 与 mac 侧对齐：CDP 端口可用时附带调试参数，保住切换后的会话创建能力。
        await this.exec('cmd.exe', buildCursorWindowsStartArgs({
          executable: resolveCursorWindowsExecutable(),
          workspacePath: workspace,
          cdpPort: port
        }))
        return port ? 'cdp' : 'plain'
      }
      return 'failed'
    } catch {
      // 拉起失败不影响已写入的登录态，用户可手动启动。
      return 'failed'
    }
  }

  /**
   * 拉起后轮询 CDP 端口就绪（/json/version 2xx）。超时不视为切换失败——登录态已
   * 写入；调用方（含 auto-heal 看门，配合抑制窗口）决定是否需要进一步动作。
   */
  private async waitForCdpPort(port: number | undefined): Promise<boolean> {
    if (!port) return false
    const fetchFn = this.options.fetchFn ?? defaultFetchWithTimeout
    const timeoutMs = this.options.portReadyTimeoutMs ?? 30_000
    const deadline = this.now() + timeoutMs
    while (this.now() < deadline) {
      try {
        const response = await fetchFn(`http://127.0.0.1:${port}/json/version`)
        if (response.status >= 200 && response.status < 300) return true
      } catch {
        // 端口尚未就绪，继续等待
      }
      await this.sleep(500)
    }
    try {
      const response = await fetchFn(`http://127.0.0.1:${port}/json/version`)
      return response.status >= 200 && response.status < 300
    } catch {
      return false
    }
  }

  private validWorkspacePath(input: string | undefined): string | undefined {
    const path = input?.trim()
    if (!path) return undefined
    try {
      return existsSync(path) && statSync(path).isDirectory() ? path : undefined
    } catch {
      return undefined
    }
  }

  // ── 路径解析 ────────────────────────────────────────────────────

  private resolveCursorBaseDir(): string {
    if (this.platform() === 'win32') {
      const appData = process.env.APPDATA
      if (!appData) throw new Error('无法获取本机 Cursor 配置：环境变量 APPDATA 未设置')
      return join(appData, 'Cursor')
    }
    if (this.platform() === 'darwin') {
      return join(homedir(), 'Library', 'Application Support', 'Cursor')
    }
    return join(homedir(), '.config', 'Cursor')
  }

  private resolveStateDatabasePath(): string {
    return this.options.stateDatabasePath
      ?? join(this.resolveCursorBaseDir(), 'User', 'globalStorage', 'state.vscdb')
  }

  private resolveStorageJsonPath(): string {
    return this.options.storageJsonPath
      ?? join(dirname(this.resolveStateDatabasePath()), 'storage.json')
  }

  private resolveMachineIdPath(): string {
    return this.options.machineIdPath ?? join(this.resolveCursorBaseDir(), 'machineid')
  }

  // ── 备份与写入 ──────────────────────────────────────────────────

  /** 逻辑备份全部将被改写/删除的键 + storage.json / machineid 原文件。 */
  private backupTouchedState(stateDbPath: string): string | undefined {
    try {
      const backupDir = join(dirname(stateDbPath), 'backups', `account-switch-${this.now()}`)
      mkdirSync(backupDir, { recursive: true })
      // applicationUser 现为外科手术式改写（不再整删），必须进备份集。
      const touched: string[] = [...new Set([...AUTH_UPSERT_KEYS, ...TRACE_DELETE_KEYS, ...STALE_DELETE_KEYS, APPLICATION_USER_KEY])]
      const rows = this.readItemTable(stateDbPath, touched)
      const keyBackup = new DatabaseSync(join(backupDir, 'itemtable.sqlite3'))
      try {
        keyBackup.exec(`
          CREATE TABLE backup_meta (source_path TEXT NOT NULL, created_at INTEGER NOT NULL);
          CREATE TABLE item_table_backup (key TEXT PRIMARY KEY, value, existed INTEGER NOT NULL CHECK (existed IN (0, 1)));
        `)
        keyBackup.prepare('INSERT INTO backup_meta (source_path, created_at) VALUES (?, ?)')
          .run(stateDbPath, this.now())
        const insert = keyBackup.prepare(
          'INSERT INTO item_table_backup (key, value, existed) VALUES (?, ?, ?)'
        )
        for (const key of touched) {
          const row = rows.find((candidate) => candidate.key === key)
          insert.run(key, row ? row.value : null, row ? 1 : 0)
        }
      } finally {
        keyBackup.close()
      }
      const storageJsonPath = this.resolveStorageJsonPath()
      if (existsSync(storageJsonPath)) copyFileSync(storageJsonPath, join(backupDir, 'storage.json'))
      const machineIdPath = this.resolveMachineIdPath()
      if (existsSync(machineIdPath)) copyFileSync(machineIdPath, join(backupDir, 'machineid'))
      return backupDir
    } catch {
      // 备份失败不阻断切换（键值均为可再生或用户可重录数据）。
      return undefined
    }
  }

  private readItemTable(stateDbPath: string, keys: string[]): { key: string; value: CursorStateValue }[] {
    let db: DatabaseSync | undefined
    try {
      // 读写模式打开：Cursor 被 SIGKILL 兜底后 WAL 可能残留未检查点帧，
      // readOnly 连接无法创建 -shm 做恢复，会读空集导致备份失真。
      db = new DatabaseSync(stateDbPath, { timeout: 2_000 })
      const placeholders = keys.map(() => '?').join(', ')
      return db.prepare(`SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`)
        .all(...keys) as { key: string; value: CursorStateValue }[]
    } catch {
      return []
    } finally {
      try {
        db?.close()
      } catch {
        // ignore
      }
    }
  }

  /** 认证 + 机器码 + 痕迹清理，单事务原子落库（Cursor 已死，独占无竞争）。 */
  private applyDatabaseState(
    stateDbPath: string,
    tokens: { accessToken: string; refreshToken: string },
    input: CursorAccountSwitchInput
  ): void {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(stateDbPath, { timeout: 5_000 })
      db.exec('BEGIN IMMEDIATE')
      try {
        const upsert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
        const remove = db.prepare('DELETE FROM ItemTable WHERE key = ?')

        upsert.run('cursorAuth/accessToken', tokens.accessToken)
        upsert.run('cursorAuth/refreshToken', tokens.refreshToken)
        // 与当前 Cursor authenticationService 一致：未知值写空串，不保留上一账号。
        const email = input.email?.trim()
        if (email) upsert.run('cursorAuth/cachedEmail', email)
        else upsert.run('cursorAuth/cachedEmail', '')
        if (isAuth0Token(tokens.accessToken)) upsert.run('cursorAuth/cachedSignUpType', 'Auth_0')
        else upsert.run('cursorAuth/cachedSignUpType', '')
        const userId = decodeJwtSubject(tokens.accessToken)
        upsert.run('cursorAuth/userId', userId)
        upsert.run('cursorAuth/cachedUserId', userId)
        upsert.run('cursorAuth/authId', userId)
        upsert.run('storage.serviceMachineId', input.identity.machineGuid)

        // 陈旧运行时缓存/服务端下发值：删除后由 Cursor 按新登录态重建
        // （实证：cursor.accessToken 与当前 JWT sub 不一致时登录仍正常）。
        for (const key of STALE_DELETE_KEYS) remove.run(key)
        if (input.resetTraces !== false) {
          for (const key of TRACE_DELETE_KEYS) remove.run(key)
          this.stripApplicationUserAccountTraces(db)
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
        // ignore
      }
    }
  }

  /**
   * applicationUser 外科手术式清痕（同一事务内）：只删账号身份字段、保留设备级
   * 偏好（工具放行/对话框决策/编辑器偏好）。键缺失＝上一轮已清或全新安装，跳过；
   * 值损坏/非对象＝无法安全摘除，回退为整键删除（旧行为，宁失偏好不留脏数据）。
   */
  private stripApplicationUserAccountTraces(db: DatabaseSync): void {
    const remove = db.prepare('DELETE FROM ItemTable WHERE key = ?')
    let row: { value?: unknown } | undefined
    try {
      row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(APPLICATION_USER_KEY) as { value?: unknown } | undefined
    } catch {
      return
    }
    if (row?.value === undefined || row?.value === null) return
    const text = typeof row.value === 'string'
      ? row.value
      : row.value instanceof Uint8Array
        ? Buffer.from(row.value).toString('utf8')
        : ''
    // 空串/非文本值与损坏 JSON 同处置：无法安全摘除即整键删除（旧行为），
    // 不给未知形态的账号痕迹留静默存活的缝。
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      remove.run(APPLICATION_USER_KEY)
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      remove.run(APPLICATION_USER_KEY)
      return
    }
    const root = parsed as Record<string, unknown>
    let changed = false
    for (const field of APPLICATION_USER_ACCOUNT_TRACE_FIELDS) {
      if (field in root) {
        delete root[field]
        changed = true
      }
    }
    if (!changed) return
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
      .run(APPLICATION_USER_KEY, JSON.stringify(root))
  }

  /** storage.json 遥测 4 键重写（原子替换；文件缺失则创建最小骨架）。 */
  private applyStorageJson(identity: CursorMachineIdentity): void {
    const path = this.resolveStorageJsonPath()
    let current: Record<string, unknown> = {}
    if (existsSync(path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
        // 仅接受普通对象：数组/标量等异常内容交回 Cursor 自行重建，不覆盖。
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
        current = parsed as Record<string, unknown>
      } catch {
        // 主文件损坏时不覆盖，交给 Cursor 自行重建。
        return
      }
    }
    current['telemetry.machineId'] = identity.machineId
    current['telemetry.macMachineId'] = identity.macMachineId
    current['telemetry.devDeviceId'] = identity.devDeviceId
    current['telemetry.sqmId'] = identity.sqmId
    const temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(current, null, 2), 'utf8')
    renameSync(temporary, path)
  }

  /** machineid 文件与 state.vscdb 的 storage.serviceMachineId 恒同值（实证）。 */
  private applyMachineIdFile(machineGuid: string): void {
    const path = this.resolveMachineIdPath()
    try {
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.tmp`
      writeFileSync(temporary, machineGuid, 'utf8')
      renameSync(temporary, path)
    } catch {
      // 文件不可写不阻断（storage.serviceMachineId 已落库）。
    }
  }

  /** Companion flush 后再次从 Cursor 主库验证目标账号，杜绝“按钮报成功但仍是旧号”。 */
  private verifyDatabaseAccount(stateDbPath: string, expectedUserId: string, expectedTokenType: string): void {
    const db = new DatabaseSync(stateDbPath, { readOnly: true, timeout: 2_000 })
    try {
      const rows = db.prepare(
        "SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken', 'cursorAuth/refreshToken')"
      ).all() as { key: string; value: unknown }[]
      const actual = new Map(rows.map((row) => [row.key, typeof row.value === 'string' ? row.value : '']))
      const access = actual.get('cursorAuth/accessToken') ?? ''
      const refresh = actual.get('cursorAuth/refreshToken') ?? ''
      if (decodeJwtSubject(access) !== expectedUserId
        || decodeJwtSubject(refresh) !== expectedUserId
        || (expectedTokenType === 'session' && (decodeJwtType(access) !== 'session' || decodeJwtType(refresh) !== 'session'))) {
        throw new Error('Cursor 运行时回执后账号落库校验不一致')
      }
    } finally {
      db.close()
    }
  }
}

/** 认证写入键（FlyCursor 实证集；不含 cursor.accessToken——Cursor 自行维护该运行时缓存）。 */
const AUTH_UPSERT_KEYS = [
  'cursorAuth/accessToken',
  'cursorAuth/refreshToken',
  'cursorAuth/cachedEmail',
  'cursorAuth/cachedSignUpType',
  'cursorAuth/userId',
  'cursorAuth/cachedUserId',
  'cursorAuth/authId',
  'storage.serviceMachineId'
] as const

/** 上一账号痕迹（FlyCursor isResetCursor 清理集，Cursor 登录后按服务端真相重建）。 */
const TRACE_DELETE_KEYS = [
  'aiCodeTrackingLines',
  'aiCodeTrackingStartTime',
  'aiSettings',
  'cursorai/serverConfig',
  'cursorupdate.lastUpdatedAndShown.version',
  'isUsagePricingEnabled',
  'lastUpgradeToProNotificationTime',
  'releaseNotes/lastVersion'
] as const

/**
 * applicationUser（reactiveStorage 持久层）里的账号身份字段：服务端在登录后重推，
 * 删除即可切断账号关联。其余字段是设备级本机偏好（服务端不会重建）——尤其
 * composerState 装着全部工具放行偏好（yoloEnableRunEverything / mcpAllowedTools /
 * modes4[].autoRun），整键删除会让每次切换回到工厂默认，自动化管道的每个 MCP
 * 调用都弹人工审批，无人值守即死锁（2026-09-01 P0 实证）。
 */
const APPLICATION_USER_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'
const APPLICATION_USER_ACCOUNT_TRACE_FIELDS = [
  'dashboardUserId',
  'membershipType',
  'subscriptionStatus',
  'hasAutoSpillover',
  'hasTieredSelfServeTeamSpillover',
  'hasTokenBasedPricing',
  'isEnterprise',
  'eligibleForSnippetLearning',
  'authenticationSettings',
  'teamAdminSettings',
  'teamBlockRepos',
  'teamBlocklist',
  'newUserData',
  'aiSettings',
  'availableDefaultModels2',
  'featureModelConfigs'
] as const

/** 陈旧缓存键：随账号切换必须删除（写错格式比留旧值更糟）。 */
const STALE_DELETE_KEYS = [
  'cursor.accessToken',
  'cursor.email',
  'cursorAuth/isAuthenticated',
  'cursorAuth/isAuthorized',
  'cursorAuth/isLoggedIn',
  'cursorAuth/stripeSubscriptionStatus',
  'cursorAuth/stripeMembershipType',
  'cursorAuth/onboardingDate'
] as const

/** 端口探测默认实现：带 AbortController 超时，端口无响应时快速失败而非挂起。 */
async function defaultFetchWithTimeout(url: string): Promise<{ status: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return { status: response.status }
  } finally {
    clearTimeout(timer)
  }
}

/** JWT sub 以 auth0| 开头时，cachedSignUpType 固定为 Auth_0（本机实证值）。 */
function isAuth0Token(token: string): boolean {
  return decodeJwtSubject(token).startsWith('auth0|')
}

function decodeJwtSubject(token: string): string {
  try {
    const payload = token.split('.')[1]
    if (!payload) throw new Error('missing_payload')
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const parsed = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as { sub?: unknown }
    if (typeof parsed.sub !== 'string' || !parsed.sub.trim()) throw new Error('missing_sub')
    return parsed.sub.trim()
  } catch {
    throw new Error('Cursor Token 缺少有效账号标识')
  }
}

/** 解码 JWT exp（秒级时间戳）；无法解析返回 undefined。 */
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

function decodeJwtType(token: string): string | undefined {
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { type?: unknown }
    return typeof parsed.type === 'string' ? parsed.type : undefined
  } catch {
    return undefined
  }
}
