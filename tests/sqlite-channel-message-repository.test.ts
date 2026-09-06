import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { CHANNEL_OUTBOX_MAX_PENDING } from '../src/domain/channel-message'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-channel-')), 'channel.sqlite3')
  return new SqliteChannelMessageRepository(path)
}

describe('SqliteChannelMessageRepository', () => {
  it('enqueues outbound messages with monotonic per-channel seq', () => {
    const repository = fixture()
    try {
      const first = repository.enqueueOutbound('1', '你好', 100)
      const second = repository.enqueueOutbound('1', '在吗', 200)
      const other = repository.enqueueOutbound('2', '另一个通道', 300)
      expect(first.seq).toBe(1)
      expect(second.seq).toBe(2)
      expect(other.seq).toBe(1)
      expect(repository.listPendingOutbound('1').map((message) => message.text)).toEqual(['你好', '在吗'])
      expect(repository.countPendingOutbound('1')).toBe(2)
      expect(repository.countPendingOutbound('2')).toBe(1)
    } finally {
      repository.close()
    }
  })

  it('rejects empty text and invalid channel ids', () => {
    const repository = fixture()
    try {
      expect(() => repository.enqueueOutbound('1', '   ')).toThrowError(/不能为空/)
      expect(() => repository.enqueueOutbound('../1', 'x')).toThrowError(/通道号无效/)
      expect(repository.enqueueOutbound('1', 'x').text).toBe('x')
    } finally {
      repository.close()
    }
  })

  it('dedupes recent text-only outbound retries without swallowing attachments', () => {
    const repository = fixture()
    try {
      const first = repository.enqueueOutbound('1', '继续当前任务', 1_000)
      const retried = repository.enqueueOutbound('1', '  继续当前任务  ', 5_000)
      expect(retried.id).toBe(first.id)
      expect(repository.listPendingOutbound('1')).toHaveLength(1)

      repository.markOutboundDelivered([first.id], 6_000)
      const deliveredRetry = repository.enqueueOutbound('1', '继续当前任务', 8_000)
      expect(deliveredRetry.id).toBe(first.id)
      expect(repository.countPendingOutbound('1')).toBe(0)

      const later = repository.enqueueOutbound('1', '继续当前任务', 40_000)
      expect(later.id).not.toBe(first.id)
      expect(repository.listPendingOutbound('1').map((message) => message.id)).toEqual([later.id])

      const silent = repository.enqueueOutbound('1', '继续当前任务', 41_000, undefined, true)
      expect(silent.id).not.toBe(later.id)

      repository.enqueueOutbound('1', '带图', 42_000, [
        { id: 'a1', name: 'a.png', mimeType: 'image/png', size: 1, path: '/tmp/a.png' }
      ])
      repository.enqueueOutbound('1', '带图', 43_000, [
        { id: 'a2', name: 'b.png', mimeType: 'image/png', size: 1, path: '/tmp/b.png' }
      ])
      expect(repository.listPendingOutbound('1').filter((message) => message.text === '带图')).toHaveLength(2)
    } finally {
      repository.close()
    }
  })

  it('compacts existing pending duplicate text messages so later work is not blocked', () => {
    const repository = fixture()
    try {
      repository.enqueueOutbound('1', '汇报当前进度', 1_000)
      repository.enqueueOutbound('1', '继续真实任务', 2_000)
      // 模拟旧版本/外部迁移残留：绕过当前 enqueue 去重，直接留下重复待投递行。
      const legacy = new DatabaseSync(repository.path)
      try {
        legacy.prepare(`
          INSERT INTO channel_outbox (id, channel_id, seq, text, attachments_json, created_at, delivered_at, silent)
          VALUES (?, ?, ?, ?, NULL, ?, NULL, 0)
        `).run('legacy-duplicate-progress', '1', 3, '汇报当前进度', 5_000)
      } finally {
        legacy.close()
      }

      expect(repository.listPendingOutbound('1').map((message) => message.text)).toEqual([
        '汇报当前进度',
        '继续真实任务',
        '汇报当前进度'
      ])
      expect(repository.dedupePendingOutbound('1', 6_000)).toBe(1)
      expect(repository.listPendingOutbound('1').map((message) => message.text)).toEqual([
        '汇报当前进度',
        '继续真实任务'
      ])
    } finally {
      repository.close()
    }
  })

  it('marks outbound delivered at most once', () => {
    const repository = fixture()
    try {
      const message = repository.enqueueOutbound('1', '任务', 100)
      repository.markOutboundDelivered([message.id], 200)
      expect(repository.countPendingOutbound('1')).toBe(0)
      repository.markOutboundDelivered([message.id], 300)
      const delivered = repository.listPendingOutbound('1')
      expect(delivered).toHaveLength(0)
      expect(repository.latestDeliveredOutbound('1')).toMatchObject({
        id: message.id,
        deliveredAt: 200
      })
    } finally {
      repository.close()
    }
  })

  it('lists outbound history including delivered messages and silent metadata', () => {
    const repository = fixture()
    try {
      const old = repository.enqueueOutbound('1', '上一轮', 50)
      const visible = repository.enqueueOutbound('1', '继续推进', 100)
      const silent = repository.enqueueOutbound('1', '内部调度', 120, undefined, true)
      repository.markOutboundDelivered([visible.id, silent.id], 200)
      repository.enqueueOutbound('2', '另一个通道', 140)

      const history = repository.listOutboundSince(100).map((message) => ({
        id: message.id,
        channelId: message.channelId,
        text: message.text,
        deliveredAt: message.deliveredAt,
        silent: message.silent
      }))
      expect(history).toEqual([
        { id: visible.id, channelId: '1', text: '继续推进', deliveredAt: 200, silent: undefined },
        { id: silent.id, channelId: '1', text: '内部调度', deliveredAt: 200, silent: true },
        expect.objectContaining({ channelId: '2', text: '另一个通道' })
      ])
      expect(history.some((message) => message.id === old.id)).toBe(false)
    } finally {
      repository.close()
    }
  })

  it('enforces the pending outbox cap', () => {
    const repository = fixture()
    try {
      for (let index = 0; index < CHANNEL_OUTBOX_MAX_PENDING; index += 1) {
        repository.enqueueOutbound('1', `消息 ${index}`, index)
      }
      expect(() => repository.enqueueOutbound('1', '溢出')).toThrowError(/上限/)
    } finally {
      repository.close()
    }
  })

  it('records replies and consumes them once in order', () => {
    const repository = fixture()
    try {
      const first = repository.recordReply({ channelId: '1', content: '回复一', title: '标题' }, 100)
      const second = repository.recordReply({ channelId: '2', content: '回复二', files: ['a.ts'] }, 200)
      expect(first.id).not.toBe(second.id)
      expect(repository.listUnconsumedReplies().map((reply) => reply.content)).toEqual(['回复一', '回复二'])
      repository.markReplyConsumed(first.id)
      expect(repository.listUnconsumedReplies().map((reply) => reply.id)).toEqual([second.id])
      const [remaining] = repository.listUnconsumedReplies()
      expect(remaining?.files).toEqual(['a.ts'])
      expect(() => repository.recordReply({ channelId: '1', content: '' })).toThrowError(/不能为空/)
    } finally {
      repository.close()
    }
  })

  it('lists reply history including consumed rows', () => {
    const repository = fixture()
    try {
      const old = repository.recordReply({ channelId: '1', content: '上一轮回复' }, 50)
      const first = repository.recordReply({ channelId: '1', content: '已收到' }, 100)
      const second = repository.recordReply({ channelId: '2', content: '完成' }, 200)
      repository.markReplyConsumed(first.id, 300)

      const history = repository.listRepliesSince(100).map((reply) => ({
        id: reply.id,
        channelId: reply.channelId,
        content: reply.content,
        consumedAt: reply.consumedAt
      }))
      expect(history).toEqual([
        { id: first.id, channelId: '1', content: '已收到', consumedAt: 300 },
        { id: second.id, channelId: '2', content: '完成', consumedAt: undefined }
      ])
      expect(history.some((reply) => reply.id === old.id)).toBe(false)
    } finally {
      repository.close()
    }
  })



  it('persists Cursor-native process blocks with the assistant reply across restart', () => {
    const repository = fixture()
    const path = repository.path
    const reply = repository.recordReply({ channelId: '1', content: '过程完成' }, 1_000)
    expect(repository.attachReplyProcess({
      replyId: reply.id,
      turn: 'cursor:user-turn-persisted',
      blocks: [{
        kind: 'tool', id: 'tool-persisted', toolName: 'read_file', toolKind: 'read',
        summary: 'package.json', status: 'done', output: 'body'
      }],
      truncatedItemCount: 3
    })).toBe(true)
    repository.close()

    const reopened = new SqliteChannelMessageRepository(path)
    try {
      expect(reopened.listRepliesSince(0)[0]).toMatchObject({
        id: reply.id,
        processTurn: 'cursor:user-turn-persisted',
        processTruncatedItemCount: 3,
        processBlocks: [{ id: 'tool-persisted', output: 'body' }]
      })
    } finally {
      reopened.close()
    }
  })

  it('dedupes turn-less duplicate reply contents within the retry window only', () => {
    const repository = fixture()
    try {
      const first = repository.recordReply({ channelId: '1', content: '已收到' }, 1_000)
      const retried = repository.recordReply({ channelId: '1', content: '已收到' }, 3_000)
      expect(retried.id).toBe(first.id)
      expect(repository.listUnconsumedReplies()).toHaveLength(1)
      // 窗口内不同内容、窗口外同内容均正常入账
      repository.recordReply({ channelId: '1', content: '另一条回复' }, 4_000)
      const escaped = repository.recordReply({ channelId: '1', content: '另一条回复\\n\\n- 已完成' }, 5_000)
      const normalized = repository.recordReply({ channelId: '1', content: '另一条回复\n\n- 已完成' }, 35_000)
      expect(normalized.id).toBe(escaped.id)
      repository.recordReply({ channelId: '1', content: '已收到' }, 400_000)
      expect(repository.listUnconsumedReplies().map((reply) => reply.createdAt)).toEqual([1_000, 4_000, 5_000, 400_000])
    } finally {
      repository.close()
    }
  })






  it('upserts presence with patch semantics and clears the reply gate with null', () => {
    const repository = fixture()
    try {
      const initial = repository.touchPresence('1', { waiting: true, connectionPhase: 'waiting' }, 100)
      expect(initial).toMatchObject({
        channelId: '1',
        waiting: true,
        connectionPhase: 'waiting',
        turnCount: 0,
        pendingReplySyncSince: undefined
      })
      const gated = repository.touchPresence('1', {
        connectionPhase: 'processing',
        pendingReplySyncSince: 500,
        pendingOutboundId: 'outbound-1',
        turnCount: 3
      }, 200)
      expect(gated).toMatchObject({
        waiting: true,
        connectionPhase: 'processing',
        turnCount: 3,
        pendingReplySyncSince: 500,
        pendingOutboundId: 'outbound-1'
      })
      const cleared = repository.touchPresence('1', { pendingReplySyncSince: null, pendingOutboundId: null }, 300)
      expect(cleared.pendingReplySyncSince).toBeUndefined()
      expect(cleared.pendingOutboundId).toBeUndefined()
      expect(cleared.turnCount).toBe(3)
      expect(repository.getPresence('1')?.updatedAt).toBe(300)
      expect(repository.listPresence().map((presence) => presence.channelId)).toEqual(['1'])
    } finally {
      repository.close()
    }
  })

  it('records runtime activity monotonically without touching heartbeat semantics', () => {
    const repository = fixture()
    try {
      repository.touchPresence('1', { waiting: false, connectionPhase: 'processing', lastSeenAt: 1_000 }, 1_000)
      expect(repository.touchRuntimeActivity('1', 2_000)).toEqual({ advanced: true, revived: false })
      expect(repository.getPresence('1')).toMatchObject({
        lastSeenAt: 1_000,
        connectionPhase: 'processing',
        runtimeActiveAt: 2_000
      })
      // 迟到/重复证据：不回拨、不产生 updated_at 噪声写入（会话指纹不抖动）。
      const updatedAt = repository.getPresence('1')?.updatedAt
      expect(repository.touchRuntimeActivity('1', 1_500)).toEqual({ advanced: false, revived: false })
      expect(repository.touchRuntimeActivity('1', 2_000)).toEqual({ advanced: false, revived: false })
      expect(repository.getPresence('1')).toMatchObject({ runtimeActiveAt: 2_000, updatedAt })
      // 未注册通道：静默无效果（presence 行由心跳路径建立）。
      expect(repository.touchRuntimeActivity('9', 3_000)).toEqual({ advanced: false, revived: false })
    } finally {
      repository.close()
    }
  })

  it('revives terminal phases only when runtime activity is newer than the stop marker', () => {
    const repository = fixture()
    try {
      repository.touchPresence('1', { waiting: false, connectionPhase: 'cursor_stopped', lastSeenAt: 10_000 }, 10_000)
      // 早于停止标记的迟到观测：证据照记（供后续新鲜度比较），相位不让位。
      expect(repository.touchRuntimeActivity('1', 9_500)).toEqual({ advanced: true, revived: false })
      expect(repository.getPresence('1')?.connectionPhase).toBe('cursor_stopped')
      // 更晚的生成观测：终止相位让位（死亡证据必须新鲜于生命证据）。
      expect(repository.touchRuntimeActivity('1', 11_000)).toEqual({ advanced: true, revived: true })
      expect(repository.getPresence('1')).toMatchObject({
        connectionPhase: 'reviving',
        runtimeActiveAt: 11_000
      })
    } finally {
      repository.close()
    }
  })

  it('tracks embedded channel registrations across repository instances', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-channel-')), 'channel.sqlite3')
    const writer = new SqliteChannelMessageRepository(path)
    try {
      writer.markChannelEmbedded('1', 'workspace-a', '/workspace/a', 100)
      writer.markChannelEmbedded('3', 'workspace-a', '/workspace/a', 200)
      const reader = new SqliteChannelMessageRepository(path)
      try {
        expect(reader.isChannelEmbedded('1')).toBe(true)
        expect(reader.isChannelEmbedded('2')).toBe(false)
        expect(reader.listEmbeddedChannels()).toEqual(['1', '3'])
      } finally {
        reader.close()
      }
      writer.markChannelDetached('1', 300)
      expect(writer.isChannelEmbedded('1')).toBe(false)
      expect(writer.listEmbeddedChannels()).toEqual(['3'])
    } finally {
      writer.close()
    }
  })

  it('replaces embedded channels exactly for the workspace', () => {
    const repository = fixture()
    try {
      repository.replaceEmbeddedChannels('workspace-a', '/workspace/a', ['1', '2', '3'], 100)
      expect(repository.listEmbeddedChannels()).toEqual(['1', '2', '3'])

      repository.replaceEmbeddedChannels('workspace-a', '/workspace/a', ['2', '4'], 200)
      expect(repository.listEmbeddedChannels()).toEqual(['2', '4'])
      expect(repository.isChannelEmbedded('1')).toBe(false)
      expect(repository.isChannelEmbedded('3')).toBe(false)

      repository.markChannelEmbedded('7', 'workspace-b', '/workspace/b', 300)
      repository.replaceEmbeddedChannels('workspace-a', '/workspace/a', ['4'], 400)
      expect(repository.listEmbeddedChannels()).toEqual(['4', '7'])
    } finally {
      repository.close()
    }
  })

  it('holds a hold-token message from the issuing session and releases it to the next session token (会话交接)', () => {
    const repository = fixture()
    try {
      repository.enqueueOutbound('1', '普通消息', 100)
      const held = repository.enqueueOutbound('1', '【会话交接】上下文文档路径', 200, undefined, false, undefined, { holdSessionToken: 'seat-A' })
      expect(held.holdSessionToken).toBe('seat-A')
      // 主进程视角（不传 forSession）：两条都在队列，计数 2
      expect(repository.listPendingOutbound('1').map((message) => message.text)).toEqual(['普通消息', '【会话交接】上下文文档路径'])
      expect(repository.countPendingOutbound('1')).toBe(2)
      // 现任会话（seat-A）与无令牌调用方：都取不到保持位消息
      expect(repository.listPendingOutbound('1', { forSession: 'seat-A' }).map((message) => message.text)).toEqual(['普通消息'])
      expect(repository.listPendingOutbound('1', { forSession: null }).map((message) => message.text)).toEqual(['普通消息'])
      // 重建后的新会话（seat-B）：按 seq 顺序取到全部
      expect(repository.listPendingOutbound('1', { forSession: 'seat-B' }).map((message) => message.text))
        .toEqual(['普通消息', '【会话交接】上下文文档路径'])
      // 保持位消息不与同文本普通消息合并去重，也不参与入队查重
      const again = repository.enqueueOutbound('1', '【会话交接】上下文文档路径', 210, undefined, false, undefined, { holdSessionToken: 'seat-A' })
      expect(again.id).not.toBe(held.id)
      expect(repository.dedupePendingOutbound('1', 220)).toBe(0)
      // 放行：回到普通排队，现任会话即可取走
      expect(repository.releaseOutboundHold(held.id)).toBe(true)
      expect(repository.releaseOutboundHold(held.id)).toBe(false)
      expect(repository.listPendingOutbound('1', { forSession: 'seat-A' }).map((message) => message.id)).toContain(held.id)
    } finally {
      repository.close()
    }
  })

  it('withdraws a queued message before delivery and never afterwards', () => {
    const repository = fixture()
    try {
      const first = repository.enqueueOutbound('1', '第一条', 100)
      const second = repository.enqueueOutbound('1', '第二条', 200)
      expect(repository.withdrawOutbound(second.id, 300)).toBe(true)
      expect(repository.countPendingOutbound('1')).toBe(1)
      expect(repository.listPendingOutbound('1').map((message) => message.id)).toEqual([first.id])
      // 撤回后不可再被投递，也不会被重复撤回
      repository.markOutboundDelivered([second.id], 400)
      expect(repository.listOutboundSince(0).find((message) => message.id === second.id)).toMatchObject({
        withdrawnAt: 300, deliveredAt: undefined
      })
      expect(repository.withdrawOutbound(second.id, 500)).toBe(false)
      // 已投递的消息不能撤回
      repository.markOutboundDelivered([first.id], 600)
      expect(repository.withdrawOutbound(first.id, 700)).toBe(false)
      expect(repository.countPendingOutbound('1')).toBe(0)
    } finally {
      repository.close()
    }
  })

  it('shares the outbox between two repository instances (WAL multi-process)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-channel-')), 'channel.sqlite3')
    const main = new SqliteChannelMessageRepository(path)
    const agent = new SqliteChannelMessageRepository(path)
    try {
      main.enqueueOutbound('1', '来自主进程', 100)
      const pending = agent.listPendingOutbound('1')
      expect(pending.map((message) => message.text)).toEqual(['来自主进程'])
      agent.markOutboundDelivered(pending.map((message) => message.id), 200)
      expect(main.countPendingOutbound('1')).toBe(0)
      agent.recordReply({ channelId: '1', content: '来自 Agent' }, 300)
      expect(main.listUnconsumedReplies().map((reply) => reply.content)).toEqual(['来自 Agent'])
    } finally {
      agent.close()
      main.close()
    }
  })
})
