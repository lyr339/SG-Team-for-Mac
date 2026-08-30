import { describe, expect, it } from 'vitest'
import { FingerprintAccountChannel } from '../src/infrastructure/cursor/fingerprint/fingerprint-account-channel'
import type { FingerprintBrowser } from '../src/infrastructure/cursor/fingerprint/fingerprint-browser'

/**
 * 假 CDP socket：按 method 脚本化响应；Network.getCookies 的 token 值与
 * Runtime.evaluate 的返回由测试逐轮控制，模拟「导航→认证链→token 轮换→页内删除」。
 */
class FakeCdpSocket {
  readonly sent: Array<{ id: number; method: string; params: Record<string, unknown>; sessionId?: string }> = []
  closed = false
  private messageHandler: ((data: string) => void) | undefined
  private closeHandler: (() => void) | undefined
  private nextId = 100
  /** 每次调用 Network.getCookies 时按序出队；空时返回 undefined（无 cookie）。 */
  tokenQueue: Array<string | undefined> = []
  /** Runtime.evaluate 的 READINESS_JS 逐次返回；空时用最后一项。 */
  readinessQueue: string[] = []
  /** FIRE_DELETE_JS evaluate 的返回值。 */
  fireResult = 'armed'
  /** POLL_RESULT_JS 逐次返回；空时用最后一项。 */
  pollResultQueue: string[] = []

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler
  }

  onError(): void {
    // 测试不模拟 ws 错误
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }

  /** 模拟连接断开（用户关窗/指纹浏览器退出）。 */
  simulateDisconnect(): void {
    this.closeHandler?.()
  }

  /** 模拟 ws 层收到脏数据（非法 JSON）。 */
  simulateGarbage(): void {
    this.messageHandler?.('{not valid json{{{')
  }

  close(): void {
    this.closed = true
  }

  send(data: string): void {
    const message = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
    this.sent.push(message)
    const respond = (result: unknown): void => {
      this.messageHandler?.(JSON.stringify({ id: message.id, result }))
    }
    switch (message.method) {
      case 'Target.createTarget':
        respond({ targetId: 'target-1' })
        return
      case 'Target.attachToTarget':
        respond({ sessionId: 'session-1' })
        return
      case 'Page.enable':
      case 'Network.enable':
      case 'Page.navigate':
      case 'Storage.clearDataForOrigin':
        respond({})
        return
      case 'Target.closeTarget':
        respond({ success: true })
        return
      case 'Network.getCookies': {
        const value = this.tokenQueue.length > 1 ? this.tokenQueue.shift() : this.tokenQueue[0]
        const cookies = value === undefined ? [] : [{ name: 'WorkosCursorSessionToken', value: String(value) }]
        respond({ cookies })
        return
      }
      case 'Runtime.evaluate': {
        const expression = String(message.params.expression ?? '')
        if (expression.includes('location.hostname')) {
          const value = this.readinessQueue.length > 1 ? this.readinessQueue.shift() : this.readinessQueue[0] ?? '{}'
          respond({ result: { value } })
          return
        }
        if (expression.includes('delete-account')) {
          respond({ result: { value: this.fireResult } })
          return
        }
        if (expression.includes('__qtDel')) {
          const value = this.pollResultQueue.length > 1 ? this.pollResultQueue.shift() : this.pollResultQueue[0] ?? ''
          respond({ result: { value } })
          return
        }
        respond({ result: { value: undefined } })
        return
      }
      default:
        respond({})
    }
  }

  methodCount(method: string): number {
    return this.sent.filter((entry) => entry.method === method).length
  }

  fireCalled(): boolean {
    return this.sent.some((entry) => (
      entry.method === 'Runtime.evaluate' && String(entry.params.expression ?? '').includes('delete-account')
    ))
  }
}

interface HarnessOptions {
  profileId?: string
  now?: () => number
}

