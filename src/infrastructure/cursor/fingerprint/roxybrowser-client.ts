/**
 * RoxyBrowser Local API 客户端（默认 127.0.0.1:50000），实现 FingerprintBrowser 统一契约。
 *
 * 文档：github.com/roxybrowserlabs/local-API（roxy_api.js 官方示例）
 *   GET  /health              健康检查
 *   GET  /browser/workspace   workspace 列表（首个即默认）
 *   GET  /browser/list_v3     窗口列表（rows: [{dirId, windowName, windowSortNum}]）
 *   POST /browser/open        {dirId, args: []} → {ws, http, coreVersion}
 *   POST /browser/close       {dirId}
 *   POST /browser/clear_local_cache  {dirIds, type:'all'}
 *   POST /browser/clear_server_cache {workspaceId, dirIds}
 *   POST /browser/random_env         {workspaceId, dirId}
 *
 * 鉴权：所有请求带 token 头（客户端 API → API 配置 → API Key）；API 状态须为 Enabled。
 * 响应统一 {code: 0, msg, data}；code !== 0 为业务失败。
 */
import type { FingerprintBrowserOpenResult, FingerprintBrowserWindow } from './fingerprint-browser-types'
import type { FingerprintBrowser } from './fingerprint-browser'

export interface RoxyBrowserClientOptions {
  baseUrl?: string
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

interface RoxyResponse<T> {
  code?: number
  msg?: string
  data?: T
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:50000'
const DEFAULT_TIMEOUT_MS = 20_000

function boundedDetail(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? '')
  return text.replace(/\s+/g, ' ').trim().slice(0, 200) || '未知错误'
}

export class RoxyBrowserClient implements FingerprintBrowser {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private workspaceId: number | undefined

  constructor(options: RoxyBrowserClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async request<T>(path: string, init: { method: 'GET' | 'POST'; query?: Record<string, string | number>; body?: Record<string, unknown> }): Promise<RoxyResponse<T>> {
    let url = `${this.baseUrl}${path}`
    if (init.query && Object.keys(init.query).length) {
      url += `?${new URLSearchParams(Object.entries(init.query).map(([key, value]) => [key, String(value)])).toString()}`
    }
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers: { 'Content-Type': 'application/json', token: this.apiKey },
        body: init.method === 'POST' && init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (error) {
      throw new Error(`RoxyBrowser Local API 不可达（${boundedDetail(error)}）——请确认 RoxyBrowser 客户端已运行且 API 状态为 Enabled`)
    }
    if (!response.ok) throw new Error(`RoxyBrowser Local API ${path} 返回 HTTP ${response.status}`)
    return (await response.json().catch(() => undefined)) as RoxyResponse<T> ?? { code: -1, msg: '响应不是合法 JSON' }
  }

  private unwrap<T>(response: RoxyResponse<T>, action: string): T {
    if (response.code !== 0) {
      throw new Error(`RoxyBrowser ${action}失败：${response.msg ?? `code ${response.code ?? '未知'}`}`)
    }
    return response.data as T
  }

  /** 健康检查；不可达/鉴权失败抛错。 */
  async health(): Promise<void> {
    const response = await this.request<{ data?: string }>('/health', { method: 'GET' })
    this.unwrap(response, '健康检查')
  }

  private async resolveWorkspaceId(): Promise<number> {
    if (this.workspaceId !== undefined) return this.workspaceId
    const response = await this.request<{ rows?: Array<{ id?: string | number }> }>('/browser/workspace', { method: 'GET' })
    const raw = this.unwrap(response, 'workspace 列表获取')?.rows?.[0]?.id
    const workspaceId = Number(raw)
    if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
      throw new Error('RoxyBrowser 未返回有效 workspace（请确认账号已登录）')
    }
    this.workspaceId = workspaceId
    return workspaceId
  }

  /** 列出窗口：取首个 workspace 的窗口（name 模糊可选）。 */
  async listWindows(): Promise<FingerprintBrowserWindow[]> {
    const workspaceId = await this.resolveWorkspaceId()
    const listResponse = await this.request<{ rows?: Array<{ dirId?: string; windowName?: string; windowSortNum?: number }> }>(
      '/browser/list_v3',
      { method: 'GET', query: { workspaceId, page_index: 1, page_size: 15 } }
    )
    const rows = this.unwrap(listResponse, '窗口列表获取')?.rows ?? []
    return rows
      .filter((row): row is { dirId: string; windowName?: string; windowSortNum?: number } => Boolean(row.dirId))
      .map((row) => ({
        id: String(row.dirId),
        name: row.windowName?.trim() || String(row.dirId),
        seq: typeof row.windowSortNum === 'number' ? row.windowSortNum : undefined
      }))
  }

  /** 打开窗口并返回 browser 级 CDP ws endpoint（重复调用幂等返回当前实例）。 */
  async openWindow(profileId: string): Promise<FingerprintBrowserOpenResult> {
    const response = await this.request<{ ws?: string; http?: string; coreVersion?: string | number }>(
      '/browser/open',
      { method: 'POST', body: { dirId: profileId, args: [] } }
    )
    const data = this.unwrap(response, '窗口打开')
    if (!data?.ws) throw new Error('RoxyBrowser 窗口打开失败：未返回 CDP 地址')
    return {
      ws: String(data.ws),
      http: data.http !== undefined ? String(data.http) : undefined,
      coreVersion: data.coreVersion !== undefined ? String(data.coreVersion) : undefined
    }
  }

  /** 关闭窗口（cookie/登录态保留在 profile）。失败静默——关窗是尽力而为的清理。 */
  async closeWindow(profileId: string): Promise<void> {
    try {
      await this.request('/browser/close', { method: 'POST', body: { dirId: profileId } })
    } catch {
      // 关窗失败不影响主流程；客户端退出/窗口已被手动关闭都会走到这里
    }
  }

  /**
   * 账号用毕后的 Roxy profile 原生清场事务（关窗后执行）：
   * close → clear_local_cache（本地文件）→ clear_server_cache（服务端同步缓存）
   * → random_env（下一轮全新指纹）。
   * 在关窗后清理是正确顺序：页面脚本已停，无回写竞争；Roxy 对关闭状态的
   * profile 做本地文件清理是干净事务（profile 仍打开时 clear_local_cache
   * 会明确失败——它兼作关窗后置校验）。三步任一失败向上抛，由调用方
   * 决定如何呈现（不静默：残留会让下一账号被风控跨账号关联）。
   */
  async finalizeProfile(profileId: string): Promise<void> {
    const workspaceId = await this.resolveWorkspaceId()
    await this.request('/browser/close', { method: 'POST', body: { dirId: profileId } })
    this.unwrap(
      await this.request('/browser/clear_local_cache', {
        method: 'POST',
        body: { dirIds: [profileId], type: 'all' }
      }),
      '本地缓存清理'
    )
    this.unwrap(
      await this.request('/browser/clear_server_cache', {
        method: 'POST',
        body: { workspaceId, dirIds: [profileId] }
      }),
      '服务端缓存清理'
    )
    this.unwrap(
      await this.request('/browser/random_env', {
        method: 'POST',
        body: { workspaceId, dirId: profileId }
      }),
      '指纹轮换'
    )
  }
}
