import { describe, expect, it, vi } from 'vitest'
import { ExternalBrowserAccountHost } from '../src/infrastructure/cursor/external-browser-account-host'

/** 组装层测试：三件套委托与 noop 语义（三件套自身行为各有单测覆盖）。 */
describe('ExternalBrowserAccountHost', () => {
  it('readToken：同步读取器包装为 Promise，失败原样抛出', async () => {
    const host = new ExternalBrowserAccountHost({ readToken: () => 'user_x::jwt' })
    await expect(host.readToken()).resolves.toBe('user_x::jwt')

    const failing = new ExternalBrowserAccountHost({
      readToken: () => {
        throw new Error('读取浏览器中的 Cursor Token 失败')
      }
    })
    await expect(failing.readToken()).rejects.toThrow('读取浏览器中的 Cursor Token 失败')
  })

  it('refresh：委托给会话刷新器并透传 previousToken', async () => {
    const refresh = vi.fn().mockResolvedValue('new-token')
    const host = new ExternalBrowserAccountHost({ refresher: { refresh } })
    await expect(host.refresh('old-token')).resolves.toBe('new-token')
    expect(refresh).toHaveBeenCalledWith('old-token')
  })

  it('prepareRefresh / deleteWhenReady：委托给页内删除通道', async () => {
    const prepareRefresh = vi.fn().mockResolvedValue(undefined)
    const deleteWhenReady = vi.fn().mockResolvedValue({ kind: 'deleted' as const })
    const host = new ExternalBrowserAccountHost({ deleter: { prepareRefresh, deleteWhenReady } })
    await expect(host.prepareRefresh()).resolves.toBeUndefined()
    await expect(host.deleteWhenReady()).resolves.toEqual({ kind: 'deleted' })
    expect(prepareRefresh).toHaveBeenCalledTimes(1)
    expect(deleteWhenReady).toHaveBeenCalledTimes(1)
  })

  it('dispose：noop（不能关用户的浏览器），幂等可重复调用', async () => {
    const host = new ExternalBrowserAccountHost({})
    await expect(host.dispose()).resolves.toBeUndefined()
    await expect(host.dispose()).resolves.toBeUndefined()
  })
})
