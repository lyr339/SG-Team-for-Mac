import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  DesktopSessionService,
  enrichDesktopSnapshot,
  type DesktopSessionTransport,
  type DesktopSessionTeamSource
} from '../src/application/desktop-session-service'
import { emptyCursorTelemetrySnapshot, type CursorTelemetrySnapshot } from '../src/domain/cursor-telemetry'
import { emptyTeamControlSnapshot, type TeamControlSnapshot } from '../src/domain/team-control'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import type { CursorComposerTelemetrySource } from '../src/infrastructure/cursor/cursor-composer-telemetry'
import { ChannelMessageRelay } from '../src/application/channel-message-relay'
import { ChannelMessageService } from '../src/application/channel-message-service'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import type { CursorComposerRuntimeEvidence } from '../src/infrastructure/cursor/cursor-cdp-session-creator'

function bridgeSnapshot(): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: 'shiguang://local-channel-runtime', attempt: 0, lastError: '' },
    sessions: [{
      id: 'sg-channel:1',
      channelId: '1',
      generation: 0,
      displayName: '主控协调 · CH-1',
      roleName: '主控席',
      status: 'waiting',
      currentTask: '',
      queueDepth: 0,
      connectionPhase: 'waiting',
      online: true,
      connected: true,
      waiting: true,
      workingFiles: [],
      healthEvidence: ['check_messages 正在待命']
    }],
    conversations: {},
    protocolIssues: [],
    updatedAt: 100
  }
}

function teamSnapshot(composerId?: string): TeamControlSnapshot {
  return {
    ...emptyTeamControlSnapshot(),
    activeWorkspaceId: 'workspace-a',
    workspaces: [{
      id: 'workspace-a',
      name: 'alpha',
      path: '/workspace/alpha',
      createdAt: 1,
      updatedAt: 1
    }],
    bindings: [{
      id: 'binding-1',
      workspaceId: 'workspace-a',
      runId: 'run-a',
      slotId: 'slot-1',
      channelId: '1',
      agentSessionId: 'agent-1',
      generation: 'generation123',
      composerBindingKey: 'generation123',
      installedAt: 1,
      launchStatus: 'delivered',
      launchDetail: '',
      lastCheckInNote: '',
      composerId,
      composerBoundAt: composerId ? 2 : undefined,
      composerBindingMethod: composerId ? 'launch_marker' : undefined
    }]
  }
}

function telemetry(composerId = 'composer-alpha-123'): CursorTelemetrySnapshot {
  return {
    availability: 'available',
    workspacePath: '/workspace/alpha',
    composerProfile: {
      scope: 'cursor-composer-current',
      modelId: 'composer-2.5',
      displayName: 'Composer 2.5',
      options: ['Fast'],
      maxMode: false,
      contextTokenLimit: 200_000
    },
    composers: [{
      composerId,
      title: '主控会话',
      createdAt: 20,
      lastUpdatedAt: 30,
      contextUsage: { ratio: 0.63 },
      changes: { additions: 12, deletions: 4, files: 3 },
    }],
    bindingCandidates: [],
    updatedAt: 30
  }
}

/**
 * 传输层替身。与 LocalSessionBridge 同一契约：带 relay 时快照已合并内嵌通道数据、
 * relay 事件转发给订阅者；服务层不再自行合并 relay。
 */
class FakeBridge implements DesktopSessionTransport {
  private readonly listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  private snapshot = bridgeSnapshot()

  constructor(private readonly relay?: ChannelMessageRelay) {
    relay?.subscribe(() => {
      for (const listener of this.listeners) listener(this.getSnapshot())
    })
  }

  getSnapshot(): DesktopSnapshot {
    const base = structuredClone(this.snapshot)
    return this.relay ? this.relay.applyTo(base) : base
  }
  sendMessage() { return { commandId: 'command-1' } }
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  setOnline(online: boolean): void {
    this.snapshot.sessions = this.snapshot.sessions.map((session) => ({
      ...session,
      online,
      connected: online,
      waiting: online,
      status: online ? 'waiting' : 'offline'
    }))
    for (const listener of this.listeners) listener(this.getSnapshot())
  }

  setConversations(conversations: DesktopSnapshot['conversations']): void {
    this.snapshot = { ...this.snapshot, conversations, updatedAt: this.snapshot.updatedAt + 1 }
    for (const listener of this.listeners) listener(this.getSnapshot())
  }

}

class FakeTeam implements DesktopSessionTeamSource {
  readonly recorded: Parameters<DesktopSessionTeamSource['recordComposerBinding']>[0][] = []
  private readonly listeners = new Set<(snapshot: TeamControlSnapshot) => void>()
  private snapshot: TeamControlSnapshot

  constructor(snapshot = teamSnapshot()) {
    this.snapshot = snapshot
  }

