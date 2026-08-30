import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  CursorRuntimeAccountBridge,
  type CursorRuntimeSwitchPayload
} from '../src/infrastructure/cursor/cursor-runtime-account-bridge'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const payload: CursorRuntimeSwitchPayload = {
  accessToken: 'access.jwt.value',
  refreshToken: 'refresh.jwt.value',
  email: 'next@example.com',
  signUpType: 'Auth_0',
  userId: 'auth0|user_next'
}

describe('CursorRuntimeAccountBridge', () => {
  it('serves one authenticated payload and waits for Cursor runtime hard acknowledgement', async () => {
    const port = await freePort()
    const key = 'test-switch-key'
    const bridge = new CursorRuntimeAccountBridge({ port, key, timeoutMs: 2_000 })

    const result = await bridge.applyAfterLaunch(payload, async () => {
      const preflight = await fetch(`http://127.0.0.1:${port}/v1/switch`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'vscode-file://vscode-app',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'x-zhimo-switch-key'
        }
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
      const response = await fetch(`http://127.0.0.1:${port}/v1/switch`, {
        headers: { 'X-Zhimo-Switch-Key': key }
      })
      expect(response.status).toBe(200)
      const received = await response.json() as CursorRuntimeSwitchPayload & { nonce: string }
      expect(received).toMatchObject(payload)
      expect(received.nonce).toBeTruthy()
      const done = await fetch(`http://127.0.0.1:${port}/v1/switch-done`, {
        method: 'POST',
        headers: { 'X-Zhimo-Switch-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: received.nonce, success: true, reason: '' })
      })
      expect(done.status).toBe(204)
      return 'cdp' as const
    })

    expect(result).toEqual({ launchResult: 'cdp', ack: { success: true, reason: '' } })
  })

  it('rejects unauthenticated polling and surfaces a runtime rejection', async () => {
    const port = await freePort()
    const key = 'test-switch-key'
    const bridge = new CursorRuntimeAccountBridge({ port, key, timeoutMs: 2_000 })
    const result = await bridge.applyAfterLaunch(payload, async () => {
      expect((await fetch(`http://127.0.0.1:${port}/v1/switch`)).status).toBe(403)
      const received = await fetch(`http://127.0.0.1:${port}/v1/switch`, {
        headers: { 'X-Zhimo-Switch-Key': key }
      }).then((response) => response.json()) as { nonce: string }
      await fetch(`http://127.0.0.1:${port}/v1/switch-done`, {
        method: 'POST',
        headers: { 'X-Zhimo-Switch-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: received.nonce, success: false, reason: 'readback-mismatch' })
      })
      return 'plain' as const
    })
    expect(result.ack).toEqual({ success: false, reason: 'readback-mismatch' })
  })

  it('fails when Cursor starts but never confirms the target runtime account', async () => {
    const port = await freePort()
    const bridge = new CursorRuntimeAccountBridge({ port, key: 'key', timeoutMs: 15 })
    await expect(bridge.applyAfterLaunch(payload, async () => 'plain' as const))
      .rejects.toThrowError(/没有确认运行时登录态/)
  })
})
