import type { AozaiProcessResult, AozaiProgressState } from '../domain/aozai-service'
import type { AozaiCardVault } from './aozai-card-vault'

export interface AozaiFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  getSetCookie(): string[]
}

export type AozaiFetch = (url: string, init: {
  method: string
  headers: Record<string, string>
  body?: string
}) => Promise<AozaiFetchResponse>

export interface AozaiLoginInfo {
  type: string
  remaining: number
}

interface AozaiServiceOptions {
  baseUrl?: string
  pollIntervalMs?: number
  overallTimeoutMs?: number
  maxNetworkErrors?: number
  sleep?: (ms: number) => Promise<void>
}

export interface AozaiProcessOptions {
  /** 完成后是否再登录一次刷新余额（默认 true；自动化链内传 false，由 UI 链外补刷）。 */
  refreshRemaining?: boolean
}

const DEFAULT_BASE_URL = 'https://getdoubao.com'
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function detailOf(data: unknown): string | undefined {
  const detail = asRecord(data)?.detail
  return typeof detail === 'string' && detail.trim() ? detail.trim() : undefined
}

export class AozaiService {
  private readonly baseUrl: string
  private readonly pollIntervalMs: number
  private readonly overallTimeoutMs: number
  private readonly maxNetworkErrors: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly cookies = new Map<string, string>()
  private running = false