  getSnapshot(): TeamControlSnapshot { return structuredClone(this.snapshot) }
  subscribe(listener: (snapshot: TeamControlSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  setReasoning(value: string): void {
    const member = this.snapshot.members[0]
    if (!member?.slot.modelSelection) return
    member.slot.modelSelection.parameters = member.slot.modelSelection.parameters.map((parameter) => (
      parameter.id === 'reasoning' ? { ...parameter, value } : parameter
    ))
    for (const listener of this.listeners) listener(this.getSnapshot())
  }
  recordComposerBinding(input: Parameters<DesktopSessionTeamSource['recordComposerBinding']>[0]): boolean {
    const binding = this.snapshot.bindings.find((value) => value.slotId === input.slotId)
    if (!binding || binding.generation !== input.generation || binding.composerId) return false
    this.recorded.push(input)
    binding.composerId = input.composerId
    binding.composerBoundAt = input.at ?? 40
    binding.composerBindingMethod = input.method
    return true
  }
  completeRun(at = 200): void {
    const run = this.snapshot.activeRun ?? this.snapshot.runs[0]
    if (!run) return
    run.status = 'completed'
    run.updatedAt = at
    this.snapshot.activeRun = run
    for (const listener of this.listeners) listener(this.getSnapshot())
  }
}

describe('desktop Cursor session enrichment', () => {
  it('publishes Cursor native partial text as a live response without writing conversation history', async () => {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(active),
      { readWorkspace: () => ({ ...telemetry(), composers: [] }) },
      undefined,
      {
        inspectComposerRuntime: async () => ({
          'composer-alpha-123': {
            composerId: 'composer-alpha-123', state: 'active', detail: '正在生成',
            observedAt: Date.now(), isGenerating: true,
            responseId: 'bubble-live-1', responseText: '这是 Cursor 正在生成的原生回答'
          }
        })
      }
    )
    try {
      let pushedLiveText = ''
      const unsubscribe = service.subscribe((snapshot) => {
        pushedLiveText = snapshot.liveAgentResponses?.['1']?.text ?? pushedLiveText
      })
      service.refreshTelemetry()
      await vi.waitFor(() => {
        expect(service.getSnapshot().liveAgentResponses?.['1']).toMatchObject({
          id: 'bubble-live-1', status: 'streaming', text: '这是 Cursor 正在生成的原生回答'
        })
      })
      expect(pushedLiveText).toBe('这是 Cursor 正在生成的原生回答')
      expect(service.getSnapshot().conversations['1']).toBeUndefined()
      unsubscribe()
    } finally {
      service.dispose()
    }
  })

  it('pushes one snapshot per transport event, computed after sealing, and coalesces bursts', async () => {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'sg-emit-coalesce-')), 'channel.sqlite3')
    )
    const relay = new ChannelMessageRelay(repository)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      relay.resetScope('run-a', 1)
      const service = new DesktopSessionService(
        new FakeBridge(relay), new FakeTeam(active), { readWorkspace: () => telemetry() }, relay
      )
      try {
        const pushes: DesktopSnapshot[] = []
        service.subscribe((snapshot) => pushes.push(snapshot))
        expect(pushes).toHaveLength(1)
        // 一个 relay 事件同时经传输层与团队快照两条路径到达服务层：只推一次。
        relay.sendMessage({ channelId: '1', text: '第一条' })
        expect(pushes).toHaveLength(1)
        await Promise.resolve()
        expect(pushes).toHaveLength(2)
        expect(pushes[1]?.conversations['1']?.map((entry) => entry.text)).toEqual(['第一条'])
        // 同一 tick 内的多次触发合并为一份快照，且是最终状态。
        relay.sendMessage({ channelId: '1', text: '第二条' })
        relay.sendMessage({ channelId: '1', text: '第三条' })
        await Promise.resolve()
        expect(pushes).toHaveLength(3)
        expect(pushes[2]?.conversations['1']?.map((entry) => entry.text)).toEqual(['第一条', '第二条', '第三条'])
        // dispose 后不再推送。
        service.dispose()
        relay.sendMessage({ channelId: '1', text: '第四条' })
        await Promise.resolve()
        expect(pushes).toHaveLength(3)
      } finally {
        service.dispose()
      }
    } finally {
      repository.close()
    }
  })

  it('拾光重启回放：CDP 完成态正文与最新落库回复同文即被接管，最终正文不重复出现（会话不断）', async () => {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'sg-restart-replay-')), 'channel.sqlite3')
    )
    const relay = new ChannelMessageRelay(repository)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      // 重启前：用户消息已投递，Agent 已 record_reply（visible，精确 outboundId）。
      const outbound = repository.enqueueOutbound('1', '你是什么模型', 1_000)
      repository.markOutboundDelivered([outbound.id], 1_500)
      repository.recordReply({ channelId: '1', content: '我是 Claude Fable 5.1。', visible: true, outboundId: outbound.id }, 5_000)
      relay.resetScope('run-a', 1)

      let evidence: CursorComposerRuntimeEvidence = {
        composerId: 'composer-alpha-123', state: 'unknown', detail: '',
        // 重启后的首次 CDP 观测：时间远晚于落库回复，正文就是那条已归档的最终回答。
        observedAt: Date.now(), isGenerating: false,
        responseId: 'bubble-final-1', responseText: '我是 Claude Fable 5.1。'
      }
      let inspections = 0
      const service = new DesktopSessionService(
        new FakeBridge(relay),
        new FakeTeam(active),
        { readWorkspace: () => telemetry() },
        relay,
        { inspectComposerRuntime: async () => { inspections += 1; return { 'composer-alpha-123': evidence } } }
      )
      try {
        service.refreshTelemetry()
        await vi.waitFor(() => expect(inspections).toBeGreaterThanOrEqual(1))
        const snapshot = service.getSnapshot()
        expect(snapshot.conversations['1']?.filter((entry) => entry.role === 'assistant').map((entry) => entry.text))
          .toEqual(['我是 Claude Fable 5.1。'])
        expect(snapshot.liveAgentResponses?.['1']).toBeUndefined()

        // 对照：新一轮正在生成的同文正文不属于回放，仍作为直播展示。
        evidence = { ...evidence, observedAt: Date.now(), isGenerating: true, responseId: 'bubble-next-2' }
        service.notifyComposerWriteSignal('composer-alpha-123')
        await vi.waitFor(() => {
          expect(service.getSnapshot().liveAgentResponses?.['1']).toMatchObject({ id: 'bubble-next-2', status: 'streaming' })
        })
      } finally {
        service.dispose()
      }
    } finally {
      repository.close()
    }
  })

  it('suppresses transcript fallback when the reply is already persisted by record_reply', async () => {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'sg-transcript-gate-')), 'channel.sqlite3')
    )
    const relay = new ChannelMessageRelay(repository)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      repository.recordReply({ channelId: '1', content: '已完成重构，共三处修改。' }, 5_000)
      relay.resetScope('run-a', 1)
      const telemetryWithResponse = {
        ...telemetry(),
        composers: [{
          ...telemetry().composers[0]!,
          // 转录兜底带新 mtime（Agent 的 check_messages 轮询刚写过转录）：
          // 文本与已落库回复相同 → 不得注入（否则「正在归档…」永挂）。
          lastAssistantResponse: { id: 'transcript:composer-alpha-123:9000', text: '已完成重构，共三处修改。', observedAt: 9_000 }
        }]
      }
      const service = new DesktopSessionService(
        new FakeBridge(relay),
        new FakeTeam(active),
        { readWorkspace: () => telemetryWithResponse },
        relay,
        { inspectComposerRuntime: async () => ({}) }
      )
      try {
        service.refreshTelemetry()
        await vi.waitFor(() => {
          expect((service as unknown as { runtimeInspectedComposerIds: Set<string> })
            .runtimeInspectedComposerIds.has('composer-alpha-123')).toBe(true)
        })
        service.refreshTelemetry()
        expect(service.getSnapshot().liveAgentResponses?.['1']).toBeUndefined()
      } finally {
        service.dispose()
      }
    } finally {
      repository.close()
    }
  })

  it('keeps a delivered message replyable across run completion (delivered → run 状态变化 → record_reply)', async () => {
    // 2026-09-01 事故链：Agent 取走消息后 run 被误收尾，completeScope 清掉
    // reply-sync 守门，随后到达的 record_reply 以 visible=0 落库（用户视角：
    // 已投递消息永远没有回应）。run 状态切换不得清除已投递未回复的关联。
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'sg-run-completion-')), 'channel.sqlite3')
    )
    const relay = new ChannelMessageRelay(repository)
    const channelService = new ChannelMessageService(repository)
    let service: DesktopSessionService | undefined
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      relay.resetScope('run-a', 1)

      const outbound = repository.enqueueOutbound('1', '你是谁', 2_000)
      const delivered = await channelService.checkMessages({ channelId: '1', keepaliveTimeoutMs: 10, pollIntervalMs: 5 })
      expect(delivered).toMatchObject({ type: 'delivered' })
      expect(repository.getPresence('1')?.pendingOutboundId).toBe(outbound.id)

      const team = new FakeTeam(active)
      service = new DesktopSessionService(
        new FakeBridge(relay),
        team,
        { readWorkspace: () => telemetry() },
        relay,
        { inspectComposerRuntime: async () => ({}) }
      )

      // run 状态切换（running → completed）触发 completeScope
      team.completeRun()

      const reply = channelService.recordReply({ channelId: '1', content: '我是拾光团队的构建工程师。' })
      expect(reply.visible).toBeUndefined()
      expect(reply.outboundId).toBe(outbound.id)
    } finally {
      service?.dispose()
      repository.close()
    }
  })

  it('finalizes transcript fallback by text identity even when the persisted reply is much older', () => {
    const bridge = new FakeBridge()
    bridge.setConversations({
      '1': [{ id: 'reply:old', channelId: '1', role: 'assistant', text: '最终结论', timestamp: 1_000_000, status: 'complete', source: 'cursor' }]
    })
    const service = new DesktopSessionService(
      bridge,
      new FakeTeam(teamSnapshot('composer-alpha-123')),
      { readWorkspace: () => telemetry() }
    )
    const update = (service as unknown as {
      updateLiveAgentResponse(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
    }).updateLiveAgentResponse.bind(service)
    try {
      update('1', {
        composerId: 'composer-alpha-123', state: 'unknown', detail: 'transcript', observedAt: 2_000,
        isGenerating: false, responseId: 'transcript:composer-alpha-123:2000', responseText: '最终结论'
      })
      // 转录 startedAt（mtime）远新于落库回复时间：旧时间窗判定永不命中；
      // 文本身份命中即视为已归档，恢复态不得永挂。
      expect(service.getSnapshot().liveAgentResponses?.['1']).toBeUndefined()
    } finally {
      service.dispose()
    }
  })

  it('keeps a completed native reply visible when record_reply failed and the Cursor Agent went offline', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(teamSnapshot('composer-alpha-123')),
      { readWorkspace: () => telemetry() }
    )
    const update = (service as unknown as {
      updateLiveAgentResponse(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
    }).updateLiveAgentResponse.bind(service)
    try {
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'generating', observedAt: 1_000_000,
        isGenerating: true, responseId: 'reply-unpersisted', responseText: '这条回复尚未通过 record_reply 落库'
      })
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'done', observedAt: 1_001_000,
        isGenerating: false, responseId: 'reply-unpersisted', responseText: '这条回复尚未通过 record_reply 落库'
      })
      vi.setSystemTime(1_020_000)
      expect(service.getSnapshot().liveAgentResponses?.['1']).toMatchObject({
        id: 'reply-unpersisted', status: 'complete', text: '这条回复尚未通过 record_reply 落库'
      })
      update('1', {
        composerId: 'composer-alpha-123', state: 'stopped', detail: 'Cursor offline', observedAt: 1_021_000,
        isGenerating: false, responseId: 'reply-unpersisted', responseText: '这条回复尚未通过 record_reply 落库'
      })
      expect(service.getSnapshot().liveAgentResponses?.['1']?.text).toContain('尚未通过 record_reply')
    } finally {
      service.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps CDP completed text authoritative over repeating transcript fallback to prevent flicker', () => {
    const service = new DesktopSessionService(
      new FakeBridge(), new FakeTeam(teamSnapshot('composer-alpha-123')), { readWorkspace: () => telemetry() }
    )
    const update = (service as unknown as {
      updateLiveAgentResponse(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
    }).updateLiveAgentResponse.bind(service)
    try {
      update('1', {
        composerId: 'composer-alpha-123', state: 'unknown', detail: 'transcript', observedAt: 1,
        isGenerating: false, responseId: 'transcript:composer-alpha-123:1', responseText: '转录兜底全文'
      })
      update('1', {
        composerId: 'composer-alpha-123', state: 'unknown', detail: 'cdp', observedAt: 2,
        isGenerating: false, responseId: 'cursor-bubble-1', responseText: 'Cursor 可见正文\n\n保持原排版'
      })
      const ignored = update('1', {
        composerId: 'composer-alpha-123', state: 'unknown', detail: 'transcript', observedAt: 3,
        isGenerating: false, responseId: 'transcript:composer-alpha-123:1', responseText: '转录兜底全文'
      })
      expect(ignored).toBe(false)
      expect(service.getSnapshot().liveAgentResponses?.['1']).toMatchObject({
        id: 'cursor-bubble-1', text: 'Cursor 可见正文\n\n保持原排版', status: 'complete'
      })
    } finally {
      service.dispose()
    }
  })

  it('hydrates a completed process from Cursor transcript only after the first runtime inspection', async () => {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const telemetryWithProcess = {
      ...telemetry(),
      composers: [{
        ...telemetry().composers[0]!,
        lastAssistantResponse: { id: 'reply-transcript', text: '最终回复', observedAt: 2_000 },
        lastAssistantProcess: {
          observedAt: 2_000,
          blocks: [
            { kind: 'thinking' as const, id: 'transcript-thought', text: '冷启动恢复过程', status: 'done' as const },
            { kind: 'tool' as const, id: 'transcript-tool', toolName: 'record_reply', toolKind: 'mcp' as const, status: 'done' as const }
          ]
        }
      }]
    }
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(active),
      { readWorkspace: () => telemetryWithProcess },
      undefined,
      { inspectComposerRuntime: async () => ({}) }
    )
    try {
      service.refreshTelemetry()
      expect(service.getSnapshot().liveProcess?.['1']).toBeUndefined()
      await vi.waitFor(() => {
        service.refreshTelemetry()
        expect(service.getSnapshot().liveProcess?.['1']?.blocks.map((block) => block.id)).toEqual([
          'transcript-thought', 'transcript-tool'
        ])
      })
      expect(service.getSnapshot().liveAgentResponses?.['1']?.text).toBe('最终回复')
    } finally {
      service.dispose()
    }
  })

  it('never lets transcript fallback replace an existing native persisted process', async () => {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'shiguang-transcript-quality-')), 'channel.sqlite3')
    )
    repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
    repository.beginScope('run-a', 1)
    const message = repository.enqueueOutbound('1', '问题', 1_000, undefined, false, 'run-a')
    repository.markOutboundDelivered([message.id], 1_100)
    const reply = repository.recordReply({ channelId: '1', content: '回答', outboundId: message.id }, 1_500)
    repository.attachReplyProcess({
      replyId: reply.id, turn: `cursor:native:virtual:outbox:${message.id}`,
      blocks: [{ kind: 'tool', id: 'native-rich', toolName: 'read_file', toolKind: 'read', status: 'done', output: '完整原生输出' }]
    })
    const relay = new ChannelMessageRelay(repository)
    relay.resetScope('run-a', 1)
    const transcriptTelemetry = {
      ...telemetry(),
      composers: [{
        ...telemetry().composers[0]!,
        lastAssistantProcess: {
          observedAt: 2_000,
          blocks: [{ kind: 'tool' as const, id: 'transcript-poor', toolName: 'check_messages', toolKind: 'mcp' as const, status: 'done' as const }]
        }
      }]
    }
    const service = new DesktopSessionService(
      new FakeBridge(relay), new FakeTeam(active), { readWorkspace: () => transcriptTelemetry }, relay,
      { inspectComposerRuntime: async () => ({}) }
    )
    try {
      ;(service as unknown as {
        liveCursorProcess: Map<string, unknown>
      }).liveCursorProcess.set('1', {
        source: 'transcript',
        view: {
          turn: 'transcript:poor',
          blocks: transcriptTelemetry.composers[0]!.lastAssistantProcess!.blocks,
          startedAt: 2_000,
          updatedAt: 2_000
        },
        fingerprint: 'transcript-poor', generating: false, updatedAt: 2_000,
        blockFirstSeen: new Map()
      })
      expect(service.getSnapshot().liveProcess?.['1']).toBeUndefined()
      service.refreshTelemetry()
      await vi.waitFor(() => expect((service as unknown as {
        runtimeInspectedComposerIds: Set<string>
      }).runtimeInspectedComposerIds.has('composer-alpha-123')).toBe(true))
      service.refreshTelemetry()
      expect(repository.listRepliesSince(0)[0]?.processBlocks).toMatchObject([{ id: 'native-rich', output: '完整原生输出' }])
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('retains a completed native process across newer user messages until persistence takes ownership', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const bridge = new FakeBridge()
    const service = new DesktopSessionService(
      bridge,
      new FakeTeam(teamSnapshot('composer-alpha-123')),
      { readWorkspace: () => telemetry() }
    )
    const update = (service as unknown as {
      updateLiveCursorProcess(
        channelId: string,
        evidence: CursorComposerRuntimeEvidence,
        options?: { authoritative?: boolean }
      ): boolean
    }).updateLiveCursorProcess.bind(service)
    try {
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'generating', observedAt: 1_000_000,
        isGenerating: true,
        process: {
          turnId: 'user-retained',
          items: [{ kind: 'thinking', id: 'thought-retained', text: '不能一闪而过', status: 'running' }],
          generatingBubbleCount: 1
        }
      })
      // inspect（非权威）在 observer 帧之后 150ms 声称未生成：不得结束回合（否则
      // running/done 在两个来源之间往复闪烁）。
      expect(update('1', {
        composerId: 'composer-alpha-123', state: 'unknown', detail: 'inspect idle', observedAt: 1_000_150,
        isGenerating: false
      })).toBe(false)
      expect(service.getSnapshot().liveProcess?.['1']?.blocks[0]).toMatchObject({ status: 'running' })
      // observer 离线（初始 reconnecting）且视图 2s 无任何帧/心跳：inspect 兜底收尾。
      update('1', {
        composerId: 'composer-alpha-123', state: 'unknown', detail: 'done', observedAt: 1_003_000,
        isGenerating: false
      })

      vi.setSystemTime(1_061_000)
      expect(service.getSnapshot().liveProcess?.['1']?.blocks[0]).toMatchObject({
        id: 'thought-retained', status: 'done'
      })

      // 下一条用户消息到来：直播视图保留（虚拟回合分段会把旧块锚在旧消息上），
      // 不再整体撤下——旧版在此删除，下一帧又整批送回，形成「消失几秒后重现」。
      bridge.setConversations({
        '1': [{
          id: 'user-next', channelId: '1', role: 'user', text: '下一轮', timestamp: 1_062_000,
          status: 'complete', source: 'desktop'
        }]
      })
      expect(service.getSnapshot().liveProcess?.['1']?.blocks[0]).toMatchObject({ id: 'thought-retained' })
    } finally {
      service.dispose()
      vi.useRealTimers()
    }
  })

  it('stamps completedAt once: later frames never re-date already settled blocks (过程卡时长抖动)', () => {
    const service = new DesktopSessionService(
      new FakeBridge(), new FakeTeam(teamSnapshot('composer-alpha-123')), { readWorkspace: () => telemetry() }
    )
    const update = (service as unknown as {
      updateLiveCursorProcess(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
    }).updateLiveCursorProcess.bind(service)
    try {
      const frame = (observedAt: number, thinkingStatus: 'running' | 'done', extra: boolean): void => {
        update('1', {
          composerId: 'composer-alpha-123', state: 'active', detail: 'observer', observedAt,
          isGenerating: true,
          process: {
            turnId: 'turn-1',
            items: [
              { kind: 'thinking', id: 'th-1', text: '思考', status: thinkingStatus, startedAt: 1_000 },
              { kind: 'tool', id: 'read-1', toolName: 'read_file', toolKind: 'read', summary: 'a.ts', status: 'done', startedAt: 1_100 },
              ...(extra ? [{ kind: 'tool' as const, id: 'read-2', toolName: 'read_file', toolKind: 'read' as const, summary: 'b.ts', status: 'running' as const, startedAt: 2_900 }] : [])
            ],
            generatingBubbleCount: 1,
            snapshotComplete: true
          }
        })
      }
      frame(2_000, 'running', false)
      frame(2_500, 'done', false)
      const settled = service.getSnapshot().liveProcess?.['1']?.blocks ?? []
      expect(settled[0]).toMatchObject({ id: 'th-1', status: 'done', completedAt: 2_500 })
      expect(settled[1]).toMatchObject({ id: 'read-1', status: 'done', completedAt: 2_000 })
      // 回合继续推进（新块到达）：已收尾块的 completedAt 不随采样时刻漂移。
      frame(3_000, 'done', true)
      const later = service.getSnapshot().liveProcess?.['1']?.blocks ?? []
      expect(later[0]).toMatchObject({ id: 'th-1', completedAt: 2_500 })
      expect(later[1]).toMatchObject({ id: 'read-1', completedAt: 2_000 })
      expect(later[2]).toMatchObject({ id: 'read-2', status: 'running' })
    } finally {
      service.dispose()
    }
  })

  it('holds the live tail Thinking as running while Cursor flips its done flag between chunks (Thought 头部闪烁)', () => {
    const service = new DesktopSessionService(
      new FakeBridge(), new FakeTeam(teamSnapshot('composer-alpha-123')), { readWorkspace: () => telemetry() }
    )
    const update = (service as unknown as {
      updateLiveCursorProcess(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
    }).updateLiveCursorProcess.bind(service)
    const blocks = () => service.getSnapshot().liveProcess?.['1']?.blocks ?? []
    const frame = (input: {
      at: number
      text: string
      status: 'running' | 'done'
      durationMs?: number
      generating?: boolean
      after?: boolean
    }): void => {
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'observer', observedAt: input.at,
        isGenerating: input.generating ?? true,
        process: {
          turnId: 'turn-flicker',
          items: [
            { kind: 'thinking', id: 'th-live', text: input.text, status: input.status, startedAt: 1_000, durationMs: input.durationMs },
            ...(input.after ? [{ kind: 'tool' as const, id: 'read-after', toolName: 'read_file', toolKind: 'read' as const, summary: 'a.ts', status: 'running' as const, startedAt: input.at }] : [])
          ],
          generatingBubbleCount: input.generating === false ? 0 : 1,
          snapshotComplete: true
        }
      })
    }
    try {
      // 逐块到达：running → done（同文本）→ running（新内容）→ done …
      frame({ at: 2_000, text: '先看', status: 'running' })
      frame({ at: 2_300, text: '先看', status: 'done' })
      expect(blocks()[0]).toMatchObject({ id: 'th-live', status: 'running', completedAt: undefined })
      frame({ at: 2_600, text: '先看一下', status: 'running' })
      frame({ at: 2_900, text: '先看一下测试', status: 'done' })
      expect(blocks()[0]).toMatchObject({ id: 'th-live', status: 'running', text: '先看一下测试', completedAt: undefined })

      // 原生 thinkingDurationMs 到达 = Cursor 明确宣告思考结束：按 done 收尾，时长用原生值。
      frame({ at: 3_200, text: '先看一下测试', status: 'done', durationMs: 2_200 })
      expect(blocks()[0]).toMatchObject({ id: 'th-live', status: 'done', completedAt: 3_200, durationMs: 2_200, timingEstimated: false })
      // 再来的采样帧不改写已收尾块的 completedAt。
      frame({ at: 3_800, text: '先看一下测试', status: 'done', durationMs: 2_200 })
      expect(blocks()[0]).toMatchObject({ id: 'th-live', status: 'done', completedAt: 3_200 })
    } finally {
      service.dispose()
    }
  })

  it('settles a held Thinking when later work appears or the turn stops generating', () => {
    const build = () => {
      const service = new DesktopSessionService(
        new FakeBridge(), new FakeTeam(teamSnapshot('composer-alpha-123')), { readWorkspace: () => telemetry() }
      )
      const update = (service as unknown as {
        updateLiveCursorProcess(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
      }).updateLiveCursorProcess.bind(service)
      const frame = (at: number, status: 'running' | 'done', options: { generating?: boolean; after?: boolean } = {}): void => {
        update('1', {
          composerId: 'composer-alpha-123', state: 'active', detail: 'observer', observedAt: at,
          isGenerating: options.generating ?? true,
          process: {
            turnId: 'turn-settle',
            items: [
              { kind: 'thinking', id: 'th-live', text: '思考中', status, startedAt: 1_000 },
              ...(options.after ? [{ kind: 'tool' as const, id: 'read-after', toolName: 'read_file', toolKind: 'read' as const, summary: 'a.ts', status: 'running' as const, startedAt: at }] : [])
            ],
            generatingBubbleCount: options.generating === false ? 0 : 1,
            snapshotComplete: true
          }
        })
      }
      return { service, frame, blocks: () => service.getSnapshot().liveProcess?.['1']?.blocks ?? [] }
    }

    // 其后出现新块：Thinking 不再是尾部，done 生效且只盖一次章。
    const withLater = build()
    try {
      withLater.frame(2_000, 'running')
      withLater.frame(2_300, 'done')
      expect(withLater.blocks()[0]).toMatchObject({ status: 'running' })
      withLater.frame(2_600, 'done', { after: true })
      expect(withLater.blocks()[0]).toMatchObject({ id: 'th-live', status: 'done', completedAt: 2_600 })
      expect(withLater.blocks()[1]).toMatchObject({ id: 'read-after', status: 'running' })
      withLater.frame(2_900, 'done', { after: true })
      expect(withLater.blocks()[0]).toMatchObject({ completedAt: 2_600 })
    } finally {
      withLater.service.dispose()
    }

    // 回合停止生成：尾部 Thinking 收尾。
    const stopped = build()
    try {
      stopped.frame(2_000, 'running')
      stopped.frame(2_300, 'done')
      expect(stopped.blocks()[0]).toMatchObject({ status: 'running' })
      stopped.frame(2_600, 'done', { generating: false })
      expect(stopped.blocks()[0]).toMatchObject({ id: 'th-live', status: 'done', completedAt: 2_600 })
    } finally {
      stopped.service.dispose()
    }
  })

  it('does not finalize a native process when an active runtime inspect omits process payload', () => {
    vi.useFakeTimers()
    const base = Date.now()
    vi.setSystemTime(base)
    const service = new DesktopSessionService(
      new FakeBridge(), new FakeTeam(teamSnapshot('composer-alpha-123')), { readWorkspace: () => telemetry() }
    )
    const update = (service as unknown as {
      updateLiveCursorProcess(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
    }).updateLiveCursorProcess.bind(service)
    try {
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'observer', observedAt: base,
        isGenerating: true,
        process: {
          turnId: 'one-native-turn',
          items: [{ kind: 'thinking', id: 'work', text: '仍在执行', status: 'running', startedAt: base - 100 }],
          generatingBubbleCount: 1
        }
      })
      expect(update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'inspect', observedAt: base + 100,
        isGenerating: true
      })).toBe(false)
      vi.setSystemTime(base + 9_100)
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'inspect still active', observedAt: base + 9_100,
        isGenerating: true
      })
      expect(service.getSnapshot().liveProcess?.['1']?.blocks[0]).toMatchObject({ id: 'work', status: 'running' })
    } finally {
      service.dispose()
      vi.useRealTimers()
    }
  })

  it('persists two virtual replies from one never-ending native Cursor turn by outbound identity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'shiguang-virtual-turn-')), 'channel.sqlite3')
    )
    repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
    repository.beginScope('run-a', 1)
    const firstMessage = repository.enqueueOutbound('1', '第一问', 1_000, undefined, false, 'run-a')
    repository.markOutboundDelivered([firstMessage.id], 1_100)
    repository.recordReply({ channelId: '1', content: '第一答', outboundId: firstMessage.id }, 1_500)
    const secondMessage = repository.enqueueOutbound('1', '第二问', 2_000, undefined, false, 'run-a')
    repository.markOutboundDelivered([secondMessage.id], 2_100)
    repository.recordReply({ channelId: '1', content: '第二答', outboundId: secondMessage.id }, 2_500)
    const thirdMessage = repository.enqueueOutbound('1', '长过程', 3_000, undefined, false, 'run-a')
    repository.markOutboundDelivered([thirdMessage.id], 3_100)
    repository.recordReply({ channelId: '1', content: '长过程完成', outboundId: thirdMessage.id }, 3_900)
    const bulk = Array.from({ length: 600 }, (_, index) => ({
      kind: 'thinking' as const, id: `bulk-${index}`, text: `步骤 ${index}`, status: 'done' as const,
      startedAt: 3_200 + index
    }))
    const relay = new ChannelMessageRelay(repository)
    relay.resetScope('run-a', 1)
    const attachProcess = vi.spyOn(relay, 'attachProcessToReply')
    const service = new DesktopSessionService(
      new FakeBridge(relay), new FakeTeam(active), { readWorkspace: () => telemetry() }, relay
    )
    const update = (service as unknown as {
      updateLiveCursorProcess(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
    }).updateLiveCursorProcess.bind(service)
    try {
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'observer', observedAt: 4_000,
        isGenerating: true,
        process: {
          turnId: 'same-native-turn-for-entire-session',
          items: [
            { kind: 'thinking', id: 'work-1', text: '处理第一问', status: 'done', startedAt: 1_200 },
            { kind: 'thinking', id: 'work-2', text: '处理第二问', status: 'done', startedAt: 2_200 },
            ...bulk
          ],
          generatingBubbleCount: 1
        }
      })
      const replies = service.getSnapshot().conversations['1']!.filter((entry) => entry.role === 'assistant')
      expect(replies.slice(0, 2).map((entry) => ({ replyTo: entry.replyToEntryId, blocks: entry.processBlocks?.map((block) => block.id) }))).toEqual([
        { replyTo: `outbox:${firstMessage.id}`, blocks: ['work-1'] },
        { replyTo: `outbox:${secondMessage.id}`, blocks: ['work-2'] }
      ])
      expect(replies[2]?.replyToEntryId).toBe(`outbox:${thirdMessage.id}`)
      expect(replies[2]?.processBlocks).toHaveLength(600)
      const persisted = repository.listRepliesSince(0)
      expect(persisted[0]?.processBlocks?.map((block) => block.id)).toEqual(['work-1'])
      expect(persisted[1]?.processBlocks?.map((block) => block.id)).toEqual(['work-2'])
      expect(persisted[2]?.processBlocks).toHaveLength(600)
      const internals = service as unknown as {
        liveCursorProcess: Map<string, { view: { blocks: unknown[] } }>
        committedProcessBlockIds: Map<string, Set<string>>
      }
      expect(internals.liveCursorProcess.get('1')?.view.blocks).toHaveLength(0)
      expect(internals.committedProcessBlockIds.get('1')?.size).toBe(602)
      const persistedWrites = attachProcess.mock.calls.length
      service.getSnapshot()
      expect(attachProcess).toHaveBeenCalledTimes(persistedWrites)
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'observer window', observedAt: 4_100,
        isGenerating: true,
        process: {
          turnId: 'same-native-turn-for-entire-session',
          items: bulk.slice(-256),
          generatingBubbleCount: 1
        }
      })
      expect(internals.liveCursorProcess.get('1')?.view.blocks).toHaveLength(0)
      expect(internals.committedProcessBlockIds.get('1')?.size).toBe(256)
      update('1', {
        composerId: 'composer-alpha-123', state: 'unknown', detail: 'ended', observedAt: 2_700,
        isGenerating: false
      })
      expect(service.getSnapshot().conversations['1']!
        .filter((entry) => entry.role === 'assistant')
        .map((entry) => entry.processBlocks?.length)).toEqual([1, 1, 600])
    } finally {
      service.dispose()
      repository.close()
      vi.useRealTimers()
    }
  })

  it('keeps an embedded native archive until its delayed reply can consume it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'shiguang-archive-retry-')), 'channel.sqlite3')
    )
    repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
    repository.beginScope('run-a', 1)
    const message = repository.enqueueOutbound('1', '延迟回复', 1_000, undefined, false, 'run-a')
    repository.markOutboundDelivered([message.id], 1_100)
    const relay = new ChannelMessageRelay(repository)
    relay.resetScope('run-a', 1)
    const service = new DesktopSessionService(
      new FakeBridge(relay), new FakeTeam(active), { readWorkspace: () => telemetry() }, relay
    )
    const internals = service as unknown as {
      updateLiveCursorProcess(
        channelId: string,
        evidence: CursorComposerRuntimeEvidence,
        options?: { authoritative?: boolean }
      ): boolean
      liveCursorProcess: Map<string, unknown>
      nativeProcessArchive: Map<string, unknown[]>
    }
    try {
      internals.updateLiveCursorProcess('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'working', observedAt: 1_300,
        isGenerating: true,
        process: {
          turnId: 'native-delayed',
          items: [{ kind: 'thinking', id: 'delayed-work', text: '等待落库', status: 'running', startedAt: 1_200 }],
          generatingBubbleCount: 1
        }
      })
      // observer（权威来源）的终结帧：立即收尾归档。
      internals.updateLiveCursorProcess('1', {
        composerId: 'composer-alpha-123', state: 'unknown', detail: 'ended', observedAt: 1_400,
        isGenerating: false
      }, { authoritative: true })
      internals.liveCursorProcess.delete('1')
      service.getSnapshot()
      expect(internals.nativeProcessArchive.get('1')).toHaveLength(1)

      repository.recordReply({ channelId: '1', content: '迟到的完整回复', outboundId: 'legacy-wrong-id' }, 1_500)
      relay.pollReplies()
      const reply = service.getSnapshot().conversations['1']?.find((entry) => entry.role === 'assistant')
      expect(reply?.processBlocks?.map((block) => block.id)).toEqual(['delayed-work'])
      expect(repository.listRepliesSince(0)[0]?.outboundId).toBe(message.id)
      expect(internals.nativeProcessArchive.has('1')).toBe(false)
    } finally {
      service.dispose()
      repository.close()
      vi.useRealTimers()
    }
  })

  it('projects direct Cursor-native process events in their original order without an inspect fallback', async () => {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(active),
      { readWorkspace: () => ({ ...telemetry(), composers: [] }) },
      undefined,
      { inspectComposerRuntime: async () => ({}) }
    )
    try {
      // observer 可能先于 runtime binding 水合：首帧先到也必须暂存并在刷新后回放。
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: Date.now(), isGenerating: true,
        process: {
          items: [
            { kind: 'thinking', id: 'th-native', text: '先分析再执行', status: 'done', durationMs: 2_400 },
            { kind: 'message', id: 'msg-native', text: '准备读取目标文件。', status: 'done' },
            { kind: 'tool', id: 'read-native', toolName: 'read_file_v2', toolKind: 'read', summary: '/p/a.ts', status: 'done', output: 'const a = 1' },
            { kind: 'thinking', id: 'th-native-2', text: '检查读取结果', status: 'running' },
            { kind: 'tool', id: 'browser-native', toolName: 'browser_navigate', toolKind: 'browser', summary: 'http://localhost', status: 'running' }
          ],
          todos: [{ content: '完成验证', status: 'in_progress' }],
          generatingBubbleCount: 1
        }
      })
      expect(service.getSnapshot().liveProcess?.['1']).toBeUndefined()
      service.refreshTelemetry()
      const blocks = service.getSnapshot().liveProcess?.['1']?.blocks ?? []
      expect(blocks.map((block) => block.id)).toEqual([
        'th-native', 'msg-native', 'read-native', 'th-native-2', 'browser-native', expect.stringMatching(/^cursor:todos:/)
      ])
      expect(blocks[0]).toMatchObject({ kind: 'thinking', durationMs: 2_400 })
      expect(blocks[1]).toMatchObject({ kind: 'message', text: '准备读取目标文件。' })
      expect(blocks[2]).toMatchObject({ kind: 'tool', output: 'const a = 1' })
      expect(blocks[4]).toMatchObject({ kind: 'tool', toolKind: 'browser', status: 'running' })
      expect(blocks[5]).toMatchObject({ kind: 'tool', toolKind: 'todo', todos: [{ content: '完成验证', status: 'in_progress' }] })
      const firstTodoId = blocks[5]!.id
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: Date.now() + 3, isGenerating: true,
        process: {
          items: [], todos: [{ content: '完成验证', status: 'completed' }], generatingBubbleCount: 1
        }
      })
      const revisedTodos = service.getSnapshot().liveProcess?.['1']?.blocks
        .filter((block) => block.id.startsWith('cursor:todos:')) ?? []
      expect(revisedTodos).toHaveLength(1)
      expect(revisedTodos[0]).toMatchObject({ todos: [{ content: '完成验证', status: 'completed' }] })
      expect(revisedTodos[0]?.id).not.toBe(firstTodoId)
      // 页面 binding 只推最近窗口；主进程必须按稳定 id 增量合并，长任务早期步骤不丢。
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: Date.now() + 5, isGenerating: true,
        process: {
          items: [{ kind: 'tool', id: 'write-native', toolName: 'write_file', toolKind: 'write', summary: '/p/b.ts', status: 'running' }],
          todos: [{ content: '完成验证', status: 'completed' }],
          generatingBubbleCount: 1
        }
      })
      expect(service.getSnapshot().liveProcess?.['1']?.blocks.map((block) => block.id)).toEqual([
        'th-native', 'msg-native', 'read-native', 'th-native-2', 'browser-native', 'write-native', expect.stringMatching(/^cursor:todos:/)
      ])
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: Date.now() + 10, isGenerating: false
      })
      expect(service.getSnapshot().liveProcess?.['1']?.blocks.every((block) => block.status === 'done')).toBe(true)
    } finally {
      service.dispose()
    }
  })


  it('streams the final answer from write-after snapshots and drops stale shorter inspect frames (阶段 G 数据层)', () => {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(active),
      { readWorkspace: () => ({ ...telemetry(), composers: [] }) },
      undefined,
      { inspectComposerRuntime: async () => ({}) }
    )
    const updateLiveAgentResponse = (service as unknown as {
      updateLiveAgentResponse(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
    }).updateLiveAgentResponse.bind(service)
    try {
      service.refreshTelemetry()
      // 流式态有 2.5s 断帧时效：观测时间必须贴近当前时钟。
      const base = Date.now()
      const frame = (offsetMs: number, isGenerating: boolean, text: string): void => {
        service.notifyNativeProcessSnapshot({
          composerId: 'composer-alpha-123', observedAt: base + offsetMs, isGenerating,
          process: { items: [], generatingBubbleCount: isGenerating ? 1 : 0, snapshotComplete: true },
          response: { id: 'bubble-final', text }
        })
      }
      frame(0, true, '第一段')
      expect(service.getSnapshot().liveAgentResponses?.['1']).toMatchObject({
        id: 'bubble-final', text: '第一段', status: 'streaming'
      })
      frame(30, true, '第一段第二段')
      expect(service.getSnapshot().liveAgentResponses?.['1']?.text).toBe('第一段第二段')

      // inspect 往返慢于写后直推：迟到的严格前缀短帧不得让正文回退（播放器会整体重对齐）。
      expect(updateLiveAgentResponse('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: '', observedAt: base + 40,
        isGenerating: true, responseId: 'bubble-final', responseText: '第一段'
      })).toBe(false)
      expect(service.getSnapshot().liveAgentResponses?.['1']?.text).toBe('第一段第二段')
      // 非前缀改写是真实替换，照常接受。
      expect(updateLiveAgentResponse('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: '', observedAt: base + 50,
        isGenerating: true, responseId: 'bubble-final', responseText: '重写'
      })).toBe(true)
      expect(service.getSnapshot().liveAgentResponses?.['1']?.text).toBe('重写')

      frame(100, false, '重写完毕')
      expect(service.getSnapshot().liveAgentResponses?.['1']).toMatchObject({
        id: 'bubble-final', text: '重写完毕', status: 'complete'
      })
    } finally {
      service.dispose()
    }
  })

  it('write signal triggers immediate runtime inspection for native response state', async () => {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    let inspectCalls = 0
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(active),
      { readWorkspace: () => ({ ...telemetry(), composers: [] }) },
      undefined,
      {
        inspectComposerRuntime: async () => {
          inspectCalls += 1
          return {
            'composer-alpha-123': {
              composerId: 'composer-alpha-123', state: 'active', detail: '正在生成',
              observedAt: Date.now(), isGenerating: true,
              responseId: 'bubble-live-1', responseText: '事件驱动'
            }
          }
        }
      }
    )
    try {
      // 首次遥测刷新建立 lastRuntimeArgs 基线
      service.refreshTelemetry()
      await vi.waitFor(() => { expect(inspectCalls).toBeGreaterThan(0) })
      const before = inspectCalls
      // 等待 inspect 节流窗口（120ms）过去，写信号才不会被节流挡住
      await new Promise((resolve) => setTimeout(resolve, 200))
      // 无关 composer 的写信号：不触发
      service.notifyComposerWriteSignal('composer-other')
      expect(inspectCalls).toBe(before)
      // 绑定 composer 的写信号：立即触发 inspect
      service.notifyComposerWriteSignal('composer-alpha-123')
      await vi.waitFor(() => { expect(inspectCalls).toBeGreaterThan(before) })
      await vi.waitFor(() => expect(service.getSnapshot().liveAgentResponses?.['1']?.text).toBe('事件驱动'))
    } finally {
      service.dispose()
    }
  })

  it('writes CDP runtime activity of generating composers back into presence (P0-1)', async () => {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'sg-p01-')), 'channel.sqlite3')
    )
    const relay = new ChannelMessageRelay(repository)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      // Agent 取走消息进入长任务：MCP 心跳停在 1_000，此后不再调用任何工具。
      repository.touchPresence('1', { waiting: false, connectionPhase: 'processing', lastSeenAt: 1_000 }, 1_000)
      const service = new DesktopSessionService(
        new FakeBridge(relay),
        new FakeTeam(active),
        { readWorkspace: () => ({ ...telemetry(), composers: [] }) },
        relay,
        {
          inspectComposerRuntime: async () => ({
            'composer-alpha-123': {
              composerId: 'composer-alpha-123', state: 'active', detail: '正在生成',
              observedAt: 123_456, isGenerating: true
            }
          })
        }
      )
      try {
        service.refreshTelemetry()
        // CDP 生成证据必须落 presence（此前只停留在内存 telemetry）：
        // runtimeActiveAt 推进，MCP 心跳与协议相位不被污染。
        await vi.waitFor(() => {
          expect(repository.getPresence('1')?.runtimeActiveAt).toBe(123_456)
        })
        expect(repository.getPresence('1')).toMatchObject({
          lastSeenAt: 1_000,
          connectionPhase: 'processing'
        })
      } finally {
        service.dispose()
      }
    } finally {
      repository.close()
    }
  })

  it('does not drop the final write signal while an inspection is already in flight', async () => {
    vi.useFakeTimers()
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    let inspectCalls = 0
    let finishFirst!: (value: Record<string, never>) => void
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(active),
      { readWorkspace: () => ({ ...telemetry(), composers: [] }) },
      undefined,
      {
        inspectComposerRuntime: async () => {
          inspectCalls += 1
          if (inspectCalls === 1) return new Promise((resolve) => { finishFirst = resolve })
          return {}
        }
      }
    )
    try {
      service.refreshTelemetry()
      expect(inspectCalls).toBe(1)
      service.notifyComposerWriteSignal('composer-alpha-123')
      finishFirst({})
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(150)
      expect(inspectCalls).toBe(2)
    } finally {
      service.dispose()
      vi.useRealTimers()
    }
  })



  it('uses live Cursor termination evidence to flip a stale processing session offline immediately', async () => {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const source: CursorComposerTelemetrySource = {
      readWorkspace: () => ({
        ...telemetry(),
        composers: [{
          ...telemetry().composers[0]!,
          activity: {
            state: 'unknown', workInProgress: true,
            detail: 'Agent 疑似在执行长任务', channelId: '1'
          }
        }]
      })
    }
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(active),
      source,
      undefined,
      {
        inspectComposerRuntime: async () => ({
          'composer-alpha-123': {
            composerId: 'composer-alpha-123', state: 'stopped',
            detail: 'Cursor Agent 已因错误终止', observedAt: Date.now()
          }
        })
      }
    )
    try {
      service.refreshTelemetry()
      await vi.waitFor(() => {
        expect(service.getSnapshot().sessions[0]).toMatchObject({
          status: 'offline', online: false, connected: false, waiting: false
        })
      })
      expect(service.getSnapshot().sessions[0]?.healthEvidence).toContain('Cursor Agent 已因错误终止')
    } finally {
      service.dispose()
    }
  })



  it('prefers the per-composer model profile over the global current config', () => {
    const snapshot = enrichDesktopSnapshot(
      bridgeSnapshot(),
      teamSnapshot('composer-alpha-123'),
      {
        ...telemetry(),
        composers: [{
          ...telemetry().composers[0]!,
          modelProfile: {
            scope: 'cursor-composer-current',
            modelId: 'kimi-k3',
            displayName: 'Kimi K3',
            options: ['Think'],
            maxMode: true,
            contextTokenLimit: 1_048_576
          }
        }]
      }
    )

    expect(snapshot.sessions[0]?.executionProfile).toMatchObject({
      modelId: 'kimi-k3',
      options: ['Think'],
      maxMode: true
    })
  })

  it('projects the launch-time selection one-to-one ahead of Cursor read-back', () => {
    const team = teamSnapshot('composer-alpha-123')
    const withSelection: typeof team = {
      ...team,
      members: [{
        slot: {
          id: 'slot-1', runId: 'run-a', roleId: 'role-1', name: '主控席',
          channelId: '1', order: 0, createdAt: 1, updatedAt: 1, avatarId: 'lead',
          modelSelection: {
            modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol',
            parameters: [{ id: 'reasoning', value: 'medium' }, { id: 'context', value: '1m' }],
            maxMode: true
          }
        },
        role: {
          id: 'role-1', runId: 'run-a', key: 'lead', templateKey: 'lead', name: '主控协调',
          mission: '', instructions: '', capabilities: [], skills: [], accent: 'mint', order: 0
        },
        binding: team.bindings[0],
        readiness: 'ready'
      }] as typeof team.members
    }
    const snapshot = enrichDesktopSnapshot(bridgeSnapshot(), withSelection, telemetry())

    expect(snapshot.sessions[0]?.executionProfile).toEqual({
      scope: 'cursor-composer-current',
      modelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      options: ['Think', '1M'],
      maxMode: true,
      contextTokenLimit: 1_000_000
    })
  })

  it('persists a deterministic candidate once and immediately exposes it as bound', () => {
    const team = new FakeTeam()
    const source: CursorComposerTelemetrySource = {
      readWorkspace: () => ({
        ...telemetry(),
        bindingCandidates: [{
          channelId: '1',
          composerId: 'composer-alpha-123',
          generation: 'generation123',
          bindingKey: 'generation123',
          method: 'launch_marker'
        }]
      })
    }
    const service = new DesktopSessionService(new FakeBridge(), team, source)
    try {
      service.refreshTelemetry()
      service.refreshTelemetry()
      expect(team.recorded).toHaveLength(1)
      expect(service.getSnapshot().sessions[0]?.telemetry?.state).toBe('bound')
    } finally {
      service.dispose()
    }
  })

  it('contains telemetry-source failures so the polling loop cannot take down the desktop bridge', () => {
    const source: CursorComposerTelemetrySource = {
      readWorkspace: () => { throw new Error('database busy') }
    }
    const service = new DesktopSessionService(new FakeBridge(), new FakeTeam(), source)
    try {
      expect(() => service.refreshTelemetry()).not.toThrow()
      expect(service.getSnapshot().sessions[0]?.telemetry).toMatchObject({
        state: 'error',
        detail: 'database busy'
      })
    } finally {
      service.dispose()
    }
  })

  it('keeps transport data intact when no workspace has been selected', () => {
    const snapshot = enrichDesktopSnapshot(
      bridgeSnapshot(),
      emptyTeamControlSnapshot(),
      emptyCursorTelemetrySnapshot()
    )
    expect(snapshot.sessions[0]).toMatchObject({
      channelId: '1',
      status: 'waiting',
      telemetry: { state: 'unavailable' }
    })
  })

  it('reuses session view references across unchanged snapshots and rebuilds on real change', () => {
    const service = new DesktopSessionService(new FakeBridge(), new FakeTeam(), {
      readWorkspace: () => telemetry()
    })
    try {
      // 先让遥测进入稳态，再验证「值无变化 → 视图引用复用」
      service.refreshTelemetry()
      const first = service.getSnapshot()
      const second = service.getSnapshot()
      expect(second.sessions[0]).toBe(first.sessions[0])
      service.refreshTelemetry()
      const third = service.getSnapshot()
      expect(third.sessions[0]).toBe(first.sessions[0])
    } finally {
      service.dispose()
    }
  })

  it('rebuilds the session view when online state flips', () => {
    const bridge = new FakeBridge()
    const service = new DesktopSessionService(bridge, new FakeTeam(), {
      readWorkspace: () => telemetry()
    })
    try {
      const first = service.getSnapshot()
      bridge.setOnline(false)
      const second = service.getSnapshot()
      expect(second.sessions[0]).not.toBe(first.sessions[0])
      expect(second.sessions[0]?.online).toBe(false)
    } finally {
      service.dispose()
    }
  })

  it('rebuilds the conversation model badges when the saved reasoning changes', () => {
    const snapshot = teamSnapshot('composer-alpha-123')
    snapshot.members = [{
      slot: {
        id: 'slot-1', runId: 'run-a', roleId: 'role-1', name: '主控席',
        channelId: '1', order: 0, createdAt: 1, updatedAt: 1, avatarId: 'lead',
        modelSelection: {
          modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol',
          parameters: [{ id: 'reasoning', value: 'medium' }, { id: 'context', value: '1m' }],
          maxMode: true
        }
      },
      role: {
        id: 'role-1', runId: 'run-a', key: 'lead', templateKey: 'lead', name: '主控协调',
        mission: '', instructions: '', capabilities: [], skills: [], accent: 'mint', order: 0
      },
      binding: snapshot.bindings[0],
      readiness: 'ready'
    }] as typeof snapshot.members
    const team = new FakeTeam(snapshot)
    const service = new DesktopSessionService(new FakeBridge(), team, {
      readWorkspace: () => telemetry()
    })
    try {
      const first = service.getSnapshot().sessions[0]!
      expect(first.executionProfile?.options).toEqual(['Think', '1M'])
      team.setReasoning('max')
      const second = service.getSnapshot().sessions[0]!
      expect(second).not.toBe(first)
      expect(second.executionProfile?.options).toEqual(['Think', 'Max', '1M'])
    } finally {
      service.dispose()
    }
  })


  it('slows telemetry polling to the idle cadence when no team run is active', () => {
    vi.useFakeTimers()
    try {
      let reads = 0
      const service = new DesktopSessionService(new FakeBridge(), new FakeTeam(), {
        readWorkspace: () => {
          reads += 1
          return telemetry()
        }
      })
      try {
        // FakeTeam 无 activeRun → 空闲档：初始一次后立即降频，2s 档窗口内不再读
        service.startWatcher()
        expect(reads).toBe(1)
        vi.advanceTimersByTime(3_000)
        expect(reads).toBe(1)
        vi.advanceTimersByTime(7_500)
        expect(reads).toBe(2)
      } finally {
        service.dispose()
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('channel composer context fallback', () => {
  it('falls back field-by-field when the bound composer is present but contextUsage is temporarily absent', () => {
    const base = telemetry('composer-bound-no-context')
    const snapshot = enrichDesktopSnapshot(
      bridgeSnapshot(),
      teamSnapshot('composer-bound-no-context'),
      {
        ...base,
        composers: [
          { ...base.composers[0]!, contextUsage: undefined },
          {
            composerId: 'composer-channel-context', title: '同通道上下文来源', createdAt: 20, lastUpdatedAt: 31,
            contextUsage: { ratio: 0.42 }
          }
        ],
        channelActivities: {
          '1': {
            channelId: '1', state: 'active', detail: '同通道转录仍在增长',
            composerId: 'composer-channel-context', observedAt: 31
          }
        }
      }
    )

    expect(snapshot.sessions[0]?.composerId).toBe('composer-bound-no-context')
    expect(snapshot.sessions[0]?.contextUsage).toEqual({ ratio: 0.42 })
  })

  it('keeps the last known context value across a transient telemetry hole', () => {
    let includeContext = true
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(teamSnapshot('composer-alpha-123')),
      {
        readWorkspace: () => {
          const next = telemetry()
          return {
            ...next,
            composers: next.composers.map((composer) => ({
              ...composer,
              contextUsage: includeContext ? composer.contextUsage : undefined
            }))
          }
        }
      }
    )
    try {
      service.refreshTelemetry()
      expect(service.getSnapshot().sessions[0]?.contextUsage).toEqual({ ratio: 0.63 })
      includeContext = false
      service.refreshTelemetry()
      expect(service.getSnapshot().sessions[0]?.contextUsage).toEqual({ ratio: 0.63 })
    } finally {
      service.dispose()
    }
  })

  it('shows context usage from the channel-located composer when no composer binding exists', () => {
    const base = telemetry()
    const snapshot = enrichDesktopSnapshot(
      bridgeSnapshot(),
      teamSnapshot(),
      {
        ...base,
        composers: [{
          composerId: 'composer-chan-located-1',
          title: '跨工作区会话',
          createdAt: 20,
          lastUpdatedAt: 30,
          contextUsage: { ratio: 0.69 }
        }],
        channelActivities: {
          '1': {
            channelId: '1',
            state: 'active',
            detail: '通道会话转录仍在增长',
            composerId: 'composer-chan-located-1'
          }
        }
      }
    )

    expect(snapshot.sessions[0]?.composerId).toBeUndefined()
    expect(snapshot.sessions[0]?.contextUsage).toEqual({ ratio: 0.69 })
  })


  it('keeps context empty when neither binding nor channel evidence can locate a composer', () => {
    const snapshot = enrichDesktopSnapshot(
      bridgeSnapshot(),
      teamSnapshot(),
      { ...telemetry(), composers: [], channelActivities: {} }
    )
    expect(snapshot.sessions[0]?.contextUsage).toBeUndefined()
  })
})

describe('虚拟回合封口（阶段 B：outboundId 精确关闭边界）', () => {
  it('seals the reply at record_reply and keeps process_blocks_json byte-stable across keepalive frames', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'sg-turn-seal-')), 'channel.sqlite3')
    )
    const relay = new ChannelMessageRelay(repository)
    const channelService = new ChannelMessageService(repository)
    const dbPath = repository.path
    const service = new DesktopSessionService(
      new FakeBridge(relay),
      new FakeTeam(active),
      { readWorkspace: () => telemetry() },
      relay,
      { inspectComposerRuntime: async () => ({}) }
    )
    const readReplyRow = (): { json: string | null; outbound: string | null } => {
      const raw = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = raw.prepare(
          'SELECT process_blocks_json, outbound_id FROM channel_replies WHERE channel_id = ? ORDER BY created_at ASC'
        ).get('1') as { process_blocks_json: string | null; outbound_id: string | null }
        return { json: row?.process_blocks_json ?? null, outbound: row?.outbound_id ?? null }
      } finally {
        raw.close()
      }
    }
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      relay.resetScope('run-a', 1)
      relay.start(250)

      // m1 入队并投递（deliveredAt = 开放边界），presence 守门同时打开
      relay.sendMessage({ channelId: '1', text: '你是谁' })
      const m1 = repository.listPendingOutbound('1')[0]!
      repository.markOutboundDelivered([m1.id], 100_500)
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'processing', lastSeenAt: 100_500,
        pendingReplySyncSince: 100_500, pendingOutboundId: m1.id
      }, 100_500)
      vi.advanceTimersByTime(300)

      service.refreshTelemetry()
      // 回合内过程块（无原生 startedAt → 首次观测 100_600）
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: 100_600, isGenerating: true,
        process: {
          turnId: 'user-t1',
          items: [{ kind: 'tool', id: 'cursor:work-1', toolName: 'read_file', toolKind: 'read', summary: '读文件', status: 'done' }],
          generatingBubbleCount: 1
        }
      })

      // Agent 回复落库（关闭边界 = reply.createdAt），outboundId 精确关联
      vi.setSystemTime(101_000)
      const reply1 = channelService.recordReply({ channelId: '1', content: '我是构建工程师。' })
      expect(reply1.outboundId).toBe(m1.id)
      vi.advanceTimersByTime(300)

      // 封口：回合内块持久化到 reply1
      let snapshot = service.getSnapshot()
      const replyEntry = snapshot.conversations['1']?.find((entry) => entry.id === `reply:${reply1.id}`)
      expect(replyEntry?.processBlocks?.map((block) => block.id)).toEqual(['cursor:work-1'])
      const sealed = readReplyRow()
      expect(sealed.json).toContain('cursor:work-1')
      expect(sealed.outbound).toBe(m1.id)

      // 回复后的 keepalive 帧（60s 周期噪声）：封口后的块不得写入已封口回复
      for (const [at, keepaliveId] of [[101_500, 'cursor:keepalive-1'], [102_100, 'cursor:keepalive-2']] as const) {
        vi.setSystemTime(at)
        service.notifyNativeProcessSnapshot({
          composerId: 'composer-alpha-123', observedAt: at, isGenerating: true,
          process: {
            turnId: 'user-t1',
            items: [
              { kind: 'tool', id: 'cursor:work-1', toolName: 'read_file', toolKind: 'read', summary: '读文件', status: 'done' },
              { kind: 'thinking', id: keepaliveId, text: '保活思考', status: 'running' }
            ],
            generatingBubbleCount: 1
          }
        })
        service.getSnapshot()
        expect(readReplyRow().json).toBe(sealed.json)
      }

      // 新一轮：m2 投递、新 turn 帧回流旧块（256 窗口水合），旧块不得进入 m2 的回复
      vi.setSystemTime(103_000)
      relay.sendMessage({ channelId: '1', text: '继续' })
      const m2 = repository.listPendingOutbound('1')[0]!
      repository.markOutboundDelivered([m2.id], 103_500)
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'processing', lastSeenAt: 103_500,
        pendingReplySyncSince: 103_500, pendingOutboundId: m2.id
      }, 103_500)
      vi.advanceTimersByTime(300)
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: 103_600, isGenerating: true,
        process: {
          turnId: 'user-t2',
          items: [
            { kind: 'tool', id: 'cursor:work-1', toolName: 'read_file', toolKind: 'read', summary: '旧块回流', status: 'done' },
            { kind: 'tool', id: 'cursor:work-2', toolName: 'edit_file', toolKind: 'edit', summary: '新块', status: 'done' }
          ],
          generatingBubbleCount: 1
        }
      })
      vi.setSystemTime(104_000)
      const reply2 = channelService.recordReply({ channelId: '1', content: '第二轮完成。' })
      expect(reply2.outboundId).toBe(m2.id)
      vi.advanceTimersByTime(300)
      snapshot = service.getSnapshot()
      const reply2Entry = snapshot.conversations['1']?.find((entry) => entry.id === `reply:${reply2.id}`)
      expect(reply2Entry?.processBlocks?.map((block) => block.id)).toEqual(['cursor:work-2'])
      // 第一轮封口字节在整个过程中保持不变
      expect(readReplyRow().json).toBe(sealed.json)
    } finally {
      service.dispose()
      relay.stop()
      vi.useRealTimers()
      repository.close()
    }
  })

  it('stamps transcript fallback blocks with their first observation time and keeps it stable', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const transcriptTelemetry = (): CursorTelemetrySnapshot => ({
      ...telemetry(),
      composers: [{
        ...telemetry().composers[0]!,
        lastAssistantProcess: {
          blocks: [{ kind: 'thinking', id: 'transcript:3:0', text: '转录思考', status: 'done', timingEstimated: true }],
          observedAt: 2_000
        }
      }]
    })
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(active),
      { readWorkspace: () => transcriptTelemetry() }
    )
    try {
      service.refreshTelemetry()
      expect(service.getSnapshot().liveProcess?.['1']?.blocks[0]).toMatchObject({
        id: 'transcript:3:0', startedAt: 2_000
      })

      // 后续遥测刷新（mtime 推进）不得改写首次观测时间——否则旧块会被挪入
      // 新投递消息的回合（重连水合污染）。
      vi.setSystemTime(60_000)
      service.refreshTelemetry()
      expect(service.getSnapshot().liveProcess?.['1']?.blocks[0]).toMatchObject({
        id: 'transcript:3:0', startedAt: 2_000
      })
    } finally {
      service.dispose()
      vi.useRealTimers()
    }
  })
})

