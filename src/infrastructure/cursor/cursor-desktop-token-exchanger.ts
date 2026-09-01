import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const APPLICATION_USER_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'

/**
 * 兑换端点生产常量（本机 state.vscdb 历史备份实证值）。
 * applicationUser 键属于账号切换的痕迹清理集（TRACE_DELETE_KEYS）：每次成功切换
 * 都会删除它，只有 Cursor 正常运行一段时间后才重建。键缺失或损坏时回落到这对
 * 端点继续兑换——否则上一次成功的切换会永久埋葬下一次切换。
 */
const FALLBACK_WEBSITE_URL = 'https://cursor.com'
const FALLBACK_BACKEND_URL = 'https://api2.cursor.sh'

interface CursorJwtClaims {
  sub?: unknown
  type?: unknown
  exp?: unknown
}

export interface CursorDesktopTokenPair {
  accessToken: string
  refreshToken: string
  sourceType: string
  runtimeType: string
  exchanged: boolean
}

export interface CursorDesktopTokenExchangePort {
  resolve(token: string, stateDatabasePath: string): Promise<CursorDesktopTokenPair>
}

export interface CursorDesktopTokenExchangerOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  pollIntervalMs?: number
  now?: () => number
}

function jwtClaims(token: string): CursorJwtClaims {
  try {
    const payload = bareJwt(token).split('.')[1]
    if (!payload) return {}
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CursorJwtClaims
  } catch {
    return {}
  }
}

function bareJwt(token: string): string {
  return token.trim().replace(/^user_[A-Za-z0-9]+::/, '')
}

function claimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 将 cursor.com 浏览器 Cookie 内层的 type=web JWT 兑换为 Cursor IDE 后端接受的
 * type=session JWT。网页 Token 足以显示账号/档位，却会被 api*.cursor.sh 的 AI、
 * Filesync、索引等服务统一判定 unauthenticated。真实 Cursor 登录采用 PKCE：
 * loginDeepControl 页面确认当前网页账号，再从 /auth/poll 领取 IDE access/refresh Token。
 */
export class CursorDesktopTokenExchanger implements CursorDesktopTokenExchangePort {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly pollIntervalMs: number
  private readonly now: () => number

  constructor(options: CursorDesktopTokenExchangerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.pollIntervalMs = options.pollIntervalMs ?? 500
    this.now = options.now ?? Date.now
  }

