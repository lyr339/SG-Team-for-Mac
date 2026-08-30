import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelMessageService } from '../src/application/channel-message-service'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { createUnifiedChannelServer } from '../src/mcp/unified-channel-server'

async function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'qingtian-channel-mcp-')), 'channel.sqlite3')
  const repository = new SqliteChannelMessageRepository(path)
  const service = new ChannelMessageService(repository)
  const server = createUnifiedChannelServer({
    runtimeFor: () => { throw new Error('通道测试不应触达团队运行时') },
    channelServiceFor: () => service,
    workspacePath: '/workspace/alpha',
    keepaliveTimeoutMs: 1_200
  })
  const client = new Client({ name: 'qingtian-channel-test', version: '1.0.0' })
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
      expect(text).toContain('team_read_message')
      expect(text).not.toContain('持续对话协议')
      expect(text).not.toContain('真实用户消息处理完后进入 qingtian 待命')
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
        { id: 'a1', name: '设计稿.png', mimeType: 'image/png', size: 820_000, path: '/tmp/qingtian/设计稿.png' },
        { id: 'a2', name: '日志.txt', mimeType: 'text/plain', size: 3_100_000, path: '/var/log/app.log' }
      ])
      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(result.isError).not.toBe(true)
      const text = textOf(result)
      expect(text).toContain('看下这两个附件')
      expect(text).toContain('2 个附件')
      expect(text).toContain('设计稿.png（image/png · 800.8 KB）')
      expect(text).toContain('/tmp/qingtian/设计稿.png')
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
      const imagePath = join(mkdtempSync(join(tmpdir(), 'qingtian-mcp-image-')), 'shot.png')
      writeFileSync(imagePath, Buffer.from(pngBase64, 'base64'))
      repository.enqueueOutbound('1', '请识别这张截图', 1_000, [
        { id: 'a1', name: 'shot.png', mimeType: 'image/png', size: Buffer.byteLength(pngBase64, 'base64'), path: imagePath }
      ])

      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(result.isError).not.toBe(true)
      const content = result.content as ToolContentBlock[]
      const image = content.find((block) => block.type === 'image')
      const text = textOf(result)
      // 投递形态对齐 qingtian-v2 插件：全部文本合并为单个前导块，图片固定末尾
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

  it('delivers text and small binary files inline like qingtian-v2 plugin check_messages', async () => {
    const { repository, client, close } = await fixture()
    try {
      const directory = mkdtempSync(join(tmpdir(), 'qingtian-mcp-files-'))
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
        { id: 'a1', name: '截图.png', mimeType: 'image/png', size: 15_360, path: '/tmp/qingtian/截图.png' }
      ])
      const result = await client.callTool({ name: 'check_messages', arguments: { ...ch } })
      expect(result.isError).not.toBe(true)
      const text = textOf(result)
      // 正文为空时投递文本仍完整：附件清单 + 系统后缀
      expect(text).toContain('1 个附件')
      expect(text).toContain('截图.png（image/png · 15.0 KB）')
      expect(text).toContain('/tmp/qingtian/截图.png')
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
      expect(text).toContain('check_messages 静默待命')
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