describe('过程帧契约（阶段 C：snapshotComplete 权威合并）', () => {
  function buildService() {
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(teamSnapshot('composer-alpha-123')),
      { readWorkspace: () => telemetry() }
    )
    const update = (service as unknown as {
      updateLiveCursorProcess(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
    }).updateLiveCursorProcess.bind(service)
    return { service, update }
  }

  it('retracts stale visible blocks when a complete empty snapshot arrives (RC-3: mcp-- 撤回)', () => {
    vi.useFakeTimers()
    const base = Date.now()
    vi.setSystemTime(base)
    const { service, update } = buildService()
    try {
      // 帧 1：部分水合的 MCP 占位块（真实 toolName 下一帧才到）
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'observer', observedAt: base,
        isGenerating: true,
        process: {
          turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 1,
          items: [{ kind: 'tool', id: 'cursor:mcp-bubble-1', toolName: 'mcptoolcall', toolKind: 'mcp', summary: '', status: 'running' }]
        }
      })
      expect(service.getSnapshot().liveProcess?.['1']?.blocks.map((block) => block.id))
        .toEqual(['cursor:mcp-bubble-1'])

      // 帧 2：完整水合 → 识别为 check_messages 被过滤 → 权威空集：占位块撤下
      const retracted = update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'observer', observedAt: base + 100,
        isGenerating: true,
        process: { turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 1, items: [] }
      })
      expect(retracted).toBe(true)
      expect(service.getSnapshot().liveProcess?.['1']).toBeUndefined()
    } finally {
      service.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps out-of-window history but retracts in-window absent blocks on truncated frames', () => {
    vi.useFakeTimers()
    const base = Date.now()
    vi.setSystemTime(base)
    const { service, update } = buildService()
    try {
      // 帧 1：A（老历史）、B、C 三个块
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'observer', observedAt: base,
        isGenerating: true,
        process: {
          turnId: 'user-long', snapshotComplete: true, generatingBubbleCount: 2,
          items: [
            { kind: 'tool', id: 'cursor:a', toolName: 'read_file', toolKind: 'read', summary: '旧历史', status: 'done', startedAt: base - 10_000 },
            { kind: 'tool', id: 'cursor:b', toolName: 'edit_file', toolKind: 'edit', summary: '窗口内', status: 'running', startedAt: base - 500 },
            { kind: 'tool', id: 'cursor:c', toolName: 'run_terminal_cmd', toolKind: 'command', summary: '窗口内', status: 'running', startedAt: base - 100 }
          ]
        }
      })
      // 帧 2：截断帧（窗口起点 = 帧内最老项 A 的 base-10_000），A、C 在帧内；
      // B（base-500）在窗口内却缺席 → 撤下；A 在帧内继续存在
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'observer', observedAt: base + 100,
        isGenerating: true,
        process: {
          turnId: 'user-long', snapshotComplete: true, generatingBubbleCount: 1,
          truncatedItemCount: 3,
          items: [
            { kind: 'tool', id: 'cursor:a', toolName: 'read_file', toolKind: 'read', summary: '旧历史', status: 'done', startedAt: base - 10_000 },
            { kind: 'tool', id: 'cursor:c', toolName: 'run_terminal_cmd', toolKind: 'command', summary: '窗口内', status: 'done', startedAt: base - 100 }
          ]
        }
      })
      const blocks = service.getSnapshot().liveProcess?.['1']?.blocks ?? []
      expect(blocks.map((block) => block.id)).toEqual(['cursor:a', 'cursor:c'])
      expect(blocks.find((block) => block.id === 'cursor:c')).toMatchObject({ status: 'done' })
    } finally {
      service.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps append-merge semantics for legacy frames without snapshotComplete', () => {
    // 旧版 hook（v14 及以前）过渡期帧不带标记：缺席块保留（原追加合并语义），
    // 防止升级窗口期旧块凭空消失。
    vi.useFakeTimers()
    const base = Date.now()
    vi.setSystemTime(base)
    const { service, update } = buildService()
    try {
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'observer', observedAt: base,
        isGenerating: true,
        process: {
          turnId: 'user-t1', generatingBubbleCount: 1,
          items: [{ kind: 'thinking', id: 'cursor:th-1', text: '旧帧思考', status: 'running' }]
        }
      })
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'observer', observedAt: base + 100,
        isGenerating: true,
        process: {
          turnId: 'user-t1', generatingBubbleCount: 1,
          items: [{ kind: 'thinking', id: 'cursor:th-2', text: '新帧思考', status: 'running' }]
        }
      })
      expect(service.getSnapshot().liveProcess?.['1']?.blocks.map((block) => block.id))
        .toEqual(['cursor:th-1', 'cursor:th-2'])
    } finally {
      service.dispose()
      vi.useRealTimers()
    }
  })

  it('settles running blocks at seal time and blocks cross-reply reflow', async () => {
    // 阶段 E：封口时 running 块结算为完成态（完成时间 = 回复关闭边界）；
    // 后续帧不重写封口块（字节稳定）；旧块回流进新 turn 的帧不得二次持久化。
    vi.useFakeTimers()
    vi.setSystemTime(200_000)
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'sg-reply-refresh-')), 'channel.sqlite3')
    )
    const relay = new ChannelMessageRelay(repository)
    const channelService = new ChannelMessageService(repository)
    const service = new DesktopSessionService(
      new FakeBridge(relay),
      new FakeTeam(active),
      { readWorkspace: () => telemetry() },
      relay,
      { inspectComposerRuntime: async () => ({}) }
    )
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      relay.resetScope('run-a', 1)
      relay.start(250)
      service.refreshTelemetry()

      relay.sendMessage({ channelId: '1', text: '开始' })
      const m1 = repository.listPendingOutbound('1')[0]!
      repository.markOutboundDelivered([m1.id], 200_500)
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'processing', lastSeenAt: 200_500,
        pendingReplySyncSince: 200_500, pendingOutboundId: m1.id
      }, 200_500)
      vi.advanceTimersByTime(300)

      // 帧：work-1 仍在 running（回复尚未落库）
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: 200_600, isGenerating: true,
        process: {
          turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 1,
          items: [{ kind: 'tool', id: 'cursor:work-1', toolName: 'read_file', toolKind: 'read', summary: '读文件', status: 'running', startedAt: 200_550 }]
        }
      })
      // 回复落库即封口：running 的 work-1 结算为完成态（§E.3）
      vi.setSystemTime(201_000)
      const reply1 = channelService.recordReply({ channelId: '1', content: '第一轮答复。' })
      vi.advanceTimersByTime(300)
      const entry1 = service.getSnapshot().conversations['1']?.find((e) => e.id === `reply:${reply1.id}`)
      expect(entry1?.processBlocks?.[0]).toMatchObject({
        id: 'cursor:work-1', status: 'done', completedAt: 201_000, timingEstimated: true
      })

      // 帧：work-1 完成——封口块不可变，不重写（committed 过滤后不入直播源）
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: 201_200, isGenerating: false,
        process: {
          turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 0,
          items: [{ kind: 'tool', id: 'cursor:work-1', toolName: 'read_file', toolKind: 'read', summary: '读文件', status: 'done', startedAt: 200_550 }]
        }
      })
      vi.advanceTimersByTime(300)
      const stable1 = service.getSnapshot().conversations['1']?.find((e) => e.id === `reply:${reply1.id}`)
      expect(stable1?.processBlocks?.[0]).toMatchObject({
        id: 'cursor:work-1', status: 'done', completedAt: 201_000
      })

      // m2 投递；新 turn 帧回流旧块（无 startedAt → 观测时间戳）+ 新块
      vi.setSystemTime(202_000)
      relay.sendMessage({ channelId: '1', text: '继续' })
      const m2 = repository.listPendingOutbound('1')[0]!
      repository.markOutboundDelivered([m2.id], 202_500)
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'processing', lastSeenAt: 202_500,
        pendingReplySyncSince: 202_500, pendingOutboundId: m2.id
      }, 202_500)
      vi.advanceTimersByTime(300)
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: 202_600, isGenerating: true,
        process: {
          turnId: 'user-t2', snapshotComplete: true, generatingBubbleCount: 1,
          items: [
            { kind: 'tool', id: 'cursor:work-1', toolName: 'read_file', toolKind: 'read', summary: '旧块回流', status: 'done' },
            { kind: 'tool', id: 'cursor:work-2', toolName: 'edit_file', toolKind: 'edit', summary: '新块', status: 'done' }
          ]
        }
      })
      vi.setSystemTime(203_000)
      const reply2 = channelService.recordReply({ channelId: '1', content: '第二轮答复。' })
      vi.advanceTimersByTime(300)
      const entry2 = service.getSnapshot().conversations['1']?.find((e) => e.id === `reply:${reply2.id}`)
      expect(entry2?.processBlocks?.map((block) => block.id)).toEqual(['cursor:work-2'])
      // reply1 的封口内容保持稳定
      const stable = service.getSnapshot().conversations['1']?.find((e) => e.id === `reply:${reply1.id}`)
      expect(stable?.processBlocks?.map((block) => block.id)).toEqual(['cursor:work-1'])
    } finally {
      service.dispose()
      relay.stop()
      vi.useRealTimers()
      repository.close()
    }
  })
})

