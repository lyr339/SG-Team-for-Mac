import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { CHANNEL_OUTBOX_MAX_PENDING, CHANNEL_PROCESS_EVENTS_MAX_PENDING } from '../src/domain/channel-message'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'qingtian-channel-')), 'channel.sqlite3')
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

  it('dedupes same-turn reply retries by overwriting the original row', () => {
    const repository = fixture()
    try {
      const first = repository.recordReply({ channelId: '1', content: '已收到', turn: 'turn-1' }, 100)
      const retried = repository.recordReply({
        channelId: '1',
        content: '已收到（重试补全过程）',
        turn: 'turn-1',
        process: [{ kind: 'thinking', id: 't', text: '补全的过程块', status: 'done' }]
      }, 200)
      expect(retried.id).toBe(first.id)
      expect(retried.createdAt).toBe(100)
      const replies = repository.listUnconsumedReplies()
      expect(replies).toHaveLength(1)
      expect(replies[0]?.content).toBe('已收到（重试补全过程）')
      expect(replies[0]?.process?.[0]).toMatchObject({ kind: 'thinking', text: '补全的过程块' })
      // 不同 turn 各自成行，互不吞并
      repository.recordReply({ channelId: '1', content: '已收到', turn: 'turn-2' }, 300)
      expect(repository.listUnconsumedReplies()).toHaveLength(2)
    } finally {
      repository.close()
    }
  })

  it('keeps archiving process events when a same-turn reply is retried', () => {
    const repository = fixture()
    try {
      repository.recordReply({ channelId: '1', content: '完成', turn: 'turn-a' }, 100)
      repository.recordProcessEvent({
        channelId: '1',
        turn: 'turn-a',
        block: { kind: 'thinking', id: 't', text: '补报的过程', status: 'done' }
      }, 200)
      repository.recordReply({ channelId: '1', content: '完成', turn: 'turn-a' }, 300)
      expect(repository.listLiveProcessEvents('1')).toHaveLength(0)
      expect(repository.listProcessEventsForTurn('1', 'turn-a')).toHaveLength(1)
      expect(repository.listUnconsumedReplies()).toHaveLength(1)
    } finally {
      repository.close()
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

  it('persists process blocks with replies and tolerates their absence', () => {
    const repository = fixture()
    try {
      repository.recordReply({
        channelId: '1',
        content: '完成实现',
        process: [
          { kind: 'thinking', id: 'th-1', text: '先梳理链路再动手', status: 'done' },
          {
            kind: 'tool',
            id: 'tool-1',
            toolName: 'StrReplace',
            toolKind: 'edit',
            summary: 'src/domain/channel-message.ts',
            input: { path: 'src/domain/channel-message.ts' },
            status: 'done'
          },
          { kind: 'command', id: 'cmd-1', command: 'npm test', output: 'all passed', exitCode: 0, status: 'done' }
        ]
      }, 100)
      repository.recordReply({ channelId: '1', content: '无过程回复' }, 200)
      const [withProcess, withoutProcess] = repository.listUnconsumedReplies()
      expect(withProcess?.process).toHaveLength(3)
      expect(withProcess?.process?.[0]).toMatchObject({ kind: 'thinking', text: '先梳理链路再动手' })
      expect(withProcess?.process?.[1]).toMatchObject({ kind: 'tool', toolName: 'StrReplace', toolKind: 'edit' })
      expect(withProcess?.process?.[2]).toMatchObject({ kind: 'command', exitCode: 0 })
      expect(withoutProcess?.process).toBeUndefined()
    } finally {
      repository.close()
    }
  })

  it('migrates legacy channel_replies tables by adding the process_json column', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-channel-')), 'channel.sqlite3')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE channel_replies (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        content TEXT NOT NULL,
        title TEXT,
        group_id TEXT,
        task_id TEXT,
        files_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      INSERT INTO channel_replies (id, channel_id, content, files_json, created_at)
      VALUES ('legacy-1', '1', '历史回复', '[]', 50);
    `)
    legacy.close()

    const repository = new SqliteChannelMessageRepository(path)
    try {
      const [legacyRow] = repository.listUnconsumedReplies()
      expect(legacyRow?.content).toBe('历史回复')
      expect(legacyRow?.process).toBeUndefined()
      expect(legacyRow?.turn).toBeUndefined()
      // process_json 与 turn 两列均补齐；过程事件表也已就绪
      repository.recordReply({
        channelId: '1',
        content: '新回复',
        process: [{ kind: 'thinking', id: 't', text: '迁移后可写', status: 'done' }],
        turn: 'turn-legacy-1'
      })
      repository.recordProcessEvent({
        channelId: '1',
        turn: 'turn-legacy-1',
        block: { kind: 'thinking', id: 'th-1', text: '老库新表可写', status: 'done' }
      })
      const rows = repository.listUnconsumedReplies()
      const migrated = rows.find((reply) => reply.content === '新回复')
      expect(migrated?.process).toHaveLength(1)
      expect(migrated?.turn).toBe('turn-legacy-1')
      expect(repository.listLiveProcessEvents('1')).toHaveLength(1)
    } finally {
      repository.close()
    }
  })

  it('upserts process events by block id within a turn (running flips to done)', () => {
    const repository = fixture()
    try {
      const first = repository.recordProcessEvent({
        channelId: '1',
        turn: 'turn-a',
        block: { kind: 'tool', id: 'tool-1', toolName: 'Shell', toolKind: 'command', summary: 'npm test', status: 'running' }
      }, 100)
      const second = repository.recordProcessEvent({
        channelId: '1',
        turn: 'turn-a',
        block: { kind: 'tool', id: 'tool-1', toolName: 'Shell', toolKind: 'command', summary: 'npm test', status: 'done' }
      }, 200)
      // 同一块 upsert：行数不增，状态翻转，seq 保持首次出现顺序
      expect(second.id).toBe(first.id)
      expect(second.seq).toBe(first.seq)
      const live = repository.listLiveProcessEvents('1')
      expect(live).toHaveLength(1)
      expect(live[0]?.block).toMatchObject({ id: 'tool-1', status: 'done' })

      repository.recordProcessEvent({
        channelId: '1',
        turn: 'turn-a',
        block: { kind: 'thinking', id: 'th-1', text: '先跑测试', status: 'done' }
      }, 300)
      expect(repository.listLiveProcessEvents('1').map((event) => event.blockId)).toEqual(['tool-1', 'th-1'])
      // 不同 turn 互不干扰
      repository.recordProcessEvent({
        channelId: '1',
        turn: 'turn-b',
        block: { kind: 'thinking', id: 'th-1', text: '新一轮', status: 'running' }
      }, 400)
      expect(repository.listProcessEventsForTurn('1', 'turn-a')).toHaveLength(2)
      expect(repository.listProcessEventsForTurn('1', 'turn-b')).toHaveLength(1)
    } finally {
      repository.close()
    }
  })

  it('archives a turn on record_reply and prunes expired archived events on next write', () => {
    const repository = fixture()
    try {
      repository.recordProcessEvent({
        channelId: '1',
        turn: 'turn-a',
        block: { kind: 'command', id: 'cmd-1', command: 'npm test', output: 'ok', status: 'running' }
      }, 100)
      repository.recordReply({ channelId: '1', content: '完成', turn: 'turn-a' }, 200)
      // 归档后 live 消失，历史仍可重建
      expect(repository.listLiveProcessEvents('1')).toHaveLength(0)
      expect(repository.listProcessEventsForTurn('1', 'turn-a')).toHaveLength(1)
      expect(repository.listUnconsumedReplies()[0]?.turn).toBe('turn-a')

      // 过期归档在下一次写入时清理
      const stale = Date.now() - 11 * 60_000
      repository.recordProcessEvent({
        channelId: '2',
        turn: 'turn-old',
        block: { kind: 'thinking', id: 't', text: '旧回合', status: 'done' }
      }, stale)
      repository.recordReply({ channelId: '2', content: '旧回复', turn: 'turn-old' }, stale + 1)
      expect(repository.listProcessEventsForTurn('2', 'turn-old')).toHaveLength(1)
      repository.recordProcessEvent({
        channelId: '2',
        turn: 'turn-new',
        block: { kind: 'thinking', id: 't2', text: '新回合触发清理', status: 'running' }
      })
      expect(repository.listProcessEventsForTurn('2', 'turn-old')).toHaveLength(0)
      expect(repository.listProcessEventsForTurn('2', 'turn-new')).toHaveLength(1)
    } finally {
      repository.close()
    }
  })

  it('rejects new process events beyond the per-channel pending cap', () => {
    const repository = fixture()
    try {
      for (let index = 0; index < CHANNEL_PROCESS_EVENTS_MAX_PENDING; index += 1) {
        repository.recordProcessEvent({
          channelId: '1',
          turn: 'turn-a',
          block: { kind: 'thinking', id: `th-${index}`, text: `块 ${index}`, status: 'running' }
        }, index)
      }
      expect(() => repository.recordProcessEvent({
        channelId: '1',
        turn: 'turn-a',
        block: { kind: 'thinking', id: 'th-overflow', text: '超限', status: 'running' }
      })).toThrowError(/已达上限/)
      // 既有块 upsert 不受上限影响（状态翻转不增行数）
      expect(() => repository.recordProcessEvent({
        channelId: '1',
        turn: 'turn-a',
        block: { kind: 'thinking', id: 'th-0', text: '块 0 完成', status: 'done' }
      })).not.toThrow()
      // 另一通道有独立配额
      expect(() => repository.recordProcessEvent({
        channelId: '2',
        turn: 'turn-a',
        block: { kind: 'thinking', id: 'th-x', text: '另一通道', status: 'running' }
      })).not.toThrow()
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
        turnCount: 3
      }, 200)
      expect(gated).toMatchObject({
        waiting: true,
        connectionPhase: 'processing',
        turnCount: 3,
        pendingReplySyncSince: 500
      })
      const cleared = repository.touchPresence('1', { pendingReplySyncSince: null }, 300)
      expect(cleared.pendingReplySyncSince).toBeUndefined()
      expect(cleared.turnCount).toBe(3)
      expect(repository.getPresence('1')?.updatedAt).toBe(300)
      expect(repository.listPresence().map((presence) => presence.channelId)).toEqual(['1'])
    } finally {
      repository.close()
    }
  })

  it('tracks embedded channel registrations across repository instances', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-channel-')), 'channel.sqlite3')
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

  it('shares the outbox between two repository instances (WAL multi-process)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-channel-')), 'channel.sqlite3')
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
