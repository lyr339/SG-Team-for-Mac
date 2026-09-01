import WebSocket from 'ws'
import type { FingerprintBrowser } from './fingerprint-browser'
import type { AccountAutomationBrowserHost } from '../account-automation-browser-host'
import { FIRE_DELETE_JS, type InBrowserDeleteResult } from '../cursor-in-browser-account-deleter'
import {
  REQUIRED_CURSOR_MODEL_DATA_POLICIES,
  buildEnsureCursorModelDataPolicyScript,
  cursorModelDataPolicyFailureMessage,
  parseCursorModelDataPolicyConsentResult,
  type CursorModelDataPolicyConsentSuccess
} from '../cursor-model-data-policy-consent'

/**
 * 指纹浏览器账号自动化通道：用「指纹浏览器 profile + CDP」替代外部浏览器（Edge/Chrome）三件套
 * （cookie 库读取 / AppleScript 会话刷新 / 页面内秒级删除）。提供方无关——生产装配恒
 * RoxyBrowserClient（比特已全面退役），契约保留注入点供测试替身使用。
 *
 * 职责与契约（与 AccountAutomationService 的浏览器依赖同构）：
 *   - readToken()               preflight：读 profile 内 WorkosCursorSessionToken（内存级，无落盘等待）
 *   - prepareRefresh()          奥仔完成后导航刷新 dashboard（cache-bust 强制真实导航）
 *   - deleteWhenReady()         等页面就绪 + 等 token 轮换完成后，页内秒级删除
 *   - refresh(previousToken)    fallback：轮换通道（导航 + 轮询 cookie 变化，返回新 token）
 *
 * 关键领域约束（实机实证）：奥仔处理后旧 token 失效，必须先刷新页面让认证链重放、
 * token 轮换完成后才能删除——不刷新直接删除会 error。因此 deleteWhenReady 把
 * 「cookie token 已变化」作为发起删除的必要条件（超时回退 legacy 链路）。
 *
 * 提速设计：preflight 的 readToken 在倒计时前就把窗口打开并保持 CDP 连接，
 * 奥仔处理期间连接是热的；完成后直接导航，删除链全程无冷启动。
 */

export interface FingerprintCdpSocket {
  send(data: string): void
  close(): void
  onMessage(handler: (data: string) => void): void
  onError(handler: (error: Error) => void): void
  /** 连接断开（用户关窗 / 指纹浏览器退出）：与 error 同样致命，pending 全部失败。 */
  onClose(handler: () => void): void
}

export interface FingerprintAccountChannelOptions {
  /** 每次操作时解析当前提供方客户端（生产恒 Roxy；返回新实例即触发会话重开）。 */
  resolveClient: () => FingerprintBrowser
  /** 每次操作时解析当前选中的窗口 id（来自账号自动化设置，可随时切换）。 */
  resolveProfileId: () => string | undefined
  /** CDP ws 连接工厂（测试注入点）。 */
  connectSocket?: (wsUrl: string) => FingerprintCdpSocket
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** 等页面就绪（认证链重放）窗口。 */
  pageReadyTimeoutMs?: number
  /** 等 token 轮换窗口（奥仔后新 token 在认证链重放时换发）。 */
  tokenRotateTimeoutMs?: number
  /** 页内删除结果等待窗口（含 leave team 自愈 ~2.5s）。 */
  resultTimeoutMs?: number
  /** 页面持续停留在认证/登录页超过该时长 → 判定未登录。 */
  authChainGraceMs?: number
  pollIntervalMs?: number
  /** 自动导入/预检是否执行政策确认；手动确认入口不受此开关限制。 */
  shouldAcknowledgeModelDataPolicies?: () => boolean
}

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: unknown
  error?: { message: string }
}

const TOKEN_COOKIE_NAME = 'WorkosCursorSessionToken'
const CURSOR_ORIGIN = 'https://cursor.com'
/** 清理站点数据的 origin 集：官网 + WorkOS 认证链（登录流程会在此域留状态）。 */
const SITE_DATA_ORIGINS = ['https://cursor.com', 'https://authentication.cursor.sh']
const REFRESH_URL = 'https://cursor.com/dashboard'
const READINESS_JS = 'JSON.stringify({h:location.hostname,p:location.pathname,s:document.readyState})'
const POLL_RESULT_JS = "window.__qtDel||''"
const CDP_CALL_TIMEOUT_MS = 20_000