describe('事件驱动封口与持久化（阶段 E：RC-7）', () => {
  function buildSealFixture() {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'sg-stage-e-')), 'channel.sqlite3')
    )
    const relay = new ChannelMessageRelay(repository)
    const channelService = new ChannelMessageService(repository)
    const service = new DesktopSessionService(
      new FakeBridge(relay),
      new FakeTeam(active),
      { readWorkspace: () => telemetry() },
      relay,
      { inspectComposerRuntime: async () => ({}) }
    )
    const dbPath = repository.path
    const dumpReplies = (): unknown[] => {
      const raw = new DatabaseSync(dbPath, { readOnly: true })
      try {
        return raw.prepare(
          'SELECT id, content, visible, outbound_id, process_blocks_json, process_turn, process_truncated_count, created_at, consumed_at FROM channel_replies ORDER BY id'
        ).all()
      } finally {
        raw.close()
      }
    }
    const deliverMessage = (text: string, at: number) => {
      relay.sendMessage({ channelId: '1', text })
      const outbound = repository.listPendingOutbound('1')[0]!
      repository.markOutboundDelivered([outbound.id], at)
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'processing', lastSeenAt: at,
        pendingReplySyncSince: at, pendingOutboundId: outbound.id
      }, at)
      return outbound
    }
    return { active, repository, relay, channelService, service, dbPath, dumpReplies, deliverMessage }
  }

  it('keeps getSnapshot free of SQLite write side effects (§8.4-2)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(300_000)
    const f = buildSealFixture()
    try {
      f.repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      f.relay.resetScope('run-a', 1)
      f.relay.start(250)
      f.service.refreshTelemetry()
      const m1 = f.deliverMessage('你是谁', 300_500)
      vi.advanceTimersByTime(300)

      // 直播源在场、回复未落库：连续 getSnapshot 不得产生任何写
      f.service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: 300_600, isGenerating: true,
        process: {
          turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 1,
          items: [{ kind: 'tool', id: 'cursor:work-1', toolName: 'read_file', toolKind: 'read', summary: '读文件', status: 'running', startedAt: 300_550 }]
        }
      })
      expect(f.dumpReplies()).toEqual([])
      f.service.getSnapshot()
      f.service.getSnapshot()
      f.service.getSnapshot()
      expect(f.dumpReplies()).toEqual([])

      // 回复直写落库（relay 尚未 poll 到）：getSnapshot 不得代行封口（RC-7——
      // 读取无副作用；封口只能由 relay 事件 / 过程帧事件触发）。
      vi.setSystemTime(301_000)
      const reply = f.channelService.recordReply({ channelId: '1', content: '答复。' })
      expect(reply.outboundId).toBe(m1.id)
      const attachSpy = vi.spyOn(f.relay, 'attachProcessToReply')
      f.service.getSnapshot()
      f.service.getSnapshot()
      f.service.getSnapshot()
      expect(attachSpy).not.toHaveBeenCalled()
      const unsealed = f.dumpReplies()
      expect(unsealed).toHaveLength(1)
      expect((unsealed[0] as { process_blocks_json: string | null }).process_blocks_json).toBeNull()

      // relay tick（pollReplies 发现回复）事件驱动封口，一次写
      vi.advanceTimersByTime(300)
      expect(attachSpy).toHaveBeenCalledTimes(1)
      const sealed = f.dumpReplies()
      expect(JSON.stringify(sealed)).toContain('cursor:work-1')

      // 封口后连续 getSnapshot：零 attach、行内容字节级不变
      attachSpy.mockClear()
      f.service.getSnapshot()
      f.service.getSnapshot()
      f.service.getSnapshot()
      expect(attachSpy).not.toHaveBeenCalled()
      expect(f.dumpReplies()).toEqual(sealed)

      // 封口过程经 relay 投影对快照可见（不是 getSnapshot 写出来的）
      const entry = f.service.getSnapshot().conversations['1']?.find((e) => e.id === `reply:${reply.id}`)
      expect(entry?.processBlocks?.map((block) => block.id)).toEqual(['cursor:work-1'])
      expect(entry?.turn).toBe(`cursor:user-t1:virtual:outbox:${m1.id}`)
    } finally {
      f.service.dispose()
      f.relay.stop()
      vi.useRealTimers()
      f.repository.close()
    }
  })

  it('recovers sealed processes across an app restart without noise reflow (§8.4-3)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(300_000)
    const f = buildSealFixture()
    let replyId = ''
    let sealed: unknown[] = []
    try {
      f.repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      f.relay.resetScope('run-a', 1)
      f.relay.start(250)
      f.service.refreshTelemetry()
      const m1 = f.deliverMessage('你是谁', 300_500)
      vi.advanceTimersByTime(300)
      f.service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: 300_600, isGenerating: true,
        process: {
          turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 1,
          items: [{ kind: 'tool', id: 'cursor:work-1', toolName: 'read_file', toolKind: 'read', summary: '读文件', status: 'running', startedAt: 300_550 }]
        }
      })
      vi.setSystemTime(301_000)
      const reply = f.channelService.recordReply({ channelId: '1', content: '答复。' })
      replyId = reply.id
      vi.advanceTimersByTime(300)
      sealed = f.dumpReplies()
      expect(sealed).toHaveLength(1)
    } finally {
      f.service.dispose()
      f.relay.stop()
      f.repository.close()
    }

    // 应用重启：同一数据库，relay 水合恢复封口过程
    const repository2 = new SqliteChannelMessageRepository(f.dbPath)
    const relay2 = new ChannelMessageRelay(repository2)
    relay2.start(250)
    const service2 = new DesktopSessionService(
      new FakeBridge(relay2),
      new FakeTeam(f.active),
      { readWorkspace: () => telemetry() },
      relay2,
      { inspectComposerRuntime: async () => ({}) }
    )
    try {
      const hydrated = service2.getSnapshot().conversations['1']?.find((e) => e.id === `reply:${replyId}`)
      expect(hydrated?.processBlocks?.map((block) => block.id)).toEqual(['cursor:work-1'])

      // Cursor 256 窗口回流帧（封口旧块 + keepalive 噪声）：不得改写封口字节，
      // 封口块也不得作为直播过程重复展示。
      service2.refreshTelemetry()
      service2.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: 302_000, isGenerating: true,
        process: {
          turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 1,
          items: [
            { kind: 'tool', id: 'cursor:work-1', toolName: 'read_file', toolKind: 'read', summary: '读文件', status: 'done', startedAt: 300_550 },
            { kind: 'thinking', id: 'cursor:th-keep', text: '保活思考', status: 'running' }
          ]
        }
      })
      expect(f.dumpReplies()).toEqual(sealed)
      const after = service2.getSnapshot()
      const replyEntry = after.conversations['1']?.find((e) => e.id === `reply:${replyId}`)
      expect(replyEntry?.processBlocks?.map((block) => block.id)).toEqual(['cursor:work-1'])
      expect(after.liveProcess?.['1']?.blocks.map((block) => block.id)).toEqual(['cursor:th-keep'])
    } finally {
      service2.dispose()
      relay2.stop()
      vi.useRealTimers()
      repository2.close()
    }
  })

  it('amends a late pre-close block delivered by the next process event (§E.7)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(300_000)
    const f = buildSealFixture()
    try {
      f.repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      f.relay.resetScope('run-a', 1)
      f.relay.start(250)
      f.service.refreshTelemetry()
      const m1 = f.deliverMessage('开始', 300_500)
      vi.advanceTimersByTime(300)

      // 帧 A：tool-1 仍在执行
      f.service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: 300_600, isGenerating: true,
        process: {
          turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 1,
          items: [{ kind: 'tool', id: 'cursor:tool-1', toolName: 'read_file', toolKind: 'read', summary: '读文件', status: 'running', startedAt: 300_550 }]
        }
      })
      vi.setSystemTime(301_000)
      const reply = f.channelService.recordReply({ channelId: '1', content: '答复。' })
      vi.advanceTimersByTime(300)
      const sealedOnce = f.dumpReplies()

      // 帧 B（下一过程事件）：tool-1 完成 + 迟到的前置块 tool-2（关闭边界前开始）
      f.service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: 301_200, isGenerating: true,
        process: {
          turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 1,
          items: [
            { kind: 'tool', id: 'cursor:tool-1', toolName: 'read_file', toolKind: 'read', summary: '读文件', status: 'done', startedAt: 300_550 },
            { kind: 'tool', id: 'cursor:tool-2', toolName: 'edit_file', toolKind: 'edit', summary: '迟到前置块', status: 'done', startedAt: 300_900 }
          ]
        }
      })
      const amended = f.dumpReplies()
      expect(amended).not.toEqual(sealedOnce)
      const entry = f.service.getSnapshot().conversations['1']?.find((e) => e.id === `reply:${reply.id}`)
      // tool-1 保持封口时的结算结果；tool-2 作为迟到前置块补写
      expect(entry?.processBlocks?.map((block) => [block.id, block.status, block.completedAt])).toEqual([
        ['cursor:tool-1', 'done', 301_000],
        ['cursor:tool-2', 'done', 301_200]
      ])
      expect(entry?.replyToEntryId).toBe(`outbox:${m1.id}`)
    } finally {
      f.service.dispose()
      f.relay.stop()
      vi.useRealTimers()
      f.repository.close()
    }
  })

  it('archives the previous native turn when the turn switches without a final frame (review R1)', () => {
    vi.useFakeTimers()
    const base = Date.now()
    vi.setSystemTime(base)
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(teamSnapshot('composer-alpha-123')),
      { readWorkspace: () => telemetry() }
    )
    const update = (service as unknown as {
      updateLiveCursorProcess(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
    }).updateLiveCursorProcess.bind(service)
    try {
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'generating', observedAt: base,
        isGenerating: true,
        process: {
          turnId: 'user-turn-1',
          items: [{ kind: 'thinking', id: 'thought-interrupted', text: '被打断的执行过程', status: 'running' }],
          generatingBubbleCount: 1
        }
      })
      // 用户新消息打断：turn 直接切换，没有 !generating 终结帧
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'new turn', observedAt: base + 1_000,
        isGenerating: true,
        process: {
          turnId: 'user-turn-2',
          items: [{ kind: 'thinking', id: 'thought-new', text: '新回合', status: 'running' }],
          generatingBubbleCount: 1
        }
      })
      const archive = (service as unknown as {
        nativeProcessArchive: Map<string, Array<{ turn: string }>>
      }).nativeProcessArchive
      expect(archive.get('1')?.some((item) => item.turn === 'cursor:user-turn-1')).toBe(true)
      // 新 turn 仍在直播视图，不进归档
      expect(archive.get('1')?.some((item) => item.turn === 'cursor:user-turn-2')).toBe(false)
    } finally {
      service.dispose()
      vi.useRealTimers()
    }
  })
})

