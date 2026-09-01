import { describe, expect, it, vi } from 'vitest'
import { RoxyBrowserClient } from '../src/infrastructure/cursor/fingerprint/roxybrowser-client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('RoxyBrowserClient', () => {
  it('health：GET /health + token 头', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: 0, msg: '成功', data: 'ok' }))
    const client = new RoxyBrowserClient({ apiKey: 'roxy-key', fetchImpl })
    await expect(client.health()).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:50000/health',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ token: 'roxy-key' }) })
    )
  })

  it('listWindows：workspace → list_v3 两级查询并归一化', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { rows: [{ id: '90072' }] }, msg: '成功' }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          rows: [
            { dirId: 'w1', windowName: 'cursor', windowSortNum: 5 },
            { dirId: 'w2', windowName: '  ', windowSortNum: 6 },
            { windowName: '无 id 行' }
          ]
        },
        msg: '成功'
      }))
    const client = new RoxyBrowserClient({ apiKey: 'k', fetchImpl })
    const windows = await client.listWindows()
    expect(windows).toEqual([
      { id: 'w1', name: 'cursor', seq: 5 },
      { id: 'w2', name: 'w2', seq: 6 }
    ])
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:50000/browser/workspace', expect.anything())
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:50000/browser/list_v3?workspaceId=90072&page_index=1&page_size=15',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('openWindow：POST {dirId, args:[]} → data.ws', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      code: 0,
      data: { ws: 'ws://127.0.0.1:63376/devtools/browser/abc', http: '127.0.0.1:63376', coreVersion: 150 },
      msg: '成功'
    }))
    const client = new RoxyBrowserClient({ apiKey: 'k', fetchImpl })
    await expect(client.openWindow('w1')).resolves.toEqual({
      ws: 'ws://127.0.0.1:63376/devtools/browser/abc',
      http: '127.0.0.1:63376',
      coreVersion: '150'
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:50000/browser/open',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ dirId: 'w1', args: [] }) })
    )
  })

  it('openWindow：code !== 0 → 抛业务失败', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: 1001, msg: 'invalid token' }))
    const client = new RoxyBrowserClient({ apiKey: 'k', fetchImpl })
    await expect(client.openWindow('w1')).rejects.toThrow(/窗口打开失败：invalid token/)
  })

  it('不可达 → 错误引导开启 API 状态', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const client = new RoxyBrowserClient({ apiKey: 'k', fetchImpl })
    await expect(client.health()).rejects.toThrow(/RoxyBrowser Local API 不可达.*API 状态为 Enabled/)
  })

  it('finalizeProfile：关窗后按事务顺序清理缓存并轮换指纹', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { rows: [{ id: '90072' }] } }))   // workspace
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: null }))                            // close
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: null }))                            // clear_local_cache
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: null }))                            // clear_server_cache
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: null }))                            // random_env
    const client = new RoxyBrowserClient({ apiKey: 'k', fetchImpl })
    await expect(client.finalizeProfile('w1')).resolves.toBeUndefined()
    const calls = fetchImpl.mock.calls.map((call) => String(call[0]))
    expect(calls).toEqual([
      'http://127.0.0.1:50000/browser/workspace',
      'http://127.0.0.1:50000/browser/close',
      'http://127.0.0.1:50000/browser/clear_local_cache',
      'http://127.0.0.1:50000/browser/clear_server_cache',
      'http://127.0.0.1:50000/browser/random_env'
    ])
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:50000/browser/close',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ dirId: 'w1' }) }))
    expect(fetchImpl).toHaveBeenNthCalledWith(3, 'http://127.0.0.1:50000/browser/clear_local_cache',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ dirIds: ['w1'], type: 'all' }) }))
    expect(fetchImpl).toHaveBeenNthCalledWith(4, 'http://127.0.0.1:50000/browser/clear_server_cache',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ workspaceId: 90072, dirIds: ['w1'] }) }))
    expect(fetchImpl).toHaveBeenNthCalledWith(5, 'http://127.0.0.1:50000/browser/random_env',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ workspaceId: 90072, dirId: 'w1' }) }))
  })

  it('finalizeProfile：本地缓存清理失败 → 明确抛错（兼作关窗后置校验）', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { rows: [{ id: '90072' }] } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: null }))
      .mockResolvedValueOnce(jsonResponse({ code: 1005, msg: 'window is open' }))
    const client = new RoxyBrowserClient({ apiKey: 'k', fetchImpl })
    await expect(client.finalizeProfile('w1')).rejects.toThrow(/本地缓存清理失败：window is open/)
  })

  it('closeWindow：失败静默不抛', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const client = new RoxyBrowserClient({ apiKey: 'k', fetchImpl })
    await expect(client.closeWindow('w1')).resolves.toBeUndefined()
  })
})
