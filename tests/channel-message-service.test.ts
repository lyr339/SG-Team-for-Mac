import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  CHANNEL_STORAGE_RETRY_LIMIT,
  ChannelMessageService,
  isTransientStorageError
} from '../src/application/channel-message-service'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-channel-service-')), 'channel.sqlite3')
  const repository = new SqliteChannelMessageRepository(path)
  const service = new ChannelMessageService(repository)
  return { repository, service }
}

/** node:sqlite 的 SQLITE_BUSY 形态：errcode 5 + "database is locked"。 */
function busyError(): Error & { errcode: number } {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
}

/**
 * 在真实仓库外包一层故障注入：指定方法的前 N 次调用抛 SQLITE_BUSY，之后放行。
 * 模拟拾光桌面端启停时另一连接短暂持有写锁的窗口。
 */
function flaky(
  repository: SqliteChannelMessageRepository,
  failures: Partial<Record<keyof SqliteChannelMessageRepository, number>>
): {
  repository: SqliteChannelMessageRepository
  calls: Record<string, number>
  /** 存储恢复：清空剩余故障；再传入新计划即重新注入。 */
  heal: (next?: Partial<Record<keyof SqliteChannelMessageRepository, number>>) => void
} {
  const remaining = new Map(Object.entries(failures) as Array<[string, number]>)
  const calls: Record<string, number> = {}
  const heal = (next: Partial<Record<keyof SqliteChannelMessageRepository, number>> = {}): void => {
    remaining.clear()
    for (const [name, count] of Object.entries(next) as Array<[string, number]>) remaining.set(name, count)
  }
  const proxy = new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || typeof property !== 'string') return value
      return (...args: unknown[]) => {
        calls[property] = (calls[property] ?? 0) + 1
        const left = remaining.get(property) ?? 0
        if (left > 0) {
          remaining.set(property, left - 1)
          throw busyError()
        }
        return Reflect.apply(value, target, args)
      }
    }
  })
  return { repository: proxy, calls, heal }
}