describe('直播生成信号下发（RC-9：generating 随 LiveProcessState 传递）', () => {
  it('exposes the authoritative generating flag on the live process even when every block is done', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'sg-generating-flag-')), 'channel.sqlite3')
    )
    const relay = new ChannelMessageRelay(repository)
    const service = new DesktopSessionService(
      new FakeBridge(relay),
      new FakeTeam(active),
      { readWorkspace: () => telemetry() },
      relay,
      { inspectComposerRuntime: async () => ({}) }
    )
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      relay.resetScope('run-a', 1)
      service.refreshTelemetry()
      // Cursor 常见形态：回合仍在生成（isGenerating=true），但 Thinking 块
      // 已被标记 done——渲染层只有拿到 generating 才能识别为直播过程。
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: 1_000, isGenerating: true,
        process: {
          turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 1,
          items: [{ kind: 'thinking', id: 'cursor:th-1', text: '生成中的思考', status: 'done', startedAt: 900 }]
        }
      })
      expect(service.getSnapshot().liveProcess?.['1']).toMatchObject({
        turn: 'cursor:user-t1',
        generating: true
      })

      // 生成结束（!isGenerating 终结帧）：generating 翻转为 false。
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: 1_200, isGenerating: false,
        process: {
          turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 0,
          items: [{ kind: 'thinking', id: 'cursor:th-1', text: '生成中的思考', status: 'done', startedAt: 900 }]
        }
      })
      const finished = service.getSnapshot().liveProcess?.['1']
      expect(finished === undefined || finished.generating !== true).toBe(true)
    } finally {
      service.dispose()
      repository.close()
      vi.useRealTimers()
    }
  })
})