class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly handlers = new Map<string, ((params: Record<string, unknown>) => void)>()

  constructor(private readonly socket: FingerprintCdpSocket) {
    socket.onMessage((data) => {
      // 守卫：CDP 不会发非法 JSON，但 ws 层任何脏数据都不应炸掉主进程
      let message: CdpMessage
      try {
        message = JSON.parse(data) as CdpMessage
      } catch {
        return
      }
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(message.error.message))
        else entry.resolve(message.result)
        return
      }
      if (message.method) this.handlers.get(message.method)?.(message.params ?? {})
    })
    socket.onError((error) => this.failPending(error))
    // 关窗断链与 error 同样致命：不感知会让 pending 挂到超时，且死会话被永久缓存
    socket.onClose(() => this.failPending(new Error('CDP 连接已断开（窗口被关闭或指纹浏览器退出）')))
  }

  private failPending(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    this.handlers.set(method, handler)
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.nextId++
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.socket.send(JSON.stringify(payload))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 调用超时：${method}`))
      }, CDP_CALL_TIMEOUT_MS)
    }) as Promise<Record<string, unknown>>
  }

  close(): void {
    this.socket.close()
  }
}

interface ChannelSession {
  client: FingerprintBrowser
  profileId: string
  cdp: CdpConnection
  targetId: string
  sessionId: string
  /** 新建 target 初始为 about:blank；导航到官网后才允许执行同源政策接口。 */
  cursorPageOpened: boolean
}

/**
 * 生产 CDP socket 工厂：ws v8 在 CONNECTING 状态 send 直接抛
 * "WebSocket is not open: readyState 0 (CONNECTING)"——握手完成前的发送必须排队，
 * open 事件后按 FIFO 冲刷（Roxy 冷启动时 CDP 端点握手耗时可观，首条
 * Target.createTarget 几乎必然早于 open；Windows 全新装机实测命中）。
 * 握手失败/连接关闭时队列作废：pending 由 CdpConnection 的 onError/onClose 统一拒绝。
 */
export function defaultSocketFactory(wsUrl: string): FingerprintCdpSocket {
  const socket = new WebSocket(wsUrl, { handshakeTimeout: 10_000 })
  const queuedSends: string[] = []
  let open = false
  socket.on('open', () => {
    open = true
    for (const data of queuedSends.splice(0)) socket.send(data)
  })
  socket.on('close', () => {
    // 关闭后到达的发送交给 ws 抛 CLOSED 错误（会话已失效的正确语义）
    queuedSends.splice(0)
    open = false
  })
  return {
    send: (data) => {
      if (open) socket.send(data)
      else queuedSends.push(data)
    },
    close: () => socket.close(),
    onMessage: (handler) => socket.on('message', (raw) => handler(String(raw))),
    onError: (handler) => socket.on('error', handler),
    onClose: (handler) => socket.on('close', handler)
  }
}

export class FingerprintAccountChannel implements AccountAutomationBrowserHost {
  private readonly resolveClient: () => FingerprintBrowser
  private readonly resolveProfileId: () => string | undefined
  private readonly connectSocket: (wsUrl: string) => FingerprintCdpSocket
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly pageReadyTimeoutMs: number
  private readonly tokenRotateTimeoutMs: number
  private readonly resultTimeoutMs: number
  private readonly authChainGraceMs: number
  private readonly pollIntervalMs: number
  private readonly shouldAcknowledgeModelDataPolicies: () => boolean
  private session: ChannelSession | undefined
  /** 轮换基准：readToken 时缓存的旧 token；deleteWhenReady 等它变化后才发起删除。 */
  private lastKnownToken: string | undefined
  /** 成功确认缓存按账号+模型+版本隔离；dispose 清空，绝不跨 profile 生命周期继承。 */
  private readonly acknowledgedPolicyKeys = new Set<string>()
  /** 开窗进行中（含身份）：复用仅限同 client + 同 profileId——否则并发切窗会拿到错误会话。 */
  private opening: { client: FingerprintBrowser; profileId: string; promise: Promise<ChannelSession> } | undefined

  constructor(options: FingerprintAccountChannelOptions) {
    this.resolveClient = options.resolveClient
    this.resolveProfileId = options.resolveProfileId
    this.connectSocket = options.connectSocket ?? defaultSocketFactory
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
    this.pageReadyTimeoutMs = options.pageReadyTimeoutMs ?? 20_000
    this.tokenRotateTimeoutMs = options.tokenRotateTimeoutMs ?? 45_000
    this.resultTimeoutMs = options.resultTimeoutMs ?? 10_000
    this.authChainGraceMs = options.authChainGraceMs ?? 6_000
    this.pollIntervalMs = options.pollIntervalMs ?? 300
    this.shouldAcknowledgeModelDataPolicies = options.shouldAcknowledgeModelDataPolicies ?? (() => true)
  }

  private requireProfileId(): string {
    const profileId = this.resolveProfileId()
    if (!profileId) {
      throw new Error('未选择指纹浏览器窗口（请在账号管线设置里按当前网络选择「代理/直连」窗口）')
    }
    return profileId
  }

  /**
   * 打开窗口并建立 CDP 会话；已打开时复用（奥仔处理期间保持热连接）。
   * profileId 或 client 实例变化时重开（切「代理/直连」窗口走这里）。
   */
  private async ensureSession(): Promise<ChannelSession> {
    const profileId = this.requireProfileId()
    const client = this.resolveClient()
    if (this.session?.profileId === profileId && this.session.client === client) return this.session
    // 仅同身份的进行中开窗可复用：不同 profileId/client 的并发调用各自开窗，
    // 谁后完成谁覆盖 session 缓存（断链回调按实例比对，不会误删）。
    if (this.opening && this.opening.profileId === profileId && this.opening.client === client) {
      return this.opening.promise
    }
    const opening = (async (): Promise<ChannelSession> => {
      const opened = await client.openWindow(profileId)
      const socket = this.connectSocket(opened.ws)
      const cdp = new CdpConnection(socket)
      try {
        const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
        const targetId = String((created as { targetId?: unknown }).targetId ?? '')
        const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
        const sessionId = String((attached as { sessionId?: unknown }).sessionId ?? '')
        if (!targetId || !sessionId) throw new Error('CDP 会话建立失败：未返回 targetId/sessionId')
        await cdp.send('Page.enable', {}, sessionId)
        await cdp.send('Network.enable', {}, sessionId)
        const next: ChannelSession = { client, profileId, cdp, targetId, sessionId, cursorPageOpened: false }
        // 断链感知：用户关窗/指纹浏览器退出时失效缓存，下次操作自动重开
        //（否则死会话被永久缓存，每次调用都挂到 CDP 超时且重试必败）。
        socket.onClose(() => {
          if (this.session === next) this.session = undefined
        })
        this.session = next
        return next
      } catch (error) {
        cdp.close()
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`指纹浏览器 CDP 连接失败：${detail.replace(/\s+/g, ' ').slice(0, 160)}`)
      }
    })()
    this.opening = { client, profileId, promise: opening }
    try {
      return await opening
    } finally {
      if (this.opening?.promise === opening) this.opening = undefined
    }
  }

  private async readTokenFromSession(session: ChannelSession): Promise<string | undefined> {
    const result = await session.cdp.send('Network.getCookies', { urls: [CURSOR_ORIGIN] }, session.sessionId)
    const cookies = (result.cookies as Array<{ name?: string; value?: string }>) ?? []
    const found = cookies.find((cookie) => cookie.name === TOKEN_COOKIE_NAME)
    // CDP 返回的 cookie 值保持站点写入时的 URL 编码形态，须先解码（与浏览器 cookie 库读取器一致）
    return found?.value ? decodeURIComponent(found.value) : undefined
  }

  private async readTokenFromCdp(): Promise<string | undefined> {
    return this.readTokenFromSession(await this.ensureSession())
  }

  private async navigate(bustPrefix: string): Promise<void> {
    const session = await this.ensureSession()
    await this.navigateSession(session, bustPrefix)
  }

  private async navigateSession(session: ChannelSession, bustPrefix: string): Promise<void> {
    // cache-bust：同 URL 的 Page.navigate 可能被 Chromium 去重为 no-op，认证链不会重放
    const url = `${REFRESH_URL}?${bustPrefix}=${this.now()}`
    await session.cdp.send('Page.navigate', { url }, session.sessionId)
    session.cursorPageOpened = true
  }

  private async evalInPage(expression: string, awaitPromise = false): Promise<unknown> {
    const session = await this.ensureSession()
    return this.evalInSession(session, expression, awaitPromise)
  }

  private async evalInSession(session: ChannelSession, expression: string, awaitPromise = false): Promise<unknown> {
    const result = await session.cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true },
      session.sessionId
    )
    return (result as { result?: { value?: unknown } }).result?.value
  }

  /**
   * 用户主动打开指纹浏览器窗口登录 cursor.com：开窗 + 导航官网首页。
   * 已登录则直接显示登录态页面；未登录可在页面内完成登录（cookie 落 profile）。
   *
   * 与导入链路的衔接：会话留在缓存且连接保持热——用户登录后点「从指纹浏览器导入」
   * 直接读到新 cookie，无需冷启动。**不关窗**（用户要自己操作，关窗交给用户或
   * 后续自动化链的 dispose）；断链感知兜底：用户手动关窗后缓存自动失效。
   */
  async openLoginPage(): Promise<void> {
    const session = await this.ensureSession()
    await session.cdp.send('Page.navigate', { url: CURSOR_ORIGIN }, session.sessionId)
    session.cursorPageOpened = true
  }

  /** 等待新 target 真正进入 cursor.com；仅检查同源与加载状态，不依赖 React 页面结构。 */
  private async ensureCursorPageReady(session: ChannelSession): Promise<void> {
    if (!session.cursorPageOpened) await this.navigateSession(session, 'qtpolicy')
    const deadline = this.now() + this.pageReadyTimeoutMs
    let authChainSince: number | undefined
    while (this.now() < deadline) {
      let state: { h?: string; p?: string; s?: string } | undefined
      try {
        const raw = await this.evalInSession(session, READINESS_JS)
        state = typeof raw === 'string' ? JSON.parse(raw) as typeof state : undefined
      } catch {
        state = undefined
      }
      if (state) {
        const host = state.h ?? ''
        const path = state.p ?? ''
        const onCursor = host === 'cursor.com' || host.endsWith('.cursor.com')
        const onAuthChain = host.includes('authenticator.') || path.startsWith('/login')
        if (onCursor && !onAuthChain && state.s !== 'loading') return
        if (onAuthChain) {
          authChainSince = authChainSince ?? this.now()
          if (this.now() - authChainSince > this.authChainGraceMs) {
            throw new Error('指纹浏览器窗口会话已退出登录（政策确认停留在认证/登录页）')
          }
        } else {
          authChainSince = undefined
        }
      }
      await this.sleep(this.pollIntervalMs)
    }
    throw new Error('模型数据政策确认超时（cursor.com 页面未就绪）')
  }

  /**
   * 幂等确认官网要求的数据留存政策。按「账号 id + 政策版本」缓存成功状态；
   * 同一账号的 token 换发不会重复提交，profile 内切换账号则重新查询。
   */
  private async ensureRequiredModelDataPolicies(
    session: ChannelSession,
    token: string
  ): Promise<CursorModelDataPolicyConsentSuccess[]> {
    const accountId = token.split('::', 1)[0]?.trim() || 'unknown'
    await this.ensureCursorPageReady(session)
    const results: CursorModelDataPolicyConsentSuccess[] = []
    for (const policy of REQUIRED_CURSOR_MODEL_DATA_POLICIES) {
      const cacheKey = `${accountId}:${policy.modelId}:${policy.consentVersion}`
      if (this.acknowledgedPolicyKeys.has(cacheKey)) {
        results.push({ kind: 'already_acknowledged', modelId: policy.modelId, consentVersion: policy.consentVersion })
        continue
      }
      const raw = await this.evalInSession(session, buildEnsureCursorModelDataPolicyScript(policy), true)
      const result = parseCursorModelDataPolicyConsentResult(raw, policy)
      if (result.kind === 'failed') throw new Error(cursorModelDataPolicyFailureMessage(result))
      this.acknowledgedPolicyKeys.add(cacheKey)
      results.push(result)
    }
    return results
  }

  /** 手动配置入口与自动导入共用的单一业务出口。 */
  async acknowledgeRequiredModelDataPolicies(): Promise<{
    token: string
    changed: boolean
    policies: CursorModelDataPolicyConsentSuccess[]
  }> {
    // 一次操作固定锚定起始 session；并发切 profile 时，后续导航/查询/复读都不会串到另一窗口。
    const session = await this.ensureSession()
    const token = await this.readTokenFromSession(session)
    if (!token) throw new Error('指纹浏览器窗口内未登录 cursor.com（请先在该窗口手动登录一次）')
    const policies = await this.ensureRequiredModelDataPolicies(session, token)
    // about:blank → dashboard 的导航可能换发 token；向上层只交付导航后的当前值。
    const current = await this.readTokenFromSession(session)
    if (!current) throw new Error('模型数据政策确认后登录态丢失（请重新登录 cursor.com）')
    this.lastKnownToken = current
    return {
      token: current,
      changed: policies.some((policy) => policy.kind === 'acknowledged'),
      policies
    }
  }

  /**
   * preflight：读 profile 内的 WorkosCursorSessionToken（顺带开窗并缓存轮换基准）。
   * 未登录/指纹浏览器不可达/未选窗口时抛错，由调用方在消耗卡密前中止。
   */
  async readToken(): Promise<string> {
    if (!this.shouldAcknowledgeModelDataPolicies()) {
      const token = await this.readTokenFromCdp()
      if (!token) throw new Error('指纹浏览器窗口内未登录 cursor.com（请先在该窗口手动登录一次）')
      this.lastKnownToken = token
      return token
    }
    return (await this.acknowledgeRequiredModelDataPolicies()).token
  }

  /**
   * fallback 轮换通道：导航刷新后轮询 cookie（内存级，无落盘等待），返回换发的新 token。
   */
  async refresh(previousToken: string): Promise<string> {
    const previous = previousToken.trim()
    await this.navigate('qtbrefresh')
    const deadline = this.now() + this.tokenRotateTimeoutMs
    for (;;) {
      const current = await this.readTokenFromCdp().catch(() => undefined)
      if (current && current !== previous) {
        this.lastKnownToken = current
        return current
      }
      if (this.now() >= deadline) {
        throw new Error('指纹浏览器会话刷新超时：token 未轮换（请确认该窗口登录态仍有效、网络可达 cursor.com）')
      }
      await this.sleep(this.pollIntervalMs)
    }
  }

  /** 奥仔完成后导航刷新 dashboard（认证链在 deleteWhenReady 中等待就绪）。 */
  async prepareRefresh(): Promise<void> {
    await this.navigate('qtdash')
  }

  /**
   * 页面就绪 + token 轮换完成后页内秒级删除。
   * 返回语义与 Edge 通道一致：deleted / not_logged_in / retry_legacy（回退纯协议链）。
   */
  async deleteWhenReady(): Promise<InBrowserDeleteResult> {
    const readyDeadline = this.now() + this.pageReadyTimeoutMs
    let authChainSince: number | undefined
    let ready = false
    while (this.now() < readyDeadline && !ready) {
      let state: { h?: string; p?: string; s?: string } | undefined
      try {
        const raw = await this.evalInPage(READINESS_JS)
        state = typeof raw === 'string' ? JSON.parse(raw) as typeof state : undefined
      } catch {
        state = undefined // 导航中途的瞬时失败，按未就绪继续等
      }
      if (state) {
        const host = state.h ?? ''
        const onCursor = host === 'cursor.com' || host.endsWith('.cursor.com')
        const onAuthChain = host.includes('authenticator.') || (state.p ?? '').startsWith('/login')
        if (onCursor && !onAuthChain && state.s !== 'loading') {
          ready = true
        } else if (onAuthChain) {
          authChainSince = authChainSince ?? this.now()
          if (this.now() - authChainSince > this.authChainGraceMs) {
            return { kind: 'not_logged_in', message: '指纹浏览器窗口会话已退出登录（页面停留在认证/登录页）' }
          }
        } else {
          authChainSince = undefined
        }
      }
      if (!ready) await this.sleep(this.pollIntervalMs)
    }
    if (!ready) return { kind: 'retry_legacy', message: '页面加载超时（认证链未在窗口内完成）' }

    // 关键守门：奥仔处理后必须等 token 轮换完成再删除（不刷新直接删除会 error）。
    // lastKnownToken 由 readToken 缓存；缺失时（未走过 preflight）跳过等待、仅按就绪删除。
    if (this.lastKnownToken) {
      const rotateDeadline = this.now() + this.tokenRotateTimeoutMs
      let rotated = false
      while (this.now() < rotateDeadline && !rotated) {
        const current = await this.readTokenFromCdp().catch(() => undefined)
        if (current && current !== this.lastKnownToken) rotated = true
        else await this.sleep(this.pollIntervalMs)
      }
      if (!rotated) {
        return { kind: 'retry_legacy', message: 'token 轮换超时（认证链未换发新会话，回退协议链）' }
      }
    }

    try {
      const armed = await this.evalInPage(FIRE_DELETE_JS)
      if (typeof armed !== 'string' || !armed.includes('armed')) {
        return { kind: 'retry_legacy', message: '页面内加固请求未能发起' }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { kind: 'retry_legacy', message: `页面内加固发起失败：${detail.replace(/\s+/g, ' ').slice(0, 120)}` }
    }

    const resultDeadline = this.now() + this.resultTimeoutMs
    while (this.now() < resultDeadline) {
      let raw: unknown
      try {
        raw = await this.evalInPage(POLL_RESULT_JS)
      } catch {
        raw = ''
      }
      if (typeof raw === 'string' && raw.startsWith('{')) {
        try {
          const parsed = JSON.parse(raw) as { st?: number; body?: string }
          const status = parsed.st ?? -1
          if (status >= 200 && status < 300) return { kind: 'deleted' }
          const body = (parsed.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
          return { kind: 'retry_legacy', message: `页面内加固被拒（HTTP ${status}${body ? `：${body}` : ''}）` }
        } catch {
          // 半截 JSON，继续等
        }
      }
      await this.sleep(this.pollIntervalMs)
    }
    return { kind: 'retry_legacy', message: '页面内加固结果等待超时' }
  }

  /**
   * 页面内站点数据清理（关窗前的尽力而为步骤）。
   *
   * 时机契约：仅在「官网账号已删除」后调用。先导航到 about:blank 卸载页面
   * （停止运行中的脚本，杜绝清理后立即回写），再清各 origin 站点数据。
   * 失败静默——真正的清场兜底在 finalizeDeletedAccount 的 Roxy 关窗事务；
   * 这一步只是减少落盘残留量，降低 Roxy 本地缓存清理的负担。
   */
  async clearSiteData(): Promise<void> {
    const session = await this.ensureSession()
    try {
      await session.cdp.send('Page.navigate', { url: 'about:blank' }, session.sessionId)
      session.cursorPageOpened = false
    } catch {
      // 导航失败（页面已死/正在跳转）：继续清理，尽力而为。
    }
    await Promise.all(SITE_DATA_ORIGINS.map(async (origin) => {
      await session.cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }).catch(() => undefined)
    }))
  }

  /**
   * 删除成功后的完整收尾（Profile 事务，2026-09-01 事故复盘后定稿）：
   *
   *   ① 页面卸载 + 站点数据尽力清理（仍持有 CDP 时）
   *   ② 释放 target/CDP
   *   ③ 关窗（Roxy close——页面脚本停摆，回写竞争物理切断）
   *   ④ clear_local_cache（本地 profile 文件；兼作关窗后置校验——窗口仍开时明确失败）
   *   ⑤ clear_server_cache（服务端同步缓存的登录痕迹）
   *   ⑥ random_env（下一轮全新指纹）
   *
   * 旧版（stash）把「活浏览器内清 Cookie + 验收」放在关窗之前：页面脚本与
   * Roxy 服务端缓存在窗口开着时持续回写，验收恒不通过 → 三次重试全败 →
   * 流程被误报为失败。正确形态是关窗后让 Roxy 对 profile 做原生清理事务。
   * ③-⑥ 由 client.finalizeProfile 原子执行；失败重试一次后抛出（不静默：
   * 残留会让下一账号被风控跨账号关联——但账号加固本身已成功，调用方按
   * 「收尾异常」分级呈现，不再拦截成功路径）。
   */
  async finalizeDeletedAccount(): Promise<void> {
    // 锚定本轮 profile 身份：清场期间用户切窗/CDP 失效都不影响后续本地 API。
    const anchor = this.session ?? await this.ensureSession()
    try {
      await this.clearSiteData()
    } catch {
      // 页面内清理失败不阻断：Roxy 本地缓存清理会覆盖同样的数据面。
    }
    await this.releaseSession()
    await this.finalizeProfileWithRetry(anchor.client, anchor.profileId)
  }

  /**
   * 手动环境清理（账号管线「一键清理」入口）：与 finalizeDeletedAccount 同一
   * Roxy 关窗事务，但不强制开窗——无活会话时直接对关闭状态的 profile 执行
   * clear_local_cache / clear_server_cache / random_env。有活会话时先做页面级
   * 卸载清理再走事务。清理后该 profile 的 cursor.com 登录态清空（需重新登录），
   * 指纹轮换为全新环境——用于多账号隔离兜底与残场重置。
   */
  async cleanupEnvironment(): Promise<void> {
    if (this.session) {
      try {
        await this.clearSiteData()
      } catch {
        // 页面级清理尽力而为；Roxy 本地缓存清理覆盖同样的数据面。
      }
      await this.releaseSession()
    }
    const client = this.resolveClient()
    const profileId = this.requireProfileId()
    await this.finalizeProfileWithRetry(client, profileId)
  }

  /** Roxy profile 清场事务（带一次重试）；旧客户端无事务能力时退化为仅关窗。 */
  private async finalizeProfileWithRetry(client: FingerprintBrowser, profileId: string): Promise<void> {
    if (!client.finalizeProfile) {
      await client.closeWindow(profileId).catch(() => undefined)
      return
    }
    let lastError = '未知错误'
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await client.finalizeProfile(profileId)
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (attempt < 2) await this.sleep(500)
      }
    }
    throw new Error(`Roxy profile 清场未完成：${lastError.replace(/\s+/g, ' ').slice(0, 160)}`)
  }

  /** 释放当前 CDP target 与连接（不动 profile 窗口）。 */
  private async releaseSession(): Promise<void> {
    const session = this.session
    this.session = undefined
    this.lastKnownToken = undefined
    if (!session) return
    try {
      await session.cdp.send('Target.closeTarget', { targetId: session.targetId })
    } catch {
      // target 已随页面关闭/窗口退出而失效
    }
    session.cdp.close()
  }

  /**
   * 一轮自动化结束后清理：关测试页、断 CDP、关浏览器窗口。
   * cookie/登录态持久保留在 profile 中；下一轮 readToken 重新拉起（换取资源干净）。
   */
  async dispose(): Promise<void> {
    const session = this.session
    this.session = undefined
    this.lastKnownToken = undefined
    this.acknowledgedPolicyKeys.clear()
    if (!session) return
    try {
      await session.cdp.send('Target.closeTarget', { targetId: session.targetId })
    } catch {
      // target 已随页面关闭/窗口退出而失效
    }
    session.cdp.close()
    await session.client.closeWindow(session.profileId)
  }
}