describe('ChannelMessageService', () => {
  it('delivers one copy when recent duplicate text was collapsed at enqueue time', async () => {
    const { repository, service } = fixture()
    try {
      repository.enqueueOutbound('1', '同一个问题', 1_000)
      repository.enqueueOutbound('1', '同一个问题', 2_000)
      repository.enqueueOutbound('1', '下一个问题', 3_000)
      const result = await service.checkMessages({ channelId: '1' })
      expect(result).toMatchObject({
        type: 'delivered',
        mergedCount: 1,
        remainingQueue: 1,
        turnCount: 1,
        deliveredCount: 1
      })
      expect(repository.countPendingOutbound('1')).toBe(1)
      const presence = repository.getPresence('1')
      expect(presence).toMatchObject({
        connectionPhase: 'processing',
        deliveredCount: 1
      })
      expect(presence?.pendingReplySyncSince).toBeDefined()
      expect(presence?.pendingOutboundId).toBe(result.type === 'delivered' ? result.message.id : undefined)
    } finally {
      repository.close()
    }
  })

  it('never merges attachment messages even with identical empty text', async () => {
    const { repository, service } = fixture()
    try {
      const image = (name: string) => ({
        id: name,
        name,
        mimeType: 'image/png',
        size: 100,
        path: `/tmp/${name}`
      })
      // 纯图连发：text 均为空串，合并判据不得把它们当重复丢弃
      repository.enqueueOutbound('1', '', 1_000, [image('a.png')])
      repository.enqueueOutbound('1', '', 2_000, [image('b.png')])
      const first = await service.checkMessages({ channelId: '1' })
      expect(first).toMatchObject({ type: 'delivered', mergedCount: 1, remainingQueue: 1 })
      expect(first.type === 'delivered' && first.message.attachments?.[0]?.name).toBe('a.png')

      service.recordReply({ channelId: '1', content: '收到第一张图' })
      const second = await service.checkMessages({ channelId: '1' })
      expect(second).toMatchObject({ type: 'delivered', mergedCount: 1, remainingQueue: 0 })
      expect(second.type === 'delivered' && second.message.attachments?.[0]?.name).toBe('b.png')
    } finally {
      repository.close()
    }
  })

  it('returns keepalive after the idle timeout with an empty queue', async () => {
    const { repository, service } = fixture()
    try {
      const result = await service.checkMessages({
        channelId: '1',
        keepaliveTimeoutMs: 1_000,
        pollIntervalMs: 100
      })
      expect(result).toMatchObject({ type: 'keepalive', round: 1 })
      expect(repository.getPresence('1')).toMatchObject({
        connectionPhase: 'keepalive',
        keepaliveRound: 1
      })
    } finally {
      repository.close()
    }
  })

  it('does not open the reply-sync gate after a silent internal notification', async () => {
    const { repository, service } = fixture()
    try {
      repository.enqueueOutbound('1', '【拾光内部协作通知】消息 ID：m1', 1_000, undefined, true)
      const first = await service.checkMessages({ channelId: '1' })
      expect(first).toMatchObject({ type: 'delivered' })
      expect(first.type === 'delivered' && first.message.silent).toBe(true)
      expect(repository.getPresence('1')?.pendingReplySyncSince).toBeUndefined()

      repository.enqueueOutbound('1', '【拾光内部协作通知】消息 ID：m2', 2_000, undefined, true)
      const second = await service.checkMessages({ channelId: '1' })
      expect(second).toMatchObject({ type: 'delivered' })
      expect(second.type === 'delivered' && second.message.text).toContain('m2')
    } finally {
      repository.close()
    }
  })

  it('treats legacy internal notification rows as silent and self-heals their stale sync gate', async () => {
    const { repository, service } = fixture()
    try {
      repository.enqueueOutbound('1', '【拾光内部协作通知】消息 ID：legacy', 1_000)
      const deliveredLegacy = await service.checkMessages({ channelId: '1' })
      expect(deliveredLegacy).toMatchObject({ type: 'delivered' })
      expect(deliveredLegacy.type === 'delivered' && deliveredLegacy.message.silent).toBe(true)
      expect(repository.getPresence('1')?.pendingReplySyncSince).toBeUndefined()

      // 模拟旧版本已经把这条内部通知错误地变成 reply-sync 守门。
      repository.touchPresence('1', {
        pendingReplySyncSince: repository.latestDeliveredOutbound('1')?.deliveredAt ?? Date.now(),
        connectionPhase: 'need_reply_sync',
        waiting: true
      })
      repository.enqueueOutbound('1', '真实用户下一条', 2_000)
      const next = await service.checkMessages({ channelId: '1' })
      expect(next).toMatchObject({ type: 'delivered' })
      expect(next.type === 'delivered' && next.message.text).toBe('真实用户下一条')
    } finally {
      repository.close()
    }
  })

  it('fences the next check behind reply sync until record_reply clears the gate', async () => {
    const { repository, service } = fixture()
    try {
      repository.enqueueOutbound('1', '第一条', 1_000)
      const delivered = await service.checkMessages({ channelId: '1' })
      expect(delivered.type).toBe('delivered')

      repository.enqueueOutbound('1', '第二条', 2_000)
      const fenced = await service.checkMessages({ channelId: '1' })
      expect(fenced.type).toBe('reply_sync_required')
      expect(repository.countPendingOutbound('1')).toBe(1)
      expect(repository.getPresence('1')?.connectionPhase).toBe('need_reply_sync')

      service.recordReply({ channelId: '1', content: '完整回复' })
      expect(repository.getPresence('1')?.pendingReplySyncSince).toBeUndefined()
      expect(repository.getPresence('1')?.pendingOutboundId).toBeUndefined()
      const after = await service.checkMessages({ channelId: '1' })
      expect(after).toMatchObject({ type: 'delivered' })
    } finally {
      repository.close()
    }
  })

  it('keeps reply identity on the delivered queue head when a legacy duplicate is compacted', async () => {
    const { repository, service } = fixture()
    try {
      repository.beginScope('run-1', 1)
      const head = repository.enqueueOutbound('1', '同一问题', 1_000, undefined, false, 'run-1')
      const raw = new DatabaseSync(repository.path)
      try {
        raw.prepare(`
          INSERT INTO channel_outbox (
            id, run_id, channel_id, seq, text, attachments_json, created_at,
            delivered_at, retired_at, silent
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, 0)
        `).run('legacy-duplicate', 'run-1', '1', 2, '同一问题', 1_100)
      } finally {
        raw.close()
      }
      const delivered = await service.checkMessages({ channelId: '1' })
      expect(delivered.type === 'delivered' && delivered.message.id).toBe(head.id)
      const reply = service.recordReply({ channelId: '1', content: '对应队首回复' })
      expect(reply.outboundId).toBe(head.id)
    } finally {
      repository.close()
    }
  })

  it('marks record_reply as hidden unless it is answering a visible delivered user message', async () => {
    const { repository, service } = fixture()
    try {
      service.recordReply({ channelId: '1', content: '后台协作状态，不应进入用户对话' })
      expect(repository.listUnconsumedReplies()[0]).toMatchObject({
        content: '后台协作状态，不应进入用户对话',
        visible: false
      })

      repository.enqueueOutbound('1', '用户真实问题', 1_000)
      const delivered = await service.checkMessages({ channelId: '1' })
      service.recordReply({ channelId: '1', content: '这是给用户的回复' })
      expect(repository.listUnconsumedReplies().at(-1)).toMatchObject({
        content: '这是给用户的回复',
        visible: undefined,
        outboundId: delivered.type === 'delivered' ? delivered.message.id : undefined
      })
    } finally {
      repository.close()
    }
  })

  it('accepts the inline reply parameter as a reply sync equivalent', async () => {
    const { repository, service } = fixture()
    try {
      repository.enqueueOutbound('1', '第一条', 1_000)
      await service.checkMessages({ channelId: '1' })
      repository.enqueueOutbound('1', '第二条', 2_000)
      const result = await service.checkMessages({ channelId: '1', reply: '顺带提交的上轮回复' })
      expect(result.type).toBe('delivered')
      expect(repository.listUnconsumedReplies().map((reply) => reply.content)).toEqual(['顺带提交的上轮回复'])
    } finally {
      repository.close()
    }
  })

  it('does not swallow the same short reply when it belongs to a newly delivered message', async () => {
    const { repository, service } = fixture()
    try {
      repository.enqueueOutbound('1', '第一条', 1_000)
      await service.checkMessages({ channelId: '1' })
      service.recordReply({ channelId: '1', content: '收到' })

      repository.enqueueOutbound('1', '第二条', 2_000)
      await service.checkMessages({ channelId: '1' })
      service.recordReply({ channelId: '1', content: '收到' })

      expect(repository.listUnconsumedReplies().map((reply) => reply.content)).toEqual(['收到', '收到'])
    } finally {
      repository.close()
    }
  })

  it('auto-releases a stale reply gate instead of deadlocking', async () => {
    const { repository, service } = fixture()
    try {
      repository.enqueueOutbound('1', '第一条', 1_000)
      await service.checkMessages({ channelId: '1' })
      // 手动把守门时间拨到宽限期之外，模拟 Agent 长时间未同步
      const presence = repository.getPresence('1')!
      repository.touchPresence('1', { pendingReplySyncSince: presence.pendingReplySyncSince! - 400_000 })
      repository.enqueueOutbound('1', '第二条', 2_000)
      const result = await service.checkMessages({ channelId: '1' })
      expect(result.type).toBe('delivered')
    } finally {
      repository.close()
    }
  })

  it('stops the wait when the tool call is aborted', async () => {
    const { repository, service } = fixture()
    try {
      const abort = new AbortController()
      setTimeout(() => abort.abort(), 150)
      const result = await service.checkMessages({
        channelId: '1',
        signal: abort.signal,
        keepaliveTimeoutMs: 60_000,
        pollIntervalMs: 50
      })
      expect(result).toMatchObject({ type: 'stopped', reason: 'tool_aborted' })
      expect(repository.getPresence('1')?.connectionPhase).toBe('tool_aborted')
    } finally {
      repository.close()
    }
  })

  it('refreshes presence heartbeat evidence while polling', async () => {
    const { repository, service } = fixture()
    try {
      const before = Date.now()
      await service.checkMessages({ channelId: '2', keepaliveTimeoutMs: 1_000, pollIntervalMs: 100 })
      const presence = repository.getPresence('2')!
      expect(presence.lastSeenAt).toBeGreaterThanOrEqual(before)
      expect(presence.turnCount).toBe(1)
    } finally {
      repository.close()
    }
  })


  it('skips hold-token messages for the issuing session and delivers them to the rebuilt session (会话交接「等待新会话」)', async () => {
    const { repository, service } = fixture()
    try {
      repository.enqueueOutbound('1', '【会话交接】请读取转录', 1_000, undefined, false, undefined, { holdSessionToken: 'seat-A' })
      // 现任会话（seat-A）轮询：队列对它为空 → keepalive；保持位消息原地不动
      const held = await service.checkMessages({ channelId: '1', session: 'seat-A', keepaliveTimeoutMs: 1_000, pollIntervalMs: 100 })
      expect(held.type).toBe('keepalive')
      expect(repository.countPendingOutbound('1')).toBe(1)
      // 无令牌的旧会话同样取不到
      const legacy = await service.checkMessages({ channelId: '1', keepaliveTimeoutMs: 1_000, pollIntervalMs: 100 })
      expect(legacy.type).toBe('keepalive')
      // 重建后的新会话（seat-B）首次轮询即取到，并打开回复守门
      const delivered = await service.checkMessages({ channelId: '1', session: 'seat-B' })
      expect(delivered).toMatchObject({ type: 'delivered', message: { text: '【会话交接】请读取转录' } })
      expect(repository.countPendingOutbound('1')).toBe(0)
      expect(repository.getPresence('1')?.pendingOutboundId).toBe(delivered.type === 'delivered' ? delivered.message.id : undefined)
    } finally {
      repository.close()
    }
  })

  it('识别 SQLite 瞬时锁错误，其它错误不算瞬断', () => {
    expect(isTransientStorageError(busyError())).toBe(true)
    expect(isTransientStorageError(Object.assign(new Error('x'), { errcode: 6 }))).toBe(true)
    expect(isTransientStorageError(new Error('SQLITE_BUSY: database is locked'))).toBe(true)
    expect(isTransientStorageError(new Error('no such table: channel_outbox'))).toBe(false)
    expect(isTransientStorageError(undefined)).toBe(false)
  })

  it('轮询途中撞上写锁（拾光桌面端启停）：按间隔重试，同一次调用仍把消息投递出去', async () => {
    const { repository } = fixture()
    try {
      repository.enqueueOutbound('1', '重启期间入队的消息', 1_000)
      // 开场心跳 1 次 + 轮询取队列 2 次都撞锁，第 3 次才放行。
      const injected = flaky(repository, { touchPresence: 1, listPendingOutbound: 2 })
      const service = new ChannelMessageService(injected.repository)
      const result = await service.checkMessages({ channelId: '1', keepaliveTimeoutMs: 5_000, pollIntervalMs: 60 })
      expect(result).toMatchObject({ type: 'delivered', turnCount: 1, deliveredCount: 1 })
      expect(result.type === 'delivered' && result.message.text).toBe('重启期间入队的消息')
      expect(injected.calls.listPendingOutbound).toBe(3)
      // 开场重试没有把轮次记两遍；投递后守门正常打开。
      expect(repository.getPresence('1')).toMatchObject({ turnCount: 1, connectionPhase: 'processing', deliveredCount: 1 })
      expect(repository.getPresence('1')?.pendingOutboundId).toBe(result.type === 'delivered' ? result.message.id : undefined)
    } finally {
      repository.close()
    }
  })

  it('投递后的守门写入失败：事务回滚队列和计数，重试仍交付原消息一次', async () => {
    const { repository, service } = fixture()
    const original = repository.touchPresence.bind(repository)
    let processingAttempts = 0
    const spy = vi.spyOn(repository, 'touchPresence').mockImplementation((channel, patch, now) => {
      const result = original(channel, patch, now)
      if (patch.connectionPhase === 'processing' && ++processingAttempts === 1) throw busyError()
      return result
    })
    try {
      const message = repository.enqueueOutbound('1', '事务重试不丢消息')
      const result = await service.checkMessages({ channelId: '1', pollIntervalMs: 100, keepaliveTimeoutMs: 1000 })
      expect(result).toMatchObject({ type: 'delivered', message: { id: message.id }, deliveredCount: 1 })
      expect(processingAttempts).toBe(2)
      expect(repository.getPresence('1')).toMatchObject({ pendingOutboundId: message.id, deliveredCount: 1 })
      expect(repository.listPendingOutbound('1')).toHaveLength(0)
    } finally {
      spy.mockRestore()
      repository.close()
    }
  })

  it('整个 keepalive 周期都不可用才以 storage_unavailable 收尾；连续多次后不再建议重试，一次成功即清零', async () => {
    const { repository } = fixture()
    try {
      const injected = flaky(repository, { touchPresence: 1_000 })
      const service = new ChannelMessageService(injected.repository)
      const poll = () => service.checkMessages({ channelId: '1', keepaliveTimeoutMs: 1_000, pollIntervalMs: 100 })

      const first = await poll()
      expect(first).toMatchObject({ type: 'storage_unavailable', retryable: true, failures: 1 })
      expect(first.type === 'storage_unavailable' && first.message).toContain('database is locked')
      // 一个周期内至少重试了多轮，而不是首错即返。
      expect(injected.calls.touchPresence).toBeGreaterThanOrEqual(5)

      for (let round = 2; round < CHANNEL_STORAGE_RETRY_LIMIT; round += 1) {
        expect(await poll()).toMatchObject({ type: 'storage_unavailable', retryable: true, failures: round })
      }
      expect(await poll()).toMatchObject({ type: 'storage_unavailable', retryable: false, failures: CHANNEL_STORAGE_RETRY_LIMIT })

      // 存储恢复：同一服务实例的下一次轮询正常 keepalive；随后再故障，计数从 1 重新开始。
      injected.heal()
      expect(await poll()).toMatchObject({ type: 'keepalive', round: 1 })
      injected.heal({ touchPresence: 1_000 })
      expect(await poll()).toMatchObject({ type: 'storage_unavailable', retryable: true, failures: 1 })
    } finally {
      repository.close()
    }
  }, 12_000)

  it('truncates tool-call token leakage in record_reply content and warns the agent', async () => {
    const { repository, service } = fixture()
    try {
      // 工具调用特殊标记用拼接构造，避免字面序列被传输层误解析
      const leaked = '**结论先说：分析到一半 '
        + '<|' + 'close' + '|>' + 'argument' + '<|' + 'sep' + '|>'
      const result = service.recordReply({ channelId: '1', content: leaked })
      expect((result as { contentWarning?: string }).contentWarning).toContain('泄漏')
      expect(repository.listUnconsumedReplies()[0]?.content).toBe('结论先说：分析到一半')

      const clean = service.recordReply({ channelId: '1', content: '正常回复 **加粗** 保留' })
      expect((clean as { contentWarning?: string }).contentWarning).toBeUndefined()
      expect(repository.listUnconsumedReplies().at(-1)?.content).toBe('正常回复 **加粗** 保留')
    } finally {
      repository.close()
    }
  })
})