describe('封口防线：最终正文不重复成为过程 message（§8.4-4，2026-09-03 事故）', () => {
  it('strips a cursor-msg block whose text matches the reply content at seal time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(300_000)
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'sg-final-msg-seal-')), 'channel.sqlite3')
    )
    const relay = new ChannelMessageRelay(repository)
    const channelService = new ChannelMessageService(repository)
    const service = new DesktopSessionService(
      new FakeBridge(relay),
      new FakeTeam(active),
      { readWorkspace: () => telemetry() },
      relay,
      { inspectComposerRuntime: async () => ({}) }
    )
    const dbPath = repository.path
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      relay.resetScope('run-a', 1)
      relay.start(250)
      service.refreshTelemetry()
      relay.sendMessage({ channelId: '1', text: '如图这是什么' })
      const m1 = repository.listPendingOutbound('1')[0]!
      repository.markOutboundDelivered([m1.id], 300_500)
      repository.touchPresence('1', {
        waiting: false, connectionPhase: 'processing', lastSeenAt: 300_500,
        pendingReplySyncSince: 300_500, pendingOutboundId: m1.id
      }, 300_500)
      vi.advanceTimersByTime(300)

      // 事故形态帧：laterWork 误判让最终正文进 cursor-msg（与回复正文一字不差）
      const finalText = '这是微信（WeChat）的应用图标：绿色圆角方块，中间两个白色对话气泡叠在一起。'
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: 300_600, isGenerating: true,
        process: {
          turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 1,
          items: [
            { kind: 'tool', id: 'cursor:tool-1', toolName: 'read_file', toolKind: 'read', summary: '读图', status: 'done', startedAt: 300_550 },
            { kind: 'message', id: 'cursor-msg:final-1', text: finalText, status: 'done', startedAt: 300_580 }
          ]
        }
      })
      vi.setSystemTime(301_000)
      channelService.recordReply({ channelId: '1', content: finalText })
      vi.advanceTimersByTime(300)

      const raw = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = raw.prepare('SELECT process_blocks_json FROM channel_replies ORDER BY created_at DESC LIMIT 1').get() as { process_blocks_json: string | null }
        const blocks = JSON.parse(row.process_blocks_json ?? '[]') as Array<{ id: string; kind: string }>
        expect(blocks.map((block) => block.id)).toEqual(['cursor:tool-1'])
        expect(blocks.some((block) => block.kind === 'message')).toBe(false)
      } finally {
        raw.close()
      }
      // 渲染快照同样只剩工具块
      const entry = service.getSnapshot().conversations['1']?.find((e) => e.role === 'assistant')
      expect(entry?.processBlocks?.map((block) => block.id)).toEqual(['cursor:tool-1'])
    } finally {
      service.dispose()
      relay.stop()
      vi.useRealTimers()
      repository.close()
    }
  })
})

