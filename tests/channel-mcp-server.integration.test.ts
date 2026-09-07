import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelMessageService } from '../src/application/channel-message-service'
import type { ChannelSessionOwnership } from '../src/domain/session-fence'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { createUnifiedChannelServer } from '../src/mcp/unified-channel-server'

async function fixture(options: { ownershipFor?: (channelId: string) => ChannelSessionOwnership | undefined } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-channel-mcp-')), 'channel.sqlite3')
  const repository = new SqliteChannelMessageRepository(path)
  const service = new ChannelMessageService(repository)
  const server = createUnifiedChannelServer({
    runtimeFor: () => { throw new Error('通道测试不应触达团队运行时') },
    channelServiceFor: () => service,
    ownershipFor: options.ownershipFor,
    workspacePath: '/workspace/alpha',
    keepaliveTimeoutMs: 1_200
  })
  const client = new Client({ name: 'sg-channel-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    repository,
    client,
    close: async () => {
      await client.close()
      await server.close()
      repository.close()
    }
  }
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content.map((block) => block.text ?? '').join('\n')
}

type ToolContentBlock = { type: string; text?: string; data?: string; mimeType?: string }

const ch = { channel_id: '1' }

describe('SG Team unified MCP (通信三工具契约)', () => {

  it('delivers a queued user message with first-delivery protocol suffix and turn note', async () => {
    const { repository, client, close } = await fixture()
    try {
      repository.enqueueOutbound('1', '帮我审查这个模块', 1_000)
      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(result.isError).not.toBe(true)
      const text = textOf(result)
      expect(text).toContain('帮我审查这个模块')
      expect(text).toContain('持续对话协议')
      expect(text).toContain('SG Team · CH-1')
      expect(text).toContain('[轮次 #1 · 队列剩余 0 条]')
      // 投递后置守门：未 record_reply 前不得再取新消息
      repository.enqueueOutbound('1', '第二条', 2_000)
      const fenced = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(fenced.isError).toBe(true)
      const fencedPayload = JSON.parse(textOf(fenced)) as { ok: boolean; needReplySync?: boolean; message?: string }
      expect(fencedPayload).toMatchObject({ ok: false, needReplySync: true })
      expect(fencedPayload.message).toContain('record_reply')
    } finally {
      await close()
    }
  })

  it('record_reply archives the reply and releases the sync gate', async () => {
    const { repository, client, close } = await fixture()
    try {
      repository.enqueueOutbound('1', '第一条', 1_000)
      await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      const recorded = await client.callTool({
        name: 'record_reply',
        arguments: { ...ch, content: '完整可见回复正文', title: '审查结论' }
      })
      expect(recorded.isError).not.toBe(true)
      expect(recorded.structuredContent).toMatchObject({
        ok: true,
        entry: { type: 'agent_reply', channelId: '1', title: '审查结论' }
      })
      expect(typeof (recorded.structuredContent as { messageId?: unknown }).messageId).toBe('string')
      expect(repository.listUnconsumedReplies().map((reply) => reply.content)).toEqual(['完整可见回复正文'])

      repository.enqueueOutbound('1', '第二条', 2_000)
      const next = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(next.isError).not.toBe(true)
      expect(textOf(next)).toContain('第二条')
    } finally {
      await close()
    }
  })

  it('delivers silent internal notifications without user-reply protocol or sync gate', async () => {
    const { repository, client, close } = await fixture()
    try {
      repository.enqueueOutbound('1', '【拾光内部协作通知】消息 ID：team-message:1', 1_000, undefined, true)
      const first = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(first.isError).not.toBe(true)
      const text = textOf(first)
      expect(text).toContain('内部协作通知协议')
      expect(text).toContain("team_message({action:'read', messageId})")
      expect(text).not.toContain('持续对话协议')
      expect(repository.getPresence('1')?.pendingReplySyncSince).toBeUndefined()

      repository.enqueueOutbound('1', '【拾光内部协作通知】消息 ID：team-message:2', 2_000, undefined, true)
      const second = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(second.isError).not.toBe(true)
      expect(textOf(second)).toContain('team-message:2')
    } finally {
      await close()
    }
  })





  it('delivers an attachment manifest with fallback paths for unreadable payloads', async () => {
    const { repository, client, close } = await fixture()
    try {
      repository.enqueueOutbound('1', '看下这两个附件', 1_000, [
        { id: 'a1', name: '设计稿.png', mimeType: 'image/png', size: 820_000, path: '/tmp/sg-team/设计稿.png' },
        { id: 'a2', name: '日志.txt', mimeType: 'text/plain', size: 3_100_000, path: '/var/log/app.log' }
      ])
      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(result.isError).not.toBe(true)
      const text = textOf(result)
      expect(text).toContain('看下这两个附件')
      expect(text).toContain('2 个附件')
      expect(text).toContain('设计稿.png（image/png · 800.8 KB）')
      expect(text).toContain('/tmp/sg-team/设计稿.png')
      expect(text).toContain('/var/log/app.log')
      // 路径不可读时只保留核对清单，不伪造内容。
      expect(text).not.toContain('base64,')
    } finally {
      await close()
    }
  })

  it('delivers pasted images as MCP image content blocks instead of path-only hints', async () => {
    const { repository, client, close } = await fixture()
    try {
      const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
      const imagePath = join(mkdtempSync(join(tmpdir(), 'sg-mcp-image-')), 'shot.png')
      writeFileSync(imagePath, Buffer.from(pngBase64, 'base64'))
      repository.enqueueOutbound('1', '请识别这张截图', 1_000, [
        { id: 'a1', name: 'shot.png', mimeType: 'image/png', size: Buffer.byteLength(pngBase64, 'base64'), path: imagePath }
      ])

      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(result.isError).not.toBe(true)
      const content = result.content as ToolContentBlock[]
      const image = content.find((block) => block.type === 'image')
      const text = textOf(result)
      // 投递形态：全部文本合并为单个前导块，图片固定末尾
      expect(content[0]?.type).toBe('text')
      expect(content[0]?.text).toContain('请识别这张截图')
      expect(content[0]?.text).toContain('1 个图片附件作为本次 MCP image 内容块直接附加')
      expect(content[0]?.text).toContain('必须改用下方路径读取原图后再判断')
      expect(content[0]?.text).toContain('持续对话协议')
      expect(content.at(-1)).toMatchObject({ type: 'image', data: pngBase64, mimeType: 'image/png' })
      expect(text).toContain('请识别这张截图')
      expect(text).toContain('1 个图片附件作为本次 MCP image 内容块直接附加')
      expect(image).toMatchObject({ type: 'image', data: pngBase64, mimeType: 'image/png' })
      expect(text).not.toContain(pngBase64)
    } finally {
      await close()
    }
  })

  it('delivers text and small binary files inline in check_messages', async () => {
    const { repository, client, close } = await fixture()
    try {
      const directory = mkdtempSync(join(tmpdir(), 'sg-mcp-files-'))
      const notePath = join(directory, 'note.txt')
      const pdfPath = join(directory, 'sample.pdf')
      writeFileSync(notePath, 'hello file\n第二行')
      writeFileSync(pdfPath, Buffer.from('%PDF-1.4\nabc'))
      repository.enqueueOutbound('1', '请看附件', 1_000, [
        { id: 'a1', name: 'note.txt', mimeType: 'text/plain', size: 17, path: notePath },
        { id: 'a2', name: 'sample.pdf', mimeType: 'application/pdf', size: 12, path: pdfPath }
      ])

      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(result.isError).not.toBe(true)
      const text = textOf(result)
      expect(text).toContain('【附件: note.txt】')
      expect(text).toContain('hello file\n第二行')
      expect(text).toContain('【二进制附件: sample.pdf (application/pdf)，Base64 如下】')
      expect(text).toContain(Buffer.from('%PDF-1.4\nabc').toString('base64'))
      expect(text).toContain('已在上方内联 1 个文本附件、1 个二进制附件 Base64')
    } finally {
      await close()
    }
  })

  it('delivers attachment-only messages with the manifest standing in for empty text', async () => {
    const { repository, client, close } = await fixture()
    try {
      repository.enqueueOutbound('1', '', 1_000, [
        { id: 'a1', name: '截图.png', mimeType: 'image/png', size: 15_360, path: '/tmp/sg-team/截图.png' }
      ])
      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(result.isError).not.toBe(true)
      const text = textOf(result)
      // 正文为空时投递文本仍完整：附件清单 + 系统后缀
      expect(text).toContain('1 个附件')
      expect(text).toContain('截图.png（image/png · 15.0 KB）')
      expect(text).toContain('/tmp/sg-team/截图.png')
      expect(text).toContain('持续对话协议')
    } finally {
      await close()
    }
  })

  it('later deliveries use the compact reminder instead of the full protocol', async () => {
    const { repository, client, close } = await fixture()
    try {
      repository.enqueueOutbound('1', '第一条', 1_000)
      await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      await client.callTool({ name: 'record_reply', arguments: { ...ch, content: '回复一' } })
      repository.enqueueOutbound('1', '第二条', 2_000)
      const second = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      const text = textOf(second)
      expect(text).toContain('第二条')
      expect(text).not.toContain('持续对话协议')
      // 后续投递只带两行提醒：回合收尾动作 + 静默规则，其余协议不重复。
      expect(text).toContain('先 record_reply 同步同一份完整回复，再 check_messages 待命')
      expect(text).toContain('必须静默续等')
      expect(text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2)
    } finally {
      await close()
    }
  })

  it('returns the keepalive marker after the idle timeout', async () => {
    const { client, close } = await fixture()
    try {
      const result = await client.callTool(
        { name: 'check_messages', arguments: { ...ch } },
        { timeout: 15_000 }
      )
      expect(result.isError).not.toBe(true)
      expect(textOf(result)).toMatch(/<sg_team_keepalive n="1"\s*\/>/)
    } finally {
      await close()
    }
  }, 20_000)

  it('rejects invalid record_reply input through schema validation', async () => {
    const { client, close } = await fixture()
    try {
      const result = await client.callTool({ name: 'record_reply', arguments: { ...ch, content: '' } })
      expect(result.isError).toBe(true)
    } finally {
      await close()
    }
  })
})

describe('SG Team unified MCP 会话围栏（session 令牌）', () => {
  const CURRENT = 'current-seat-token-0001'
  const STALE = 'stale-seat-token-00009'
  const owner = (overrides: Partial<ChannelSessionOwnership> = {}): ChannelSessionOwnership => ({
    runId: 'session-run:alpha:run-2', runStatus: 'running', bound: true, sessionToken: CURRENT, solo: true, ...overrides
  })

  it('serves the current seat token normally and records its heartbeat', async () => {
    const { repository, client, close } = await fixture({ ownershipFor: () => owner() })
    try {
      repository.enqueueOutbound('1', '带令牌的新会话', 1_000)
      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch, session: CURRENT } })
      expect(result.isError).not.toBe(true)
      expect(textOf(result)).toContain('带令牌的新会话')
      expect(repository.getPresence('1')?.pendingOutboundId).toBeTruthy()
      const recorded = await client.callTool({ name: 'record_reply', arguments: { ...ch, session: CURRENT, content: '收到' } })
      expect(recorded.isError).not.toBe(true)
      expect(repository.listUnconsumedReplies().map((reply) => reply.content)).toEqual(['收到'])
    } finally {
      await close()
    }
  })

  it('returns a terminal stop instruction to a stale token without touching presence or the queue', async () => {
    const { repository, client, close } = await fixture({ ownershipFor: () => owner() })
    try {
      repository.enqueueOutbound('1', '只能由新会话取走', 1_000)
      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch, session: STALE } })
      // 围栏指令是普通文本而非 isError：模型要把它当成「用户要求停止」，不是可重试错误。
      expect(result.isError).not.toBe(true)
      const text = textOf(result)
      expect(text).toContain('[system] 会话围栏')
      expect(text).toContain('CH-1 已由新的会话接管')
      expect(text).toContain('不要重试')
      expect(text).not.toContain('只能由新会话取走')
      // 旧会话不得点亮新席位的 presence，也不得取走排队消息。
      expect(repository.getPresence('1')).toBeUndefined()
      expect(repository.countPendingOutbound('1')).toBe(1)
    } finally {
      await close()
    }
  })

  it('refuses record_reply from a stale token with a session_retired error and stores nothing', async () => {
    const { repository, client, close } = await fixture({ ownershipFor: () => owner() })
    try {
      const result = await client.callTool({ name: 'record_reply', arguments: { ...ch, session: STALE, content: '迟到的回复' } })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ ok: false, code: 'session_retired' })
      expect((result.structuredContent as { message: string }).message).toContain('会话围栏')
      expect(repository.listUnconsumedReplies()).toEqual([])
    } finally {
      await close()
    }
  })

  it('retires even the current token once the run is completed or the channel leaves the run', async () => {
    let ownership: ChannelSessionOwnership | undefined = owner({ runStatus: 'completed' })
    const { client, close } = await fixture({ ownershipFor: () => ownership })
    try {
      const completed = await client.callTool({ name: 'check_messages', arguments: { ...ch, session: CURRENT } })
      expect(textOf(completed)).toContain('本轮运行已结束')

      ownership = owner({ bound: false, sessionToken: undefined })
      const unbound = await client.callTool({ name: 'check_messages', arguments: { ...ch, session: CURRENT } })
      expect(textOf(unbound)).toContain('CH-1 不再属于当前运行')

      ownership = undefined
      const noRun = await client.callTool({ name: 'check_messages', arguments: { ...ch, session: CURRENT } })
      expect(textOf(noRun)).toContain('当前没有活动运行')
    } finally {
      await close()
    }
  })

  it('keeps legacy (token-less) callers on the old contract even when a token would be rejected', async () => {
    const { repository, client, close } = await fixture({ ownershipFor: () => owner({ runStatus: 'completed' }) })
    try {
      repository.enqueueOutbound('1', '升级前创建的会话仍可服务', 1_000)
      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(result.isError).not.toBe(true)
      expect(textOf(result)).toContain('升级前创建的会话仍可服务')
      expect(repository.getPresence('1')?.pendingOutboundId).toBeTruthy()
    } finally {
      await close()
    }
  })

  it('fails open when ownership cannot be resolved (fence only rejects on positive evidence)', async () => {
    const { repository, client, close } = await fixture({ ownershipFor: () => { throw new Error('team db locked') } })
    try {
      repository.enqueueOutbound('1', '归属查询异常时照常投递', 1_000)
      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch, session: STALE } })
      expect(result.isError).not.toBe(true)
      expect(textOf(result)).toContain('归属查询异常时照常投递')
    } finally {
      await close()
    }
  })

  it('rejects malformed session tokens at the schema boundary', async () => {
    const { client, close } = await fixture({ ownershipFor: () => owner() })
    try {
      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch, session: 'bad token!' } })
      expect(result.isError).toBe(true)
    } finally {
      await close()
    }
  })
})