  async resolve(token: string, stateDatabasePath: string): Promise<CursorDesktopTokenPair> {
    const sourceClaims = jwtClaims(token)
    const sourceType = claimText(sourceClaims.type) || 'unknown'
    if (sourceType !== 'web') {
      const runtimeToken = bareJwt(token)
      return {
        accessToken: runtimeToken,
        refreshToken: runtimeToken,
        sourceType,
        runtimeType: sourceType,
        exchanged: false
      }
    }

    const sourceSubject = claimText(sourceClaims.sub)
    if (!sourceSubject) throw new Error('Cursor 网页 Token 缺少账号标识')
    const credentials = this.readCredentials(stateDatabasePath)
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const uuid = randomUUID()
    // loginDeepControl 的“Sign in”按钮最终只做这一条带网页 Cookie 的确认请求。
    // 直接复用账号自身 WorkosCursorSessionToken，避免把 Edge 账号错误路由到 Roxy，
    // 也避免任何浏览器页面、Cloudflare/block 页与 UI 自动点击依赖。
    const confirmUrl = new URL('/api/auth/loginDeepCallbackControl', credentials.websiteUrl)
    let confirm: Response
    try {
      confirm = await this.fetchImpl(confirmUrl.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `WorkosCursorSessionToken=${encodeURIComponent(token.trim())}`
        },
        body: JSON.stringify({ uuid, challenge }),
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 8_000))
      })
    } catch (error) {
      throw new Error(`Cursor IDE 登录确认失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!confirm.ok) {
      const detail = (await confirm.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 120)
      throw new Error(`Cursor IDE 登录确认被拒：HTTP ${confirm.status}${detail ? ` · ${detail}` : ''}`)
    }

    const deadline = this.now() + this.timeoutMs
    let payload: { accessToken?: unknown; refreshToken?: unknown; error?: unknown } | undefined
    while (this.now() < deadline) {
      let response: Response
      try {
        const pollUrl = new URL('/auth/poll', credentials.backendUrl)
        pollUrl.search = new URLSearchParams({ uuid, verifier }).toString()
        response = await this.fetchImpl(pollUrl.toString(), { signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5_000)) })
      } catch (error) {
        throw new Error(`Cursor IDE 登录结果轮询失败：${error instanceof Error ? error.message : String(error)}`)
      }
      if (response.status === 404) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs))
        continue
      }
      payload = await response.json().catch(() => undefined) as typeof payload
      if (!response.ok) {
        throw new Error(`Cursor IDE 登录结果被拒：${claimText(payload?.error) || `HTTP ${response.status}`}`)
      }
      break
    }
    const accessToken = claimText(payload?.accessToken)
    const refreshToken = claimText(payload?.refreshToken)
    const runtimeClaims = jwtClaims(accessToken)
    const runtimeType = claimText(runtimeClaims.type) || 'unknown'
    const runtimeSubject = claimText(runtimeClaims.sub)
    const refreshClaims = jwtClaims(refreshToken)
    if (!accessToken || !refreshToken || runtimeType !== 'session' || claimText(refreshClaims.type) !== 'session') {
      throw new Error(`Cursor 网页会话兑换结果无效：期望 type=session，实际 ${runtimeType || 'missing'}`)
    }
    if (!sourceSubject || runtimeSubject !== sourceSubject) {
      throw new Error('Cursor 网页会话兑换结果账号不一致')
    }
    const expiresAt = typeof runtimeClaims.exp === 'number' ? runtimeClaims.exp * 1_000 : undefined
    if (expiresAt !== undefined && expiresAt <= this.now()) {
      throw new Error('Cursor 网页会话兑换得到的 IDE Token 已过期')
    }
    return {
      accessToken,
      refreshToken,
      sourceType,
      runtimeType,
      exchanged: true
    }
  }

  private readCredentials(stateDatabasePath: string): { websiteUrl: string; backendUrl: string } {
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(stateDatabasePath, { readOnly: true, timeout: 2_000 })
      const row = database.prepare('SELECT value FROM ItemTable WHERE key = ?').get(APPLICATION_USER_KEY) as { value?: unknown } | undefined
      const text = typeof row?.value === 'string'
        ? row.value
        : row?.value instanceof Uint8Array
          ? Buffer.from(row.value).toString('utf8')
          : ''
      const root = text ? JSON.parse(text) as {
        cursorCreds?: { websiteUrl?: unknown; backendUrl?: unknown }
      } : undefined
      const websiteUrl = claimText(root?.cursorCreds?.websiteUrl).replace(/\/+$/, '')
      const backendUrl = claimText(root?.cursorCreds?.backendUrl).replace(/\/+$/, '')
      const website = new URL(websiteUrl)
      const backend = new URL(backendUrl)
      if (![website.protocol, backend.protocol].every((protocol) => ['https:', 'http:'].includes(protocol))) {
        throw new Error('missing_credentials')
      }
      return { websiteUrl, backendUrl }
    } catch {
      // 兑换只读端点、不写库：任何读取失败（键被痕迹清理删除 / 内容损坏 / 打不开）
      // 都回落生产端点，让兑换请求本身去给出真实的对错。
      return { websiteUrl: FALLBACK_WEBSITE_URL, backendUrl: FALLBACK_BACKEND_URL }
    } finally {
      try {
        database?.close()
      } catch {
        // ignore
      }
    }
  }
}