describe('直播正文改判为过程 message 时立即撤下（2026-09-04 双打字机事故）', () => {
  function runningService(): DesktopSessionService {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(active),
      { readWorkspace: () => ({ ...telemetry(), composers: [] }) },
      undefined,
      { inspectComposerRuntime: async () => ({}) }
    )
    service.refreshTelemetry()
    return service
  }

  it('revokes the live response the moment the same bubble reappears as cursor-msg (text → business tool)', () => {
    const service = runningService()
    try {
      const base = Date.now()
      const text = 'Now the core source. Let me read the main process entry and MCP server together.'
      // 帧 1：正文气泡 B1 之后没有业务工作 → 最终正文候选，走直播正文（TurnResponseText 打字机）。
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: base, isGenerating: true,
        process: { turnId: 'user-t1', items: [], generatingBubbleCount: 1, snapshotComplete: true },
        response: { id: 'bubble-b1', text }
      })
      expect(service.getSnapshot().liveAgentResponses?.['1']).toMatchObject({ id: 'bubble-b1', status: 'streaming' })

      // 帧 2：模型紧接着调用业务工具（read_file）→ B1 有后续工作，被改判为过程 message
      // （cursor-msg:bubble-b1 进入 items），写后快照不再携带 response。
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: base + 40, isGenerating: true,
        process: {
          turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 1,
          items: [
            { kind: 'message', id: 'cursor-msg:bubble-b1', text, status: 'done', startedAt: base },
            { kind: 'tool', id: 'cursor:bubble-b2', toolName: 'read_file', toolKind: 'read', summary: '/workspace/alpha/src/main/index.ts', status: 'running', startedAt: base + 35 }
          ]
        }
      })
      const snapshot = service.getSnapshot()
      expect(snapshot.liveProcess?.['1']?.blocks.map((block) => block.id)).toEqual(['cursor-msg:bubble-b1', 'cursor:bubble-b2'])
      // 同一段文字只能出现一次：过程卡已经接管 B1，直播正文必须在本帧即撤下，
      // 而不是等 2.5s 流式断帧时效才消失（那 2.5s 就是用户看到的「两个一模一样的打字机」）。
      expect(snapshot.liveAgentResponses?.['1']).toBeUndefined()

      // 撤下后模型再输出新的正文气泡 B3：直播正文以新身份恢复，不受此前撤下影响。
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: base + 900, isGenerating: true,
        process: {
          turnId: 'user-t1', snapshotComplete: true, generatingBubbleCount: 1,
          items: [
            { kind: 'message', id: 'cursor-msg:bubble-b1', text, status: 'done', startedAt: base },
            { kind: 'tool', id: 'cursor:bubble-b2', toolName: 'read_file', toolKind: 'read', summary: '/workspace/alpha/src/main/index.ts', status: 'done', startedAt: base + 35 }
          ]
        },
        response: { id: 'bubble-b3', text: '读完了，主进程入口在' }
      })
      expect(service.getSnapshot().liveAgentResponses?.['1']).toMatchObject({ id: 'bubble-b3', status: 'streaming' })
    } finally {
      service.dispose()
    }
  })

  it('keeps the live response when the following bubble is still a pending MCP call or transport noise (no cursor-msg)', () => {
    const service = runningService()
    try {
      const base = Date.now()
      const text = '已完成修复，下面是说明。'
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: base, isGenerating: true,
        process: { turnId: 'user-t1', items: [], generatingBubbleCount: 1, snapshotComplete: true },
        response: { id: 'bubble-final', text }
      })
      // 正文之后只有 record_reply/check_messages 脚手架：observer 过滤后 items 为空，
      // 正文仍是最终候选，写后快照继续携带 response —— 不得撤下。
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: base + 40, isGenerating: true,
        process: { turnId: 'user-t1', items: [], generatingBubbleCount: 1, snapshotComplete: true },
        response: { id: 'bubble-final', text }
      })
      expect(service.getSnapshot().liveAgentResponses?.['1']).toMatchObject({ id: 'bubble-final', status: 'streaming' })
      // 非权威帧（无 snapshotComplete）即使缺 response 也只是「本帧不携带」，不构成撤下证据。
      service.notifyNativeProcessSnapshot({
        composerId: 'composer-alpha-123', observedAt: base + 80, isGenerating: true,
        process: { turnId: 'user-t1', items: [], generatingBubbleCount: 1 }
      })
      expect(service.getSnapshot().liveAgentResponses?.['1']).toMatchObject({ id: 'bubble-final', status: 'streaming' })
    } finally {
      service.dispose()
    }
  })
})

