import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { ChannelMessageService } from '../src/application/channel-message-service'
import { ChannelMessageRelay } from '../src/application/channel-message-relay'
import { CHANNEL_PRESENCE_STALE_MS, CHANNEL_PROCESSING_STALE_MS } from '../src/domain/channel-message'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import type { DesktopSnapshot } from '../src/shared/desktop-api'

function fixture(now = 10_000) {
  const path = join(mkdtempSync(join(tmpdir(), 'qingtian-channel-relay-')), 'channel.sqlite3')
  const repository = new SqliteChannelMessageRepository(path)
  let clock = now
  const relay = new ChannelMessageRelay(repository, () => clock)
  return {
    repository,
    relay,
    advance: (ms: number) => { clock += ms },
    setNow: (value: number) => { clock = value }
  }
}

function baseSnapshot(): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: 'ws://localhost/', attempt: 0, lastError: '' },
    sessions: [],
    conversations: {},
    protocolIssues: [],
    updatedAt: 0
  }
}

describe('ChannelMessageRelay', () => {

  it('rejects a delayed dispatcher write from the previous TeamRun after scope switch', () => {
    const { repository, relay, setNow } = fixture(1_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      relay.resetScope('run-old', 1_000)
      setNow(10_000)
      relay.resetScope('run-new', 10_000)

      expect(() => relay.sendMessage({
        channelId: '1', text: '旧调度器迟到通知', silent: true, scopeRunId: 'run-old'
      })).toThrowError(/已结束的 TeamRun/)
      expect(repository.countPendingOutbound('1')).toBe(0)
      expect(repository.currentScopeRunId()).toBe('run-new')
    } finally {
      repository.close()
    }
  })




  it('routes outbound messages for embedded channels into the SQLite queue', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      const accepted = relay.sendMessage({ channelId: '1', text: '  开始任务  ' })
      expect(accepted.commandId).toBeTruthy()
      const pending = repository.listPendingOutbound('1')
      expect(pending).toHaveLength(1)
      expect(pending[0]?.text).toBe('开始任务')
      const snapshot = relay.applyTo(baseSnapshot())
      expect(snapshot.conversations['1']).toMatchObject([
        { role: 'user', text: '开始任务', status: 'complete', source: 'desktop' }
      ])
      expect(snapshot.sessions[0]).toMatchObject({ channelId: '1', deliveryMode: 'queued' })
    } finally {
      repository.close()
    }
  })

  it('emits when presence crosses the stale threshold so the UI flips offline without any data change', () => {
    vi.useFakeTimers()
    const { repository, relay, advance } = fixture(10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.touchPresence('1', { lastSeenAt: 10_000, waiting: true, connectionPhase: 'waiting' })
      // 先让会话进入缓存（在线、等待中）
      const before = relay.applyTo(baseSnapshot())
      expect(before.sessions[0]).toMatchObject({ channelId: '1', online: true, status: 'waiting', runtimeEvidence: 'active' })

      let emits = 0
      const unsubscribe = relay.subscribe(() => { emits += 1 })
      relay.start(250)
      // 未越阈值：轮询 tick 不产生 emit
      advance(60_000)
      vi.advanceTimersByTime(300)
      expect(emits).toBe(0)
      // 越过 waiting 120s 阈值：下一个 tick 必须主动 emit，且快照翻转为离线
      advance(61_000)
      vi.advanceTimersByTime(300)
      expect(emits).toBe(1)
      const after = relay.applyTo(baseSnapshot())
      expect(after.sessions[0]).toMatchObject({ online: false, status: 'offline', runtimeEvidence: 'suspected' })
      // 翻转完成后不再重复 emit
      vi.advanceTimersByTime(600)
      expect(emits).toBe(1)
      unsubscribe()
    } finally {
      relay.stop()
      vi.useRealTimers()
      repository.close()
    }
  })

  it('persists explicit Cursor termination across time and revives only on real MCP activity', () => {
    const { repository, relay, setNow } = fixture(10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'processing', lastSeenAt: 10_000
      }, 10_000)
      expect(relay.applyTo(baseSnapshot()).sessions[0]?.online).toBe(true)

      expect(relay.markCursorStopped('1', 11_000)).toBe(true)
      setNow(11_100)
      expect(relay.applyTo(baseSnapshot()).sessions[0]).toMatchObject({
        status: 'offline', online: false, connected: false, waiting: false,
        connectionPhase: 'cursor_stopped', runtimeEvidence: 'stopped'
      })

      // 时间流逝和进程重启读取同一 presence 都不能把明确终态恢复成在线。
      setNow(12_000)
      const restarted = new ChannelMessageRelay(repository, () => 12_000)
      expect(restarted.applyTo(baseSnapshot()).sessions[0]?.online).toBe(false)

      // 只有 Agent 真实重新进入 check_messages 才构成恢复证据。
      repository.touchPresence('1', {
        waiting: true, connectionPhase: 'waiting', lastSeenAt: 12_100
      }, 12_100)
      setNow(12_100)
      expect(restarted.applyTo(baseSnapshot()).sessions[0]).toMatchObject({
        status: 'waiting', online: true, waiting: true
      })
    } finally {
      repository.close()
    }
  })

  it('does not duplicate timeline or queue entries when the same text is submitted twice quickly', () => {
    const { repository, relay, advance } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      relay.sendMessage({ channelId: '1', text: '汇报当前进度' })
      advance(2_000)
      relay.sendMessage({ channelId: '1', text: ' 汇报当前进度 ' })

      expect(repository.listPendingOutbound('1').map((message) => message.text)).toEqual(['汇报当前进度'])
      const snapshot = relay.applyTo(baseSnapshot())
      expect(snapshot.conversations['1']).toHaveLength(1)
      expect(snapshot.conversations['1']?.[0]).toMatchObject({ role: 'user', text: '汇报当前进度' })
    } finally {
      repository.close()
    }
  })

  it('delivers silent messages to the queue without entering the conversation timeline', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      // 系统内部协作通知：即使调用方漏传 silent，也必须静默投递。
      const accepted = relay.sendMessage({ channelId: '1', text: '【拾光内部协作通知】消息 ID：x' })
      relay.sendMessage({ channelId: '1', text: '用户真实消息' })
      // 两条都进待投递队列（Agent 都能收到）
      expect(repository.listPendingOutbound('1')).toHaveLength(2)
      // 时间线只显示用户真实消息，协作通知不可见
      const snapshot = relay.applyTo(baseSnapshot())
      expect(snapshot.conversations['1']).toMatchObject([{ role: 'user', text: '用户真实消息' }])
      expect(snapshot.conversations['1']).toHaveLength(1)
      expect(snapshot.commandReceipts?.[accepted.commandId]).toMatchObject({
        role: 'user',
        text: '【拾光内部协作通知】消息 ID：x',
        status: 'complete',
        silent: true
      })
      const [queued] = repository.listPendingOutbound('1')
      expect(queued?.silent).toBe(true)
    } finally {
      repository.close()
    }
  })

  it('does not hydrate legacy internal notifications that were stored as visible rows', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      const legacy = new DatabaseSync(repository.path)
      try {
        legacy.prepare(`
          INSERT INTO channel_outbox (id, channel_id, seq, text, attachments_json, created_at, delivered_at, silent)
          VALUES (?, ?, ?, ?, NULL, ?, ?, 0)
        `).run(
          'legacy-visible-internal',
          '1',
          1,
          '【拾光内部协作通知】消息 ID：legacy',
          1_100,
          1_200
        )
      } finally {
        legacy.close()
      }

      relay.resetScope('run-a', 1_000)
      expect(relay.applyTo(baseSnapshot()).conversations['1']).toBeUndefined()
    } finally {
      repository.close()
    }
  })

  it('keeps embedded sessions queue-sendable after their heartbeat is stale', () => {
    const { repository, relay, advance } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.touchPresence('1', { waiting: true, connectionPhase: 'waiting' }, 10_000)
      advance(CHANNEL_PRESENCE_STALE_MS + 1)

      const snapshot = relay.applyTo(baseSnapshot())
      expect(snapshot.sessions[0]).toMatchObject({
        channelId: '1',
        online: false,
        deliveryMode: 'queued'
      })
      expect(() => relay.sendMessage({ channelId: '1', text: '继续' })).not.toThrow()
      expect(repository.listPendingOutbound('1')[0]?.text).toBe('继续')
    } finally {
      repository.close()
    }
  })

  it('refuses to send for channels that are not embedded', () => {
    const { repository, relay } = fixture()
    try {
      expect(() => relay.sendMessage({ channelId: '9', text: 'x' })).toThrowError(/尚未接入拾光内嵌通道/)
      expect(() => relay.sendMessage({ channelId: 'abc', text: 'x' })).toThrowError(/通道号无效/)
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      expect(() => relay.sendMessage({ channelId: '1', text: '   ' })).toThrowError(/不能为空/)
    } finally {
      repository.close()
    }
  })

  it('converts agent replies into conversation entries exactly once', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.recordReply({ channelId: '1', content: '完成，已修改三处。' }, 500)
      relay.pollReplies()
      relay.pollReplies()
      const snapshot = relay.applyTo(baseSnapshot())
      expect(snapshot.conversations['1']).toHaveLength(1)
      expect(snapshot.conversations['1']?.[0]).toMatchObject({
        role: 'assistant',
        text: '完成，已修改三处。',
        status: 'complete',
        source: 'cursor'
      })
      expect(repository.listUnconsumedReplies()).toHaveLength(0)
    } finally {
      repository.close()
    }
  })

  it('consumes hidden background replies without projecting them into the visible timeline', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      const service = new ChannelMessageService(repository)
      service.recordReply({ channelId: '1', content: '继续监控，无需用户处理' })

      relay.pollReplies()
      const snapshot = relay.applyTo(baseSnapshot())
      expect(snapshot.conversations['1']).toBeUndefined()
      expect(repository.listUnconsumedReplies()).toHaveLength(0)
    } finally {
      repository.close()
    }
  })

  it('suppresses repeated identical assistant replies in the visible timeline', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.recordReply({ channelId: '1', content: '进展更新：\\n\\n- builder：执行中\\n\\n继续监控。' }, 1_000)
      repository.recordReply({ channelId: '1', content: '进展更新：\n\n- builder：执行中\n\n继续监控。' }, 45_000)
      repository.recordReply({ channelId: '1', content: '真正的新结论。' }, 60_000)

      relay.pollReplies()
      const snapshot = relay.applyTo(baseSnapshot())
      expect(snapshot.conversations['1']?.map((entry) => entry.text)).toEqual([
        '进展更新：\n\n- builder：执行中\n\n继续监控。',
        '真正的新结论。'
      ])
      expect(repository.listUnconsumedReplies()).toHaveLength(0)
    } finally {
      repository.close()
    }
  })


  it('persists attachments with outbound messages, writes base64 payloads to disk and projects them into the timeline', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      const png = Buffer.from('fake-png-bytes').toString('base64')
      relay.sendMessage({
        channelId: '1',
        text: '看下这张设计稿',
        attachments: [
          { id: 'a1', name: '设计稿.png', mimeType: 'image/png', size: 14, data: png },
          { id: 'a2', name: '日志.txt', mimeType: 'text/plain', size: 3_000_000, path: '/var/log/app.log' }
        ]
      })
      const [queued] = repository.listPendingOutbound('1')
      expect(queued?.attachments).toHaveLength(2)
      // base64 小文件已落盘并转为路径引用；大文件保持原路径不复制
      const dropped = queued?.attachments?.[0]
      expect(dropped?.data).toBeUndefined()
      expect(dropped?.path).toContain('channel-attachments')
      expect(existsSync(dropped!.path!)).toBe(true)
      expect(readFileSync(dropped!.path!, 'utf8')).toBe('fake-png-bytes')
      expect(dropped?.previewUrl).toMatch(/^data:image\/png;base64,/)
      expect(queued?.attachments?.[1]).toMatchObject({ name: '日志.txt', path: '/var/log/app.log' })
      // 时间线透出附件（UI 预览/展示用）
      const snapshot = relay.applyTo(baseSnapshot())
      expect(snapshot.conversations['1']?.[0]?.attachments).toHaveLength(2)
    } finally {
      repository.close()
    }
  })

  it('dedupes same-name attachments so both payloads survive on disk', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      relay.sendMessage({
        channelId: '1',
        text: '两张截图',
        attachments: [
          { id: 'a1', name: 'image.png', mimeType: 'image/png', size: 3, data: Buffer.from('one').toString('base64') },
          { id: 'a2', name: 'image.png', mimeType: 'image/png', size: 3, data: Buffer.from('two').toString('base64') }
        ]
      })
      const [queued] = repository.listPendingOutbound('1')
      const names = queued?.attachments?.map((attachment) => attachment.name)
      expect(names).toEqual(['image.png', 'image-2.png'])
      const paths = queued?.attachments?.map((attachment) => attachment.path)
      expect(paths?.[0]).toBeTruthy()
      expect(paths?.[1]).toBeTruthy()
      expect(paths?.[0]).not.toBe(paths?.[1])
      expect(readFileSync(paths![0]!, 'utf8')).toBe('one')
      expect(readFileSync(paths![1]!, 'utf8')).toBe('two')
    } finally {
      repository.close()
    }
  })

  it('accepts attachment-only messages from composer to delivery queue and timeline', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      const png = Buffer.from('pure-attachment').toString('base64')
      // 纯附件（空文本）：从输入框一路到出站队列与时间线
      relay.sendMessage({
        channelId: '1',
        text: '',
        attachments: [{ id: 'a1', name: '截图.png', mimeType: 'image/png', size: 15, data: png }]
      })
      const [queued] = repository.listPendingOutbound('1')
      expect(queued?.text).toBe('')
      expect(queued?.attachments?.[0]).toMatchObject({ name: '截图.png' })
      expect(queued?.attachments?.[0]?.path).toContain('channel-attachments')
      const snapshot = relay.applyTo(baseSnapshot())
      expect(snapshot.conversations['1']?.[0]).toMatchObject({ role: 'user', text: '' })
      expect(snapshot.conversations['1']?.[0]?.attachments).toHaveLength(1)
    } finally {
      repository.close()
    }
  })

  it('enforces attachment count and size limits', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      const oversized = Buffer.alloc(3 * 1024 * 1024).toString('base64')
      expect(() => relay.sendMessage({
        channelId: '1',
        text: 'x',
        attachments: [{ id: 'a', name: 'big.bin', mimeType: 'application/octet-stream', size: 3_000_000, data: oversized }]
      })).toThrowError(/超过 2 MB/)
      expect(() => relay.sendMessage({
        channelId: '1',
        text: 'x',
        attachments: Array.from({ length: 9 }, (_, index) => ({
          id: `a${index}`, name: `f${index}.txt`, mimeType: 'text/plain', size: 1, path: '/tmp/x'
        }))
      })).toThrowError(/最多 8 个/)
      expect(() => relay.sendMessage({
        channelId: '1',
        text: 'x',
        attachments: [{ id: 'a', name: '空.txt', mimeType: 'text/plain', size: 0 }]
      })).toThrowError(/至少提供一个/)
      expect(repository.countPendingOutbound('1')).toBe(0)
    } finally {
      repository.close()
    }
  })




  it('shares conversation and session references across unchanged apply rounds (structural sharing)', () => {
    const { repository, relay, setNow } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.markChannelEmbedded('2', 'workspace-a', '/workspace/a')
      repository.recordReply({ channelId: '1', content: '通道一回复' }, 100)
      repository.recordReply({ channelId: '2', content: '通道二回复' }, 100)
      repository.touchPresence('1', { waiting: true, connectionPhase: 'waiting', lastSeenAt: 9_000 }, 9_000)
      repository.touchPresence('2', { waiting: true, connectionPhase: 'waiting', lastSeenAt: 9_000 }, 9_000)
      relay.pollReplies()
      setNow(9_500)
      const first = relay.applyTo(baseSnapshot())
      const second = relay.applyTo(baseSnapshot())
      // 未变通道：会话条目与 session 引用都恒定（渲染层 memo 红利）
      expect(second.conversations['1']).toBe(first.conversations['1'])
      expect(second.conversations['2']).toBe(first.conversations['2'])
      expect(second.sessions.find((s) => s.channelId === '1')).toBe(first.sessions.find((s) => s.channelId === '1'))

      // 通道一收到新回复：只有通道一的 conversations 引用变，通道二保持共享
      repository.recordReply({ channelId: '1', content: '通道一第二条' }, 200)
      relay.pollReplies()
      const third = relay.applyTo(baseSnapshot())
      expect(third.conversations['1']).not.toBe(first.conversations['1'])
      expect(third.conversations['1']).toHaveLength(2)
      expect(third.conversations['2']).toBe(first.conversations['2'])
      expect(third.sessions.find((s) => s.channelId === '2')).toBe(first.sessions.find((s) => s.channelId === '2'))
    } finally {
      repository.close()
    }
  })

  it('rebuilds the cached session when presence actually changes', () => {
    const { repository, relay, setNow } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.touchPresence('1', { waiting: true, connectionPhase: 'waiting', lastSeenAt: 9_000 }, 9_000)
      setNow(9_500)
      const first = relay.applyTo(baseSnapshot())
      repository.touchPresence('1', { waiting: false, connectionPhase: 'processing', lastSeenAt: 9_600 }, 9_600)
      const second = relay.applyTo(baseSnapshot())
      expect(second.sessions[0]).not.toBe(first.sessions[0])
      expect(second.sessions[0]).toMatchObject({ status: 'running', waiting: false })
    } finally {
      repository.close()
    }
  })

  it('projects presence into session overrides with queue depth', () => {
    const { repository, relay, setNow } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.enqueueOutbound('1', '待取', 100)
      repository.touchPresence('1', {
        waiting: true,
        connectionPhase: 'waiting',
        lastSeenAt: 9_000,
        turnCount: 2
      }, 9_000)
      setNow(9_500)
      const snapshot = relay.applyTo(baseSnapshot())
      const [session] = snapshot.sessions
      expect(session).toMatchObject({
        channelId: '1',
        status: 'waiting',
        online: true,
        connected: true,
        waiting: true,
        queueDepth: 1,
        connectionPhase: 'waiting',
        lastSeenAt: 9_000
      })
      expect(session?.healthEvidence.join(' ')).toContain('内嵌 MCP 活性正常')
    } finally {
      repository.close()
    }
  })

  it('marks sessions offline when presence goes stale', () => {
    const { repository, relay, setNow } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.touchPresence('1', { waiting: true, connectionPhase: 'waiting', lastSeenAt: 1_000 }, 1_000)
      setNow(1_000 + CHANNEL_PRESENCE_STALE_MS + 1)
      const snapshot = relay.applyTo(baseSnapshot())
      const [session] = snapshot.sessions
      expect(session).toMatchObject({ status: 'offline', online: false, waiting: false })
      expect(session?.healthEvidence.join(' ')).toContain('内嵌 MCP 活性缺失')
    } finally {
      repository.close()
    }
  })

  it('keeps processing-phase channels online beyond the heartbeat window (long task in flight)', () => {
    const { repository, relay, setNow } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      // Agent 取走消息进入处理态；长任务（构建/测试/大改造）期间按协议不再触碰 MCP
      repository.touchPresence('1', { waiting: false, connectionPhase: 'processing', lastSeenAt: 1_000 }, 1_000)
      setNow(1_000 + CHANNEL_PRESENCE_STALE_MS + 60_000)
      const snapshot = relay.applyTo(baseSnapshot())
      expect(snapshot.sessions[0]).toMatchObject({
        status: 'running',
        online: true,
        connected: true,
        waiting: false,
        connectionPhase: 'processing'
      })
    } finally {
      repository.close()
    }
  })

  it('expires processing-phase presence after the long-task grace window', () => {
    const { repository, relay, setNow } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.touchPresence('1', { waiting: false, connectionPhase: 'processing', lastSeenAt: 1_000 }, 1_000)
      setNow(1_000 + CHANNEL_PROCESSING_STALE_MS + 1)
      const snapshot = relay.applyTo(baseSnapshot())
      expect(snapshot.sessions[0]).toMatchObject({ status: 'offline', online: false, runtimeEvidence: 'suspected' })
    } finally {
      repository.close()
    }
  })

  it('keeps plugin-projected sessions for channels that are not embedded', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      const pluginSession = {
        id: 'qingtian-channel:2',
        channelId: '2',
        generation: 0,
        displayName: 'QingTian CH-2',
        roleName: '未绑定外置团队',
        status: 'running' as const,
        currentTask: '',
        queueDepth: 0,
        connectionPhase: 'processing',
        online: true,
        connected: true,
        waiting: false,
        workingFiles: [],
        healthEvidence: ['MCP 运行时心跳正常']
      }
      const snapshot = relay.applyTo({ ...baseSnapshot(), sessions: [pluginSession] })
      const channels = snapshot.sessions.map((session) => session.channelId).sort()
      expect(channels).toEqual(['1', '2'])
      expect(snapshot.sessions.find((session) => session.channelId === '2')).toMatchObject({
        status: 'running',
        healthEvidence: ['MCP 运行时心跳正常']
      })
    } finally {
      repository.close()
    }
  })

  it('drops pre-scope replies on reset instead of surfacing stale history', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.recordReply({ channelId: '1', content: '上一轮的旧回复' }, 1_000)
      relay.resetScope('run-next', 10_000)
      relay.pollReplies()
      expect(relay.applyTo(baseSnapshot()).conversations['1']).toBeUndefined()
      repository.recordReply({ channelId: '1', content: '新域回复' }, 11_000)
      relay.pollReplies()
      expect(relay.applyTo(baseSnapshot()).conversations['1']).toHaveLength(1)
    } finally {
      repository.close()
    }
  })


  it('does not hydrate previous-scope outbound messages', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.enqueueOutbound('1', '上一轮用户消息', 1_000)
      repository.recordReply({ channelId: '1', content: '上一轮回复' }, 1_000)
      relay.resetScope('run-next', 10_000)
      expect(relay.applyTo(baseSnapshot()).conversations['1']).toBeUndefined()
    } finally {
      repository.close()
    }
  })
})