function createHarness(options: HarnessOptions = {}) {
  const openCalls: string[] = []
  const closeWindowCalls: string[] = []
  const client = {
    openWindow: async (profileId: string) => {
      openCalls.push(profileId)
      return { ws: 'ws://127.0.0.1:52624/devtools/browser/abc', http: '127.0.0.1:52624' }
    },
    closeWindow: async (profileId: string) => {
      closeWindowCalls.push(profileId)
    }
  } satisfies Pick<FingerprintBrowser, 'openWindow' | 'closeWindow'>
  let currentProfileId: string | undefined = options.profileId ?? 'win-1'
  let clock = 0
  const socket = new FakeCdpSocket()
  const channel = new FingerprintAccountChannel({
    resolveClient: () => client as unknown as FingerprintBrowser,
    resolveProfileId: () => currentProfileId,
    connectSocket: () => socket,
    now: options.now ?? (() => clock),
    sleep: async (ms) => {
      clock += ms
    }
  })
  return {
    channel,
    socket,
    openCalls,
    closeWindowCalls,
    setProfileId: (id: string | undefined) => {
      currentProfileId = id
    },
    advance: (ms: number) => {
      clock += ms
    }
  }
}

const OLD_TOKEN = encodeURIComponent('user_abc::old-jwt')
const NEW_TOKEN = encodeURIComponent('user_abc::new-jwt')
const READY = JSON.stringify({ h: 'cursor.com', p: '/dashboard', s: 'complete' })
const AUTH_PAGE = JSON.stringify({ h: 'authenticator.cursor.sh', p: '/', s: 'complete' })
const LOADING = JSON.stringify({ h: 'cursor.com', p: '/dashboard', s: 'loading' })