describe('会话交接「等待新会话」：sendMessage 把意图换算为席位现任会话令牌', () => {
  function relayHarness(sessionToken?: string) {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    active.bindings[0]!.sessionToken = sessionToken
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'sg-hold-send-')), 'channel.sqlite3')
    )
    const relay = new ChannelMessageRelay(repository)
    repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
    relay.resetScope('run-a', 1)
    const service = new DesktopSessionService(
      new FakeBridge(relay), new FakeTeam(active), { readWorkspace: () => telemetry() }, relay
    )
    return { service, repository, relay }
  }

  it('enqueues with the seat token as hold so only a rebuilt session (new token) receives it', () => {
    const { service, repository, relay } = relayHarness('seat-token-A')
    try {
      expect(service.currentSessionToken('1')).toBe('seat-token-A')
      service.sendMessage({ channelId: '1', text: '【会话交接】读转录', holdUntilNewSession: true })
      const rows = repository.listPendingOutbound('1')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.holdSessionToken).toBe('seat-token-A')
      expect(repository.listPendingOutbound('1', { forSession: 'seat-token-A' })).toHaveLength(0)
      expect(repository.listPendingOutbound('1', { forSession: 'seat-token-B' })).toHaveLength(1)
      expect(service.getSnapshot().conversations['1']?.[0]?.heldForNextSession).toBe(true)
      // 渲染层撤回/放行经服务层转发
      const entryId = service.getSnapshot().conversations['1']![0]!.id
      expect(service.releaseQueuedMessage('1', entryId)).toBe(true)
      expect(repository.listPendingOutbound('1', { forSession: 'seat-token-A' })).toHaveLength(1)
      expect(service.withdrawQueuedMessage('1', entryId)).toBe(true)
      expect(repository.countPendingOutbound('1')).toBe(0)
      expect(service.getSnapshot().conversations['1'] ?? []).toHaveLength(0)
    } finally {
      service.dispose()
      relay.stop()
      repository.close()
    }
  })

  it('refuses the hold when the seat has no token and never leaks the internal hold field from the renderer', () => {
    const { service, repository, relay } = relayHarness(undefined)
    try {
      expect(() => service.sendMessage({ channelId: '1', text: 'x', holdUntilNewSession: true })).toThrowError(/没有会话令牌/)
      // 普通发送不带保持位
      service.sendMessage({ channelId: '1', text: '普通消息' })
      expect(repository.listPendingOutbound('1')[0]?.holdSessionToken).toBeUndefined()
    } finally {
      service.dispose()
      relay.stop()
      repository.close()
    }
  })
})

describe('遥测落盘态 contextTokensUsed → 用量采样转发（长会话近实时 TOKENS/COST 的活水源）', () => {
  function telemetryWithUsed(used?: number): CursorTelemetrySnapshot {
    const base = telemetry()
    return {
      ...base,
      composers: [{
        ...base.composers[0]!,
        contextUsage: used === undefined
          ? { ratio: 0.63 }
          : { used, limit: 200_000, ratio: used / 200_000 }
      }]
    }
  }

  it('每次成功刷新都把已绑定 Composer 的落盘读数交给采样 sink（去重归聚合器，不依赖快照 changed 分支）', () => {
    const samples: Array<{ composerId: string; used: number; observedAt: number }> = []
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(teamSnapshot('composer-alpha-123')),
      { readWorkspace: () => telemetryWithUsed(126_000) },
      undefined,
      undefined,
      undefined,
      (sample) => { samples.push(sample) }
    )
    try {
      service.refreshTelemetry()
      expect(samples).toEqual([expect.objectContaining({ composerId: 'composer-alpha-123', used: 126_000 })])
      // 遥测指纹未变（同一快照）也照样转发：记账去重是 applyRequestSample 的职责，
      // 推送节流是聚合器的职责——转发层不做任何裁剪。
      service.refreshTelemetry()
      expect(samples).toHaveLength(2)
    } finally {
      service.dispose()
    }
  })

  it('未绑定 Composer、缺失或非正的读数一律不转发', () => {
    const samples: unknown[] = []
    const sink = (sample: unknown) => { samples.push(sample) }
    const unbound = new DesktopSessionService(
      new FakeBridge(), new FakeTeam(teamSnapshot(undefined)),
      { readWorkspace: () => telemetryWithUsed(126_000) },
      undefined, undefined, undefined, sink
    )
    try {
      unbound.refreshTelemetry()
      expect(samples).toHaveLength(0)
    } finally {
      unbound.dispose()
    }
    const noUsed = new DesktopSessionService(
      new FakeBridge(), new FakeTeam(teamSnapshot('composer-alpha-123')),
      { readWorkspace: () => telemetryWithUsed(undefined) },
      undefined, undefined, undefined, sink
    )
    try {
      noUsed.refreshTelemetry()
      expect(samples).toHaveLength(0)
    } finally {
      noUsed.dispose()
    }
    const zeroUsed = new DesktopSessionService(
      new FakeBridge(), new FakeTeam(teamSnapshot('composer-alpha-123')),
      { readWorkspace: () => telemetryWithUsed(0) },
      undefined, undefined, undefined, sink
    )
    try {
      zeroUsed.refreshTelemetry()
      expect(samples).toHaveLength(0)
    } finally {
      zeroUsed.dispose()
    }
  })

  it('sink 异常不打断遥测主链：快照仍正常落地', () => {
    const calls: number[] = []
    const service = new DesktopSessionService(
      new FakeBridge(),
      new FakeTeam(teamSnapshot('composer-alpha-123')),
      { readWorkspace: () => telemetryWithUsed(126_000) },
      undefined,
      undefined,
      undefined,
      (sample) => {
        calls.push(sample.used)
        throw new Error('用量聚合器爆炸')
      }
    )
    try {
      service.refreshTelemetry()
      expect(calls).toEqual([126_000])
      expect(service.getSnapshot().sessions[0]?.contextUsage?.ratio).toBeCloseTo(0.63, 2)
    } finally {
      service.dispose()
    }
  })
})