/**
 * 拾光桌面端重启期间的续接。MCP 进程由 Cursor 托管，与桌面端只共享一个 SQLite 文件：
 * 桌面端关闭连接、重新打开（迁移重跑）、重新入队，都发生在 Agent 的同一次长轮询里。
 */
describe('SG Team unified MCP 桌面端重启续接（restart continuity）', () => {
  const SEAT = 'seat-token-restart-0001'

  /** 拆开 MCP 侧与桌面端侧：两条连接指向同一个数据库文件，像生产里的两个进程。 */
  async function twoSided(options: { recordReplyRetryDelayMs?: number; flakyReplies?: number } = {}) {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-channel-restart-')), 'channel.sqlite3')
    const desktop = { repository: new SqliteChannelMessageRepository(path) }
    const mcpRepository = new SqliteChannelMessageRepository(path)
    let repliesToFail = options.flakyReplies ?? 0
    const busy = () => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
    const flaky = new Proxy(mcpRepository, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (property !== 'recordReply' || typeof value !== 'function') return value
        return (...args: unknown[]) => {
          if (repliesToFail > 0) {
            repliesToFail -= 1
            throw busy()
          }
          return Reflect.apply(value, target, args)
        }
      }
    })
    const service = new ChannelMessageService(flaky)
    const server = createUnifiedChannelServer({
      runtimeFor: () => { throw new Error('通道测试不应触达团队运行时') },
      channelServiceFor: () => service,
      ownershipFor: () => ({ runId: 'session-run:alpha:run-9', runStatus: 'running', bound: true, sessionToken: SEAT, solo: true }),
      workspacePath: '/workspace/alpha',
      keepaliveTimeoutMs: 6_000,
      recordReplyRetryDelayMs: options.recordReplyRetryDelayMs ?? 20
    })
    const client = new Client({ name: 'sg-channel-restart-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return {
      path,
      desktop,
      client,
      close: async () => {
        await client.close()
        await server.close()
        mcpRepository.close()
        desktop.repository.close()
      }
    }
  }

  it('长轮询横跨桌面端「退出 → 重启 → 入队」：同一次 check_messages 把重启后入队的消息投递出去，record_reply 落回新连接可读的可见回复', async () => {
    const { desktop, client, close, path } = await twoSided()
    try {
      desktop.repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      // Agent 进入长轮询（队列为空，不会立刻返回）。
      const pending = client.callTool({ name: 'check_messages', arguments: { ...ch, session: SEAT } })
      await new Promise((done) => setTimeout(done, 300))
      // 桌面端退出：关闭它的连接。MCP 侧照常心跳。
      desktop.repository.close()
      await new Promise((done) => setTimeout(done, 400))
      const presenceWhileDown = new SqliteChannelMessageRepository(path)
      try {
        expect(presenceWhileDown.getPresence('1')).toMatchObject({ waiting: true, connectionPhase: 'waiting', turnCount: 1 })
      } finally {
        presenceWhileDown.close()
      }
      // 桌面端重启：新连接重跑迁移，然后用户发消息。
      desktop.repository = new SqliteChannelMessageRepository(path)
      desktop.repository.enqueueOutbound('1', '拾光重启后发出的第一条消息', Date.now())

      const delivered = await pending
      expect(delivered.isError).not.toBe(true)
      expect(textOf(delivered)).toContain('拾光重启后发出的第一条消息')
      expect(textOf(delivered)).toContain('[轮次 #1 · 队列剩余 0 条]')

      const recorded = await client.callTool({ name: 'record_reply', arguments: { ...ch, session: SEAT, content: '重启前后都在线，收到。' } })
      expect(recorded.isError).not.toBe(true)
      const replies = desktop.repository.listUnconsumedReplies()
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ content: '重启前后都在线，收到。', channelId: '1' })
      expect(replies[0]?.visible).not.toBe(false)
      expect(replies[0]?.outboundId).toBe(desktop.repository.latestDeliveredOutbound('1')?.id)
    } finally {
      await close()
    }
  })

  it('record_reply 撞上桌面端启停的写锁：进程内按间隔重试后成功，不把 "database is locked" 裸抛给模型', async () => {
    const { desktop, client, close } = await twoSided({ flakyReplies: 2 })
    try {
      desktop.repository.enqueueOutbound('1', '需要回复的消息', 1_000)
      await client.callTool({ name: 'check_messages', arguments: { ...ch, session: SEAT } })
      const recorded = await client.callTool({ name: 'record_reply', arguments: { ...ch, session: SEAT, content: '第三次才写进去' } })
      expect(recorded.isError).not.toBe(true)
      expect(recorded.structuredContent).toMatchObject({ ok: true, entry: { visible: true } })
      expect(desktop.repository.listUnconsumedReplies().map((reply) => reply.content)).toEqual(['第三次才写进去'])
    } finally {
      await close()
    }
  })

  it('写锁持续超过重试预算：返回 storage_unavailable + retryable，文案明确不是围栏终止', async () => {
    const { desktop, client, close } = await twoSided({ flakyReplies: 1_000 })
    try {
      desktop.repository.enqueueOutbound('1', '需要回复的消息', 1_000)
      await client.callTool({ name: 'check_messages', arguments: { ...ch, session: SEAT } })
      const recorded = await client.callTool({ name: 'record_reply', arguments: { ...ch, session: SEAT, content: '写不进去的回复' } })
      expect(recorded.isError).toBe(true)
      expect(recorded.structuredContent).toMatchObject({ ok: false, code: 'storage_unavailable', retryable: true })
      const message = (recorded.structuredContent as { message: string }).message
      expect(message).toContain('database is locked')
      expect(message).toContain('不是会话围栏终止')
      expect(message).toContain('record_reply 补同步')
      expect(desktop.repository.listUnconsumedReplies()).toEqual([])
    } finally {
      await close()
    }
  })

  it('check_messages 在整个周期内都读不到存储时以 storage_unavailable 结构化返回（不是裸错误文本）', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-channel-storage-')), 'channel.sqlite3')
    const repository = new SqliteChannelMessageRepository(path)
    const broken = new Proxy(repository, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (property !== 'touchPresence' || typeof value !== 'function') return value
        return () => { throw Object.assign(new Error('database is locked'), { errcode: 5 }) }
      }
    })
    const server = createUnifiedChannelServer({
      runtimeFor: () => { throw new Error('通道测试不应触达团队运行时') },
      channelServiceFor: () => new ChannelMessageService(broken),
      keepaliveTimeoutMs: 1_000
    })
    const client = new Client({ name: 'sg-channel-storage-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ ok: false, code: 'storage_unavailable', retryable: true, failures: 1 })
      expect((result.structuredContent as { message: string }).message).toContain('原样重新调用同一工具')
    } finally {
      await client.close()
      await server.close()
      repository.close()
    }
  })
})
