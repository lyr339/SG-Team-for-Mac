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

  it('closeWindow：失败静默不抛', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const client = new RoxyBrowserClient({ apiKey: 'k', fetchImpl })
    await expect(client.closeWindow('w1')).resolves.toBeUndefined()
  })
})
