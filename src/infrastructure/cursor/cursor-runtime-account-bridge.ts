import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export const CURSOR_RUNTIME_SWITCH_PORT = 51_823
export const CURSOR_RUNTIME_SWITCH_KEY = '5f17ca98b1da1798b10261c4da6dd5e1642a064433a4ca90'

export interface CursorRuntimeSwitchPayload {
  accessToken: string
  refreshToken: string
  email?: string
  signUpType: string
  userId: string
}

export interface CursorRuntimeSwitchAck {
  success: boolean
  reason: string
}

export interface CursorRuntimeAccountBridgePort {
  applyAfterLaunch<Result>(
    payload: CursorRuntimeSwitchPayload,
    launch: () => Promise<Result>
  ): Promise<{ launchResult: Result; ack: CursorRuntimeSwitchAck }>
}

interface PendingAck extends CursorRuntimeSwitchAck {
  nonce?: string
}

/**
 * Cursor Companion 运行时换号桥。
 *
 * 当前 Cursor workbench 内置的 Companion 每 1.5s 轮询 GET /v1/switch，收到
 * payload 后通过 Cursor 自己的 authenticationService 写入 Token、通知登录监听器、
 * 刷新会员状态并 flush，最后 POST /v1/switch-done。拾光必须等这个硬回执，不能把
 * “离线改过 state.vscdb”误报成切换成功。
 */
export class CursorRuntimeAccountBridge implements CursorRuntimeAccountBridgePort {
  constructor(private readonly options: {
    port?: number
    key?: string
    timeoutMs?: number
  } = {}) {}

  async applyAfterLaunch<Result>(
    payload: CursorRuntimeSwitchPayload,
    launch: () => Promise<Result>
  ): Promise<{ launchResult: Result; ack: CursorRuntimeSwitchAck }> {
    const port = this.options.port ?? CURSOR_RUNTIME_SWITCH_PORT
    const key = this.options.key ?? CURSOR_RUNTIME_SWITCH_KEY
    const timeoutMs = this.options.timeoutMs ?? 30_000
    const nonce = randomUUID()
    let completed = false
    let resolveAck!: (ack: CursorRuntimeSwitchAck) => void
    const ackPromise = new Promise<CursorRuntimeSwitchAck>((resolve) => { resolveAck = resolve })

    const server = createServer((request, response) => {
      if (request.method === 'OPTIONS') {
        this.respond(response, 204)
        return
      }
      if (request.headers['x-zhimo-switch-key'] !== key) {
        this.respond(response, 403)
        return
      }
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      if (request.method === 'GET' && url.pathname === '/v1/switch') {
        if (completed) {
          this.respond(response, 204)
          return
        }
        this.respond(response, 200, { ...payload, nonce })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/switch-done') {
        void this.readJson(request).then((value) => {
          if (value.nonce !== nonce || typeof value.success !== 'boolean') {
            this.respond(response, 400)
            return
          }
          completed = true
          const ack = {
            success: value.success,
            reason: typeof value.reason === 'string' ? value.reason.slice(0, 240) : ''
          }
          this.respond(response, 204)
          resolveAck(ack)
        }).catch(() => this.respond(response, 400))
        return
      }
      this.respond(response, 404)
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const launchResult = await launch()
      const timeout = new Promise<CursorRuntimeSwitchAck>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Cursor Companion 在 ${Math.round(timeoutMs / 1_000)} 秒内没有确认运行时登录态`
        )), timeoutMs)
      })
      const ack = await Promise.race([ackPromise, timeout])
      return { launchResult, ack }
    } finally {
      if (timer) clearTimeout(timer)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private respond(response: ServerResponse, status: number, body?: unknown): void {
    if (response.headersSent) return
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Zhimo-Switch-Key, Content-Type',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store'
    }
    if (body === undefined) {
      response.writeHead(status, headers).end()
      return
    }
    response.writeHead(status, {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
    }).end(JSON.stringify(body))
  }

  private readJson(request: IncomingMessage): Promise<PendingAck> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 8_192) {
          reject(new Error('ack_too_large'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ack_invalid')
          resolve(value as PendingAck)
        } catch (error) {
          reject(error)
        }
      })
      request.on('error', reject)
    })
  }
}
