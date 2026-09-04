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

  it('projects hold-token messages as 等待新会话, lets the user release or withdraw them, and clears the flag on delivery', () => {
    vi.useFakeTimers()
    const { repository, relay } = fixture(20_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      relay.resetScope('run-hold', 20_000)
      relay.start(250)
      relay.sendMessage({ channelId: '1', text: '【会话交接】读转录', holdSessionToken: 'seat-A' })
      relay.sendMessage({ channelId: '1', text: '普通排队消息' })
      let entries = relay.applyTo(baseSnapshot()).conversations['1']!
      expect(entries.map((entry) => [entry.text, entry.heldForNextSession ?? false])).toEqual([
        ['【会话交接】读转录', true],
        ['普通排队消息', false]
      ])
      expect(relay.applyTo(baseSnapshot()).sessions[0]?.queueDepth).toBe(2)
      const heldEntry = entries[0]!
      const plainEntry = entries[1]!

      // 撤回普通消息：时间线立即移除、队列计数减一、SQLite 行软删除
      expect(relay.withdrawQueuedMessage('1', plainEntry.id)).toBe(true)
      expect(relay.withdrawQueuedMessage('1', plainEntry.id)).toBe(false)
      entries = relay.applyTo(baseSnapshot()).conversations['1']!
      expect(entries.map((entry) => entry.id)).toEqual([heldEntry.id])
      expect(relay.applyTo(baseSnapshot()).sessions[0]?.queueDepth).toBe(1)
      expect(repository.listPendingOutbound('1')).toHaveLength(1)

      // 现任会话（seat-A）取不到保持位消息；新会话（seat-B）取走后时间线的 held 标记随投递清除
      expect(repository.listPendingOutbound('1', { forSession: 'seat-A' })).toHaveLength(0)
      const delivered = repository.listPendingOutbound('1', { forSession: 'seat-B' })[0]!
      repository.markOutboundDelivered([delivered.id], 20_900)
      vi.advanceTimersByTime(300)
      entries = relay.applyTo(baseSnapshot()).conversations['1']!
      expect(entries[0]).toMatchObject({ id: heldEntry.id, deliveredAt: 20_900 })
      expect(entries[0]?.heldForNextSession).toBeUndefined()

      // 重启水合：撤回的消息不回流，已投递的保持位消息不再带 held 标记
      const rehydrated = new ChannelMessageRelay(repository, () => 21_000)
      rehydrated.start(250)
      try {
        const hydrated = rehydrated.applyTo(baseSnapshot()).conversations['1']!
        expect(hydrated.map((entry) => entry.text)).toEqual(['【会话交接】读转录'])
        expect(hydrated[0]?.heldForNextSession).toBeUndefined()
      } finally {
        rehydrated.stop()
      }
    } finally {
      relay.stop()
      vi.useRealTimers()
      repository.close()
    }
  })

  it('releases a hold so the current session can take the message on its next poll', () => {
    const { repository, relay } = fixture(30_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      relay.resetScope('run-release', 30_000)
      relay.sendMessage({ channelId: '1', text: '【会话交接】读转录', holdSessionToken: 'seat-A' })
      const entry = relay.applyTo(baseSnapshot()).conversations['1']![0]!
      expect(entry.heldForNextSession).toBe(true)
      expect(relay.releaseQueuedMessage('1', entry.id)).toBe(true)
      expect(relay.releaseQueuedMessage('1', entry.id)).toBe(false)
      expect(relay.applyTo(baseSnapshot()).conversations['1']![0]?.heldForNextSession).toBeUndefined()
      expect(repository.listPendingOutbound('1', { forSession: 'seat-A' })).toHaveLength(1)
    } finally {
      repository.close()
    }
  })

  it('projects the authoritative MCP delivery time into the live conversation entry', () => {
    vi.useFakeTimers()
    const { repository, relay } = fixture(10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      relay.resetScope('run-delivery', 10_000)
      relay.sendMessage({ channelId: '1', text: '排队后再取走' })
      relay.start(250)
      const pending = repository.listPendingOutbound('1')[0]!
      expect(relay.applyTo(baseSnapshot()).conversations['1']?.[0]?.deliveredAt).toBeUndefined()

      repository.markOutboundDelivered([pending.id], 10_500)
      vi.advanceTimersByTime(300)

      expect(relay.applyTo(baseSnapshot()).conversations['1']?.[0]?.deliveredAt).toBe(10_500)
    } finally {
      relay.stop()
      vi.useRealTimers()
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

  it('markCursorStopped keeps the open reply-sync gate so the owed record_reply stays visible', () => {
    const { repository, relay, setNow } = fixture(10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      const outbound = repository.enqueueOutbound('1', '你是谁', 10_000)
      repository.markOutboundDelivered([outbound.id], 10_500)
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'processing', lastSeenAt: 10_500,
        pendingReplySyncSince: 10_500, pendingOutboundId: outbound.id
      }, 10_500)

      // Composer 终止不是回复契约的关闭条件：Agent（MCP 循环）仍欠 record_reply。
      setNow(11_000)
      expect(relay.markCursorStopped('1', 11_000)).toBe(true)
      expect(repository.getPresence('1')).toMatchObject({
        connectionPhase: 'cursor_stopped',
        pendingOutboundId: outbound.id,
        pendingReplySyncSince: 10_500
      })

      const service = new ChannelMessageService(repository)
      const reply = service.recordReply({ channelId: '1', content: '这是最终回复。' })
      expect(reply.visible).toBeUndefined()
      expect(reply.outboundId).toBe(outbound.id)
    } finally {
      repository.close()
    }
  })

  it('completeScope keeps the open reply-sync gate so a record_reply after run completion stays visible', () => {
    const { repository, relay, setNow } = fixture(10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      relay.resetScope('run-a', 10_000)
      const outbound = repository.enqueueOutbound('1', '你是谁', 11_000)
      repository.markOutboundDelivered([outbound.id], 11_500)
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'processing', lastSeenAt: 11_500,
        pendingReplySyncSince: 11_500, pendingOutboundId: outbound.id
      }, 11_500)

      // run 状态切换（2026-09-01 事故：completeScope 清门让回复以 visible=0 落库）
      setNow(12_000)
      relay.completeScope(12_000)
      const presence = repository.getPresence('1')
      expect(presence?.pendingOutboundId).toBe(outbound.id)
      expect(presence?.pendingReplySyncSince).toBe(11_500)

      const service = new ChannelMessageService(repository)
      const reply = service.recordReply({ channelId: '1', content: '我是拾光团队的构建工程师。' })
      expect(reply.visible).toBeUndefined()
      expect(reply.outboundId).toBe(outbound.id)
    } finally {
      repository.close()
    }
  })

  it('clears residual cursor_stopped phases when a new TeamRun scope begins (2026-09-01 incident)', () => {
    const { repository, relay, setNow } = fixture(10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      // 上一轮结束时遗留的终止相位：presence 行不按 run 分表，跨轮存活。
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'cursor_stopped', lastSeenAt: 9_000
      }, 9_000)
      expect(repository.getPresence('1')?.connectionPhase).toBe('cursor_stopped')

      // 新 run 启动（resetScope → beginScope）：终止相位必须被清成 reviving，
      // 否则新 Agent 14:19:52 签到后 14:19:58 就被清扫器按 runtimeEvidence=stopped
      // 判定主控失联。
      setNow(20_000)
      relay.resetScope('run-new', 20_000)
      const after = repository.getPresence('1')
      expect(after?.connectionPhase).toBe('reviving')
      // 相位残留已清：会话不再被投影成 runtimeEvidence=stopped（清扫器对
      // reviving/active/suspected 都不报警）。lastSeenAt 保留旧值——它是
      // 真实证据不伪造；旧心跳仍在 120s 窗口内则短暂显示在线（reviving），
      // 超窗即离线，均不会误判「已终止」。
      setNow(20_001)
      const session = relay.applyTo(baseSnapshot()).sessions[0]
      expect(session?.connectionPhase).toBe('reviving')
      expect(session?.runtimeEvidence).not.toBe('stopped')
      // 旧心跳超窗后自然离线（suspected，非 stopped）。
      setNow(20_000 + CHANNEL_PRESENCE_STALE_MS + 1_000)
      const stale = relay.applyTo(baseSnapshot()).sessions[0]
      expect(stale).toMatchObject({ online: false, runtimeEvidence: 'suspected' })
    } finally {
      repository.close()
    }
  })

  it('retires every channel presence when the scope moves to a different run (session fence)', () => {
    const { repository, relay, setNow } = fixture(10_000)
    try {
      for (const channelId of ['1', '2']) repository.markChannelEmbedded(channelId, 'workspace-a', '/workspace/a')
      relay.resetScope('run-independent', 10_000)
      // 独立批次的两个会话都在岗（心跳新鲜）。
      repository.touchPresence('1', { waiting: true, connectionPhase: 'waiting', lastSeenAt: 19_000 }, 19_000)
      repository.touchPresence('2', { waiting: false, connectionPhase: 'processing', lastSeenAt: 19_500 }, 19_500)
      setNow(20_000)
      expect(relay.applyTo(baseSnapshot()).sessions.map((session) => session.online)).toEqual([true, true])

      // 切到团队 run：旧心跳全部来自上一轮会话，不能再点亮新席位。
      relay.resetScope('run-team', 20_000)
      for (const channelId of ['1', '2']) {
        expect(repository.getPresence(channelId)).toMatchObject({ connectionPhase: 'retired', waiting: false })
      }
      setNow(20_001)
      const sessions = relay.applyTo(baseSnapshot()).sessions
      expect(sessions.map((session) => session.online)).toEqual([false, false])
      // retired 是明确的作用域终止证据，不是「心跳暂时没刷新」。
      expect(sessions.every((session) => session.runtimeEvidence === 'stopped')).toBe(true)
      // lastSeenAt 是真实证据，不伪造：只改相位。
      expect(repository.getPresence('1')?.lastSeenAt).toBe(19_000)
    } finally {
      repository.close()
    }
  })

  it('keeps retired presence retired on a same-run scope replay (restart brings no life evidence)', () => {
    const { repository, relay, setNow } = fixture(10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      relay.resetScope('run-a', 10_000)
      repository.touchPresence('1', { waiting: true, connectionPhase: 'waiting', lastSeenAt: 19_000 }, 19_000)
      setNow(20_000)
      relay.resetScope('run-b', 20_000)
      expect(repository.getPresence('1')?.connectionPhase).toBe('retired')

      // 应用重启：同 run 重放 beginScope，不得把 retired 洗成 reviving（那会让 120s
      // 窗口内的旧心跳短暂点亮新席位）。cursor_stopped 的跨轮复活语义不受影响。
      setNow(30_000)
      relay.resetScope('run-b', 20_000)
      expect(repository.getPresence('1')?.connectionPhase).toBe('retired')
      expect(relay.applyTo(baseSnapshot()).sessions[0]?.online).toBe(false)
    } finally {
      repository.close()
    }
  })

  it('lets only new life evidence revive a retired seat: MCP heartbeat or CDP runtime activity', () => {
    const { repository, relay, setNow } = fixture(10_000)
    try {
      for (const channelId of ['1', '2']) repository.markChannelEmbedded(channelId, 'workspace-a', '/workspace/a')
      relay.resetScope('run-a', 10_000)
      repository.touchPresence('1', { waiting: true, connectionPhase: 'waiting', lastSeenAt: 19_000 }, 19_000)
      repository.touchPresence('2', { waiting: true, connectionPhase: 'waiting', lastSeenAt: 19_000 }, 19_000)
      setNow(20_000)
      relay.resetScope('run-b', 20_000)

      // 新会话的首次工具调用（纯心跳写入）→ reviving → 协议相位接管。
      repository.touchPresence('1', { lastSeenAt: 21_000 }, 21_000)
      expect(repository.getPresence('1')?.connectionPhase).toBe('reviving')
      setNow(21_001)
      expect(relay.applyTo(baseSnapshot()).sessions.find((session) => session.channelId === '1'))
        .toMatchObject({ online: true, connectionPhase: 'reviving' })

      // CDP 观测到新 Composer 正在生成（runtimeActiveAt 新于旧心跳）同样复活。
      relay.noteRuntimeActivity('2', 22_000)
      expect(repository.getPresence('2')).toMatchObject({ connectionPhase: 'reviving', runtimeActiveAt: 22_000 })
      setNow(22_001)
      expect(relay.applyTo(baseSnapshot()).sessions.find((session) => session.channelId === '2')?.online).toBe(true)
    } finally {
      repository.close()
    }
  })

  it('revives a terminal phase on heartbeat-only presence writes (MCP tool call is life evidence)', () => {
    const { repository, relay, setNow } = fixture(10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'cursor_stopped', lastSeenAt: 10_000
      }, 10_000)
      setNow(10_001)
      expect(relay.applyTo(baseSnapshot()).sessions[0]).toMatchObject({
        online: false, runtimeEvidence: 'stopped'
      })

      // MCP 心跳（refreshIdentity / keepalive 等纯心跳写入，不带 phase）：
      // 工具调用刚发生 = 模型在跑，死亡证据必须让位。
      repository.touchPresence('1', { lastSeenAt: 11_000 }, 11_000)
      expect(repository.getPresence('1')?.connectionPhase).toBe('reviving')
      setNow(11_001)
      expect(relay.applyTo(baseSnapshot()).sessions[0]).toMatchObject({
        online: true, runtimeEvidence: 'active', status: 'reviving'
      })

      // 显式相位写入不受自动复活影响：协议相位机照常工作。
      repository.touchPresence('1', { waiting: true, connectionPhase: 'waiting', lastSeenAt: 12_000 }, 12_000)
      expect(repository.getPresence('1')?.connectionPhase).toBe('waiting')
    } finally {
      repository.close()
    }
  })

  it('markCursorStopped refuses to override fresher heartbeat evidence', () => {
    const { repository, relay, setNow } = fixture(10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      // Agent 刚在 12_000 有 MCP 调用；停止观测却是更早的 11_000（迟到的
      // runtime evidence）——过时死亡证据不得覆盖新生命证据。
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'processing', lastSeenAt: 12_000
      }, 12_000)
      expect(relay.markCursorStopped('1', 11_000)).toBe(false)
      expect(repository.getPresence('1')?.connectionPhase).toBe('processing')

      // 观测时间新于心跳：正常标记。
      expect(relay.markCursorStopped('1', 13_000)).toBe(true)
      expect(repository.getPresence('1')?.connectionPhase).toBe('cursor_stopped')
    } finally {
      repository.close()
    }
  })

  it('renews the processing window with CDP runtime activity through long tasks (P0-1)', () => {
    const { repository, relay, setNow } = fixture(10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      // Agent 取走消息进入长任务：MCP 心跳停在 10_000，此后 9 分钟不触碰任何
      // MCP 工具（跑 shell/构建）。无 CDP 证据时 5 分钟即误判离线。
      repository.touchPresence('1', { waiting: false, connectionPhase: 'processing', lastSeenAt: 10_000 }, 10_000)

      // CDP 探测每轮确认生成中（生产环境 150ms fast loop 直采）：
      // runtimeActiveAt 持续推进，processing 窗口持续续命。
      for (let minute = 1; minute <= 9; minute += 1) {
        const at = 10_000 + minute * 60_000
        relay.noteRuntimeActivity('1', at)
        setNow(at)
        expect(relay.applyTo(baseSnapshot()).sessions[0]?.online).toBe(true)
      }
      expect(repository.getPresence('1')?.runtimeActiveAt).toBe(10_000 + 9 * 60_000)
      // MCP 心跳语义不被污染：lastSeenAt 仍是 Agent 最后一次工具调用时间。
      expect(repository.getPresence('1')?.lastSeenAt).toBe(10_000)

      // 生成停止（CDP 不再推进、Agent 也无 MCP 调用）：宽限耗尽即离线。
      setNow(10_000 + 9 * 60_000 + CHANNEL_PROCESSING_STALE_MS + 1)
      const stale = relay.applyTo(baseSnapshot()).sessions[0]
      expect(stale).toMatchObject({ online: false, runtimeEvidence: 'suspected' })
    } finally {
      repository.close()
    }
  })

  it('keeps a waiting-phase channel online while CDP confirms generation (no MCP calls)', () => {
    const { repository, relay, setNow } = fixture(10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      // 事故另一半根因：Agent 长回合生成中不调用工具，相位停在 waiting，
      // 心跳停刷超 120s 后被对端通道判离线（CH-1/CH-2 互不认识）。
      repository.touchPresence('1', { waiting: true, connectionPhase: 'waiting', lastSeenAt: 10_000 }, 10_000)

      // 生成期间 CDP 每轮确认：严格 120s 窗口同样以 max(lastSeenAt, runtimeActiveAt)
      // 为证据基准，正面生命证据单独维持在线。
      for (let second = 30; second <= 300; second += 30) {
        const at = 10_000 + second * 1_000
        relay.noteRuntimeActivity('1', at)
        setNow(at)
        expect(relay.applyTo(baseSnapshot()).sessions[0]?.online).toBe(true)
      }

      // 生成停止且无 MCP 调用：120s 后恢复严格判定。
      setNow(10_000 + 300_000 + CHANNEL_PRESENCE_STALE_MS + 1)
      expect(relay.applyTo(baseSnapshot()).sessions[0]?.online).toBe(false)
    } finally {
      repository.close()
    }
  })

  it('revives a terminal phase when newer CDP activity overturns the death evidence', () => {
    const { repository, relay, setNow } = fixture(10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'cursor_stopped', lastSeenAt: 10_000
      }, 10_000)
      setNow(10_001)
      expect(relay.applyTo(baseSnapshot()).sessions[0]).toMatchObject({
        online: false, runtimeEvidence: 'stopped'
      })

      // 更晚的 CDP 生成观测推翻停止标记（用户向该 Composer 重新发了消息）。
      relay.noteRuntimeActivity('1', 11_000)
      expect(repository.getPresence('1')?.connectionPhase).toBe('reviving')
      setNow(11_001)
      expect(relay.applyTo(baseSnapshot()).sessions[0]).toMatchObject({
        online: true, runtimeEvidence: 'active'
      })
    } finally {
      repository.close()
    }
  })

  it('markCursorStopped refuses to override fresher CDP runtime activity', () => {
    const { repository, relay, setNow } = fixture(10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      // CDP 在 12_000 确认生成；迟到的停止观测 11_000 不得把健康 Agent 判死。
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'processing', lastSeenAt: 10_000
      }, 10_000)
      relay.noteRuntimeActivity('1', 12_000)
      setNow(12_000)
      expect(relay.markCursorStopped('1', 11_000)).toBe(false)
      expect(repository.getPresence('1')?.connectionPhase).toBe('processing')

      // 观测时间新于全部生命证据：正常标记。
      expect(relay.markCursorStopped('1', 13_000)).toBe(true)
      expect(repository.getPresence('1')?.connectionPhase).toBe('cursor_stopped')
    } finally {
      repository.close()
    }
  })

  it('rehydrates the persisted conversation scope on start after an app restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qingtian-channel-restart-')), 'channel.sqlite3')
    const first = new SqliteChannelMessageRepository(path)
    try {
      first.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      const relayA = new ChannelMessageRelay(first, () => 10_000)
      relayA.resetScope('run-restart', 10_000)
      relayA.sendMessage({ channelId: '1', text: '重启前的用户消息' })
      first.recordReply({ channelId: '1', content: '重启前的助手回复' }, 11_000)
      first.attachReplyProcess({
        replyId: first.listRepliesSince(0)[0]!.id,
        turn: 'cursor:user-before-restart',
        blocks: [{ kind: 'tool', id: 'tool-1', toolName: 'read_file', toolKind: 'read', summary: 'a.ts', status: 'done' }]
      })
      relayA.pollReplies()
      expect(relayA.applyTo(baseSnapshot()).conversations['1']).toHaveLength(2)
    } finally {
      first.close()
    }

    // 模拟应用重启（run 已结束或进行中均适用）：新 relay 实例 + start()
    // 从 channel_scope 持久化域水合，会话页不再空白，过程块随回复恢复。
    const second = new SqliteChannelMessageRepository(path)
    try {
      const relayB = new ChannelMessageRelay(second, () => 20_000)
      relayB.start(250)
      try {
        const snapshot = relayB.applyTo(baseSnapshot())
        expect(snapshot.conversations['1']?.map((entry) => [entry.role, entry.text])).toEqual([
          ['user', '重启前的用户消息'],
          ['assistant', '重启前的助手回复']
        ])
        expect(snapshot.conversations['1']?.[1]?.processBlocks?.[0]?.id).toBe('tool-1')
        expect(relayB['scopeRunId']).toBe('run-restart')
      } finally {
        relayB.stop()
      }
    } finally {
      second.close()
    }
  })

  it('matches persisted assistant text across source pipelines by identity', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      repository.recordReply({ channelId: '1', content: '结论 [REDACTED] 已完成\n第二行' }, 1_000)
      relay.resetScope('run-x', 500)
      // 落库侧保留 [REDACTED] 与真实换行；CDP/转录侧剥脱敏 + 转义换行——身份比对须视为同一条。
      expect(relay.hasPersistedAssistantText('1', '结论 [REDACTED] 已完成\n第二行')).toBe(true)
      expect(relay.hasPersistedAssistantText('1', '结论  已完成\\n第二行')).toBe(true)
      expect(relay.hasPersistedAssistantText('1', '完全不同的回复')).toBe(false)
      expect(relay.hasPersistedAssistantText('1', '')).toBe(true)
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


  it('corrects typeless image attachments to a real image mime before persistence (octet-stream wall guard)', () => {
    const { repository, relay } = fixture()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/a')
      // 拖放/剪贴板来源常见形态：file.type 为空 → 万金油 octet-stream + .png 扩展名。
      // 不纠正的话投递层会把它当二进制文件内联成 Base64 文本墙（模型看到乱码）。
      relay.sendMessage({
        channelId: '1',
        text: '看图',
        attachments: [{ id: 'a1', name: 'clipboard-image-1.png', mimeType: 'application/octet-stream', size: 14, data: Buffer.from('png-bytes-x').toString('base64') }]
      })
      const [queued] = repository.listPendingOutbound('1')
      expect(queued?.attachments?.[0]?.mimeType).toBe('image/png')
      // 路径引用附件同样受益（大文件不落盘路径）。
      relay.sendMessage({
        channelId: '1',
        text: '路径图',
        attachments: [{ id: 'a2', name: 'big.jpg', mimeType: '', size: 3, path: '/tmp/big.jpg' }]
      })
      const pending = repository.listPendingOutbound('1')
      expect(pending[1]?.attachments?.[0]?.mimeType).toBe('image/jpeg')
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