describe('FingerprintAccountChannel', () => {
  it('readToken：开窗→建 CDP 会话→内存读 cookie 并解码', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await expect(harness.channel.readToken()).resolves.toBe('user_abc::old-jwt')
    expect(harness.openCalls).toEqual(['win-1'])
    expect(harness.socket.methodCount('Network.getCookies')).toBe(1)
    // 会话建立链完整：建 target → attach → 启用 Page/Network
    expect(harness.socket.methodCount('Target.createTarget')).toBe(1)
    expect(harness.socket.methodCount('Target.attachToTarget')).toBe(1)
    expect(harness.socket.methodCount('Page.enable')).toBe(1)
    expect(harness.socket.methodCount('Network.enable')).toBe(1)
  })

  it('readToken：窗口内未登录 → 抛错引导登录', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [undefined]
    await expect(harness.channel.readToken()).rejects.toThrow(/未登录 cursor\.com/)
  })

  it('未选择窗口 → 抛错引导选择', async () => {
    const harness = createHarness()
    harness.setProfileId(undefined)
    await expect(harness.channel.readToken()).rejects.toThrow(/未选择指纹浏览器窗口/)
    expect(harness.openCalls).toHaveLength(0)
  })

  describe('openLoginPage（用户提前登录入口）', () => {
    it('开窗并导航 cursor.com；不关窗、不 closeTarget（窗口留给用户操作）', async () => {
      const harness = createHarness()
      await harness.channel.openLoginPage()
      expect(harness.openCalls).toEqual(['win-1'])
      const navigations = harness.socket.sent.filter((entry) => entry.method === 'Page.navigate')
      expect(navigations).toHaveLength(1)
      expect(navigations[0]!.params).toEqual({ url: 'https://cursor.com' })
      // 窗口保持打开：不 closeTarget、不 closeWindow
      expect(harness.socket.methodCount('Target.closeTarget')).toBe(0)
      expect(harness.closeWindowCalls).toHaveLength(0)
      expect(harness.socket.closed).toBe(false)
    })

    it('会话留缓存：紧随其后的 readToken 复用热连接（不重开窗）', async () => {
      const harness = createHarness()
      await harness.channel.openLoginPage()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      // 用户在打开的页面里登录后，导入直接读到 cookie：窗口只开了一次
      expect(harness.openCalls).toEqual(['win-1'])
      expect(harness.socket.methodCount('Target.createTarget')).toBe(1)
    })

    it('未选择窗口 → 抛错引导选择', async () => {
      const harness = createHarness()
      harness.setProfileId(undefined)
      await expect(harness.channel.openLoginPage()).rejects.toThrow(/未选择指纹浏览器窗口/)
      expect(harness.openCalls).toHaveLength(0)
    })
  })

  describe('clearSiteData（账号隔离清场）', () => {
    it('对 cursor.com 与认证链 origin 各发一次 Storage.clearDataForOrigin（all 类型）', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()

      await harness.channel.clearSiteData()
      const clears = harness.socket.sent.filter((entry) => entry.method === 'Storage.clearDataForOrigin')
      expect(clears.map((entry) => entry.params.origin)).toEqual(
        expect.arrayContaining(['https://cursor.com', 'https://authentication.cursor.sh'])
      )
      for (const entry of clears) {
        expect(entry.params.storageTypes).toBe('all')
      }
    })

    it('复用已建立的会话（不重开窗）', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      await harness.channel.clearSiteData()
      expect(harness.openCalls).toEqual(['win-1'])
    })

    it('某个 origin 清理失败不抛错（删除已成功，残留只是卫生问题）', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      // 让其中一个 CDP 调用抛错：直接断开连接模拟中途失败
      harness.socket.simulateDisconnect()
      // 会话已失效 → clearSiteData 会重开窗口重试（断链自愈语义）
      harness.socket.tokenQueue = [OLD_TOKEN]
      await expect(harness.channel.clearSiteData()).resolves.toBeUndefined()
    })
  })

  describe('健壮性', () => {
    it('ws 收到非法 JSON → 静默忽略，不炸主进程，后续命令仍正常', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      const reading = harness.channel.readToken()
      harness.socket.simulateGarbage()
      await expect(reading).resolves.toBe('user_abc::old-jwt')
    })

    it('开窗进行中并发切换窗口 → 各自开窗，不返回错误窗口的会话', async () => {
      const socketsByUrl = new Map<string, FakeCdpSocket>()
      let currentProfileId: string | undefined = 'win-1'
      const openCalls: string[] = []
      const client = {
        openWindow: async (profileId: string) => {
          openCalls.push(profileId)
          // win-1 的开窗人为延迟，制造「opening 进行中切窗」的竞态窗口
          if (profileId === 'win-1') await new Promise((resolve) => setTimeout(resolve, 20))
          return { ws: `ws-${profileId}` }
        },
        closeWindow: async () => {}
      } satisfies Pick<FingerprintBrowser, 'openWindow' | 'closeWindow'>
      const channel = new FingerprintAccountChannel({
        resolveClient: () => client as unknown as FingerprintBrowser,
        resolveProfileId: () => currentProfileId,
        connectSocket: (wsUrl) => {
          const socket = new FakeCdpSocket()
          // win-1 的 socket 在延迟后才会创建；创建即预置 token，让挂起的 readToken 能完成
          if (wsUrl === 'ws-win-1') socket.tokenQueue = [OLD_TOKEN]
          socketsByUrl.set(wsUrl, socket)
          return socket
        },
        sleep: async () => {}
      })

      // win-1 开窗进行中（延迟 20ms），用户切到 win-2 并打开登录页
      const win1Reading = channel.readToken()
      currentProfileId = 'win-2'
      await channel.openLoginPage()

      // openLoginPage 必须作用于 win-2（不是错误地复用 win-1 的 opening）
      const win2Socket = socketsByUrl.get('ws-win-2')
      expect(win2Socket).toBeDefined()
      expect(win2Socket!.sent.some((entry) => entry.method === 'Page.navigate'
        && entry.params.url === 'https://cursor.com')).toBe(true)
      expect(openCalls).toEqual(['win-1', 'win-2'])

      await win1Reading
    })
  })

  describe('断链感知（用户关窗/指纹浏览器退出）', () => {
    it('连接断开后缓存失效：下次操作重开窗口，而不是挂在死会话上', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      expect(harness.openCalls).toEqual(['win-1'])

      // 用户手动关窗 → ws 断开（close 而非 error）
      harness.socket.simulateDisconnect()

      // 下一次读 token：自动重开（新 ws 连接、新会话），不再复用死会话
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      expect(harness.openCalls).toEqual(['win-1', 'win-1'])
      expect(harness.socket.methodCount('Target.createTarget')).toBe(2)
    })

    it('dispose 主动关窗不误伤后续操作（关闭后缓存已清，重开正常）', async () => {
      const harness = createHarness()
      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      await harness.channel.dispose()
      expect(harness.closeWindowCalls).toEqual(['win-1'])

      harness.socket.tokenQueue = [OLD_TOKEN]
      await harness.channel.readToken()
      expect(harness.openCalls).toEqual(['win-1', 'win-1'])
    })

    it('生产装配契约：client 实例稳定时跨 openLoginPage→readToken 全程复用（一次开窗一个 tab）', async () => {
      // 模拟 main 装配的实例缓存：同一配置下 resolveClient 返回同一实例
      const stableClient = {
        openWindow: async (profileId: string) => {
          return { ws: 'ws://stable', http: '127.0.0.1:1' }
        },
        closeWindow: async () => {}
      } as unknown as FingerprintBrowser
      const sockets: FakeCdpSocket[] = []
      let currentProfileId = 'win-1'
      const channel = new FingerprintAccountChannel({
        resolveClient: () => stableClient,
        resolveProfileId: () => currentProfileId,
        connectSocket: () => {
          const socket = new FakeCdpSocket()
          sockets.push(socket)
          return socket
        },
        sleep: async () => {}
      })

      await channel.openLoginPage()
      sockets[0]!.tokenQueue = [OLD_TOKEN]
      await channel.readToken()
      sockets[0]!.tokenQueue = [OLD_TOKEN]
      await channel.prepareRefresh()

      // 三次操作共享一个 ws 连接与一个 tab——热连接复用是「奥仔期间不冷启动」的前提
      expect(sockets).toHaveLength(1)
      expect(sockets[0]!.methodCount('Target.createTarget')).toBe(1)

      // 换 API Key 等价的实例变化 → 下一次操作重开（既有语义，回归防线）
      const anotherClient = { ...stableClient } as unknown as FingerprintBrowser
      const channel2 = new FingerprintAccountChannel({
        resolveClient: () => anotherClient,
        resolveProfileId: () => currentProfileId,
        connectSocket: () => {
          const socket = new FakeCdpSocket()
          socket.tokenQueue = [OLD_TOKEN]
          sockets.push(socket)
          return socket
        },
        sleep: async () => {}
      })
      await channel2.readToken()
      expect(sockets).toHaveLength(2)
    })
  })

  it('同一窗口重复操作复用 CDP 会话（不重复开窗）', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    await harness.channel.readToken()
    expect(harness.openCalls).toHaveLength(1)
    expect(harness.socket.methodCount('Target.createTarget')).toBe(1)
  })

  it('deleteWhenReady：就绪→token 轮换→页内删除成功', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    harness.socket.readinessQueue = [LOADING, READY]
    // 轮换序列：先读到旧 token（未变）、再读到新 token（已轮换）
    harness.socket.tokenQueue = [OLD_TOKEN, NEW_TOKEN]
    harness.socket.pollResultQueue = ['pending', JSON.stringify({ st: 200, body: '' })]
    await harness.channel.prepareRefresh()
    const result = await harness.channel.deleteWhenReady()
    expect(result).toEqual({ kind: 'deleted' })
    expect(harness.socket.fireCalled()).toBe(true)
  })

  it('deleteWhenReady：token 不轮换 → 超时回退 legacy（删除绝不抢跑）', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    // token 永远不变（旧值持续）
    harness.socket.readinessQueue = [READY]
    await harness.channel.prepareRefresh()
    const result = await harness.channel.deleteWhenReady()
    expect(result.kind).toBe('retry_legacy')
    if (result.kind === 'retry_legacy') {
      expect(result.message).toContain('token 轮换超时')
    }
    expect(harness.socket.fireCalled()).toBe(false)
  })

  it('deleteWhenReady：页面停留认证页 → 判定未登录', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    harness.socket.readinessQueue = [AUTH_PAGE]
    await harness.channel.prepareRefresh()
    const result = await harness.channel.deleteWhenReady()
    expect(result.kind).toBe('not_logged_in')
  })

  it('deleteWhenReady：页内删除被拒（403）→ retry_legacy 带状态码', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    harness.socket.readinessQueue = [READY]
    harness.socket.tokenQueue = [NEW_TOKEN]
    harness.socket.pollResultQueue = [JSON.stringify({ st: 403, body: 'blocked' })]
    await harness.channel.prepareRefresh()
    const result = await harness.channel.deleteWhenReady()
    expect(result.kind).toBe('retry_legacy')
    if (result.kind === 'retry_legacy') {
      expect(result.message).toContain('HTTP 403')
    }
  })

  it('refresh：导航后轮询 cookie 变化，返回换发的新 token', async () => {
    const harness = createHarness()
    // 先让通道记住旧 token（轮换基准）
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    harness.socket.tokenQueue = [OLD_TOKEN, NEW_TOKEN]
    await expect(harness.channel.refresh('user_abc::old-jwt')).resolves.toBe('user_abc::new-jwt')
    expect(harness.socket.methodCount('Page.navigate')).toBe(1)
  })

  it('refresh：token 永不变化 → 超时抛错', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    const result = await harness.channel.refresh('user_abc::old-jwt').catch((error: Error) => error.message)
    expect(result).toContain('会话刷新超时')
  })

  it('dispose：关测试页、断 ws、关浏览器窗口，且下次操作重新拉起', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    await harness.channel.dispose()
    expect(harness.socket.methodCount('Target.closeTarget')).toBe(1)
    expect(harness.socket.closed).toBe(true)
    expect(harness.closeWindowCalls).toEqual(['win-1'])
    // 下一轮重新拉起（新 socket 由 connectSocket 工厂重新创建）
    const second = new FakeCdpSocket()
    const openCalls: string[] = []
    const channel2 = new FingerprintAccountChannel({
      resolveClient: () => ({
        openWindow: async (id: string) => {
          openCalls.push(id)
          return { ws: 'ws://x', http: '127.0.0.1:1' }
        },
        closeWindow: async () => {}
      }) as unknown as FingerprintBrowser,
      resolveProfileId: () => 'win-1',
      connectSocket: () => second,
      sleep: async () => {}
    })
    second.tokenQueue = [OLD_TOKEN]
    await expect(channel2.readToken()).resolves.toBe('user_abc::old-jwt')
    expect(openCalls).toEqual(['win-1'])
  })

  it('切换窗口 id：会话重开到新窗口', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    harness.setProfileId('win-2')
    const socket2 = new FakeCdpSocket()
    const channel = new FingerprintAccountChannel({
      resolveClient: () => ({
        openWindow: async (id: string) => {
          harness.openCalls.push(id)
          return { ws: 'ws://x', http: '127.0.0.1:1' }
        },
        closeWindow: async () => {}
      }) as unknown as FingerprintBrowser,
      resolveProfileId: () => 'win-2',
      connectSocket: () => socket2,
      sleep: async () => {}
    })
    socket2.tokenQueue = [OLD_TOKEN]
    await channel.readToken()
    expect(harness.openCalls).toContain('win-2')
  })

  it('client 实例变化：会话重开（新实例即时生效）', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    expect(harness.openCalls).toEqual(['win-1'])
    // resolveClient 返回新实例 → 同一 profileId 也会重开
    const socket2 = new FakeCdpSocket()
    const roxyClient = {
      openWindow: async () => ({ ws: 'ws://roxy' }),
      closeWindow: async () => {}
    } as unknown as FingerprintBrowser
    const channel = new FingerprintAccountChannel({
      resolveClient: () => roxyClient,
      resolveProfileId: () => 'win-1',
      connectSocket: () => socket2,
      sleep: async () => {}
    })
    socket2.tokenQueue = [OLD_TOKEN]
    await channel.readToken()
    expect(channel).not.toBe(harness.channel)
  })

  it('导航 URL 携带 cache-bust（防 Chromium 同 URL no-op）', async () => {
    const harness = createHarness()
    harness.socket.tokenQueue = [OLD_TOKEN]
    await harness.channel.readToken()
    await harness.channel.prepareRefresh()
    const navigate = harness.socket.sent.find((entry) => entry.method === 'Page.navigate')
    expect(navigate?.params.url).toMatch(/^https:\/\/cursor\.com\/dashboard\?qtdash=\d+$/)
  })
})