  constructor(
    private readonly cardVault: AozaiCardVault,
    private readonly fetchImpl: AozaiFetch,
    options: AozaiServiceOptions = {}
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.pollIntervalMs = options.pollIntervalMs ?? 400
    this.overallTimeoutMs = options.overallTimeoutMs ?? 300_000
    this.maxNetworkErrors = options.maxNetworkErrors ?? 5
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** 预热登录（建立会话 Cookie），供自动化在倒计时末提前调用；处理时若已有会话则跳过重复登录。 */
  async warmup(): Promise<void> {
    await this.login(this.cardVault.credential())
  }

  /** 用指定卡密登录验证，成功后由调用方负责保存卡密。 */
  async verifyCard(cardCode: string): Promise<AozaiLoginInfo> {
    const code = cardCode.trim()
    if (!code) throw new Error('卡密不能为空')
    return this.login(code)
  }

  /** 用已保存卡密刷新余额。 */
  async refreshBalance(): Promise<AozaiLoginInfo> {
    return this.login(this.cardVault.credential())
  }

  /**
   * 提交 session token 进行处理并轮询至完成。
   * token 明文只在主进程内流转，不经过渲染进程。
   */
  async processToken(
    sessionToken: string,
    onProgress: (state: AozaiProgressState, message: string) => void = () => {},
    options: AozaiProcessOptions = {}
  ): Promise<AozaiProcessResult> {
    if (this.running) throw new Error('已有处理任务进行中，请等待完成')
    const token = sessionToken.trim()
    if (!token) throw new Error('Session Token 不能为空')
    this.running = true
    try {
      if (!this.cookies.size) {
        onProgress('submitting', '正在登录奥仔自助服务…')
        await this.login(this.cardVault.credential())
      }
      onProgress('submitting', '正在提交处理请求…')
      const submitted = await this.submitProcess(token)
      if (!submitted.ok) return submitted
      const operationId = submitted.operationId as string
      onProgress('processing', '已受理，正在跟踪处理进度…')
      const finished = await this.trackOperation(operationId, onProgress)
      if (options.refreshRemaining === false) return finished
      const remaining = await this.safeRefreshRemaining()
      return { ...finished, remaining }
    } finally {
      this.running = false
    }
  }

  private async submitProcess(token: string, retried = false): Promise<{ ok: true; operationId: string } | ({ ok: false } & AozaiProcessResult)> {
    let response: AozaiFetchResponse
    try {
      response = await this.request('/api/v1/process', { session_token: token })
    } catch {
      return { ok: false, message: '网络错误，请检查连接后重试' }
    }
    const data = asRecord(await response.json().catch(() => undefined))
    if (response.status === 401 && !retried) {
      await this.login(this.cardVault.credential())
      return this.submitProcess(token, true)
    }
    if (!response.ok) return { ok: false, message: detailOf(data) ?? `提交失败（HTTP ${response.status}）` }
    if (data?.maintenance) {
      return { ok: false, message: typeof data.message === 'string' && data.message.trim() ? data.message.trim() : '系统维护升级中，请稍后再试。您的卡密次数不受影响。' }
    }
    const operationId = typeof data?.operation_id === 'string' ? data.operation_id : ''
    if (!operationId) return { ok: false, message: '服务响应缺少 operation_id' }
    return { ok: true, operationId }
  }

  private async trackOperation(
    operationId: string,
    onProgress: (state: AozaiProgressState, message: string) => void
  ): Promise<AozaiProcessResult> {
    const deadline = Date.now() + this.overallTimeoutMs
    let networkErrors = 0
    let lastStepMessage = ''
    while (Date.now() < deadline) {
      await this.sleep(this.pollIntervalMs)
      let response: AozaiFetchResponse
      try {
        response = await this.request(`/api/v1/operations/${encodeURIComponent(operationId)}`)
      } catch {
        networkErrors += 1
        if (networkErrors >= this.maxNetworkErrors) {
          return { ok: false, message: '网络错误，请检查连接后重试；如已提交可稍后刷新余额确认' }
        }
        continue
      }
      if (!response.ok) {
        if (response.status === 401) return { ok: false, message: '登录已过期，请重新保存卡密后到服务站核对本次结果' }
        networkErrors += 1
        if (networkErrors >= this.maxNetworkErrors) {
          return { ok: false, message: '查询进度失败，请稍后刷新余额确认结果' }
        }
        continue
      }
      networkErrors = 0
      const data = asRecord(await response.json().catch(() => undefined))
      const status = typeof data?.status === 'string' ? data.status : ''
      const steps = Array.isArray(data?.steps) ? data.steps : []
      const current = steps.map((step) => asRecord(step)).filter((step): step is Record<string, unknown> => Boolean(step)).pop()
      const stepMessage = typeof current?.message === 'string' ? current.message.trim() : ''
      if (stepMessage && stepMessage !== lastStepMessage) {
        lastStepMessage = stepMessage
        onProgress('processing', stepMessage)
      }
      if (status === 'completed') return { ok: true, message: '处理成功' }
      if (status === 'failed') {
        const failedStep = steps
          .map((step) => asRecord(step))
          .find((step) => step?.status === 'fail' && typeof step.message === 'string')
        const reason = (failedStep?.message as string | undefined) ?? (typeof data?.error === 'string' ? data.error : undefined)
        return { ok: false, message: `${reason?.trim() || '处理失败'}（失败次数已自动退还）` }
      }
    }
    return { ok: false, message: '处理超时，仍在后台进行；请稍后刷新余额确认结果' }
  }

  private async safeRefreshRemaining(): Promise<number | undefined> {
    try {
      return (await this.login(this.cardVault.credential())).remaining
    } catch {
      return undefined
    }
  }

  private async login(cardCode: string): Promise<AozaiLoginInfo> {
    let response: AozaiFetchResponse
    try {
      response = await this.request('/api/v1/auth/login', { card_code: cardCode })
    } catch {
      throw new Error('网络错误，请确认服务可达后重试')
    }
    const data = asRecord(await response.json().catch(() => undefined))
    if (!response.ok || data?.ok !== true) {
      throw new Error(detailOf(data) ?? '卡密验证失败，请检查后重试')
    }
    const remaining = Number(data.remaining)
    return {
      type: typeof data.type === 'string' && data.type.trim() ? data.type.trim() : '次卡',
      remaining: Number.isFinite(remaining) ? remaining : 0
    }
  }

  private async request(path: string, body?: Record<string, unknown>): Promise<AozaiFetchResponse> {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    if (body) headers['Content-Type'] = 'application/json'
    const cookie = [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
    if (cookie) headers.Cookie = cookie
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined
    })
    for (const line of response.getSetCookie()) {
      const pair = line.split(';', 1)[0]
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
    return response
  }
}
