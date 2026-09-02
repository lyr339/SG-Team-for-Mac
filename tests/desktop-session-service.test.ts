import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import type { CursorComposerRuntimeEvidence } from '../src/infrastructure/cursor/cursor-cdp-session-creator'

function bridgeSnapshot(): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: 'shiguang://local-channel-runtime', attempt: 0, lastError: '' },
    sessions: [{
      id: 'qingtian-channel:1',
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

class FakeBridge implements DesktopSessionTransport {
  private readonly listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  private snapshot = bridgeSnapshot()

  getSnapshot(): DesktopSnapshot { return structuredClone(this.snapshot) }
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

  it('suppresses transcript fallback when the reply is already persisted by record_reply', async () => {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'qingtian-transcript-gate-')), 'channel.sqlite3')
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
        new FakeBridge(),
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

  it('retains a completed native process until persistence or a newer user turn takes ownership', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const bridge = new FakeBridge()
    const service = new DesktopSessionService(
      bridge,
      new FakeTeam(teamSnapshot('composer-alpha-123')),
      { readWorkspace: () => telemetry() }
    )
    const update = (service as unknown as {
      updateLiveCursorProcess(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
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
      update('1', {
        composerId: 'composer-alpha-123', state: 'unknown', detail: 'done', observedAt: 1_001_000,
        isGenerating: false
      })

      vi.setSystemTime(1_061_000)
      expect(service.getSnapshot().liveProcess?.['1']?.blocks[0]).toMatchObject({
        id: 'thought-retained', status: 'done'
      })

      bridge.setConversations({
        '1': [{
          id: 'user-next', channelId: '1', role: 'user', text: '下一轮', timestamp: 1_062_000,
          status: 'complete', source: 'desktop'
        }]
      })
      expect(service.getSnapshot().liveProcess?.['1']).toBeUndefined()
    } finally {
      service.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps consecutive native turns FIFO-bound to their exact assistant replies', () => {
    const active = teamSnapshot('composer-alpha-123')
    active.runs = [{
      id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
      status: 'running', createdAt: 1, updatedAt: 1
    }]
    active.activeRun = active.runs[0]
    const bridge = new FakeBridge()
    const service = new DesktopSessionService(
      bridge,
      new FakeTeam(active),
      { readWorkspace: () => telemetry() },
      undefined,
      { inspectComposerRuntime: async () => ({}) }
    )
    try {
      service.refreshTelemetry()
      const base = Date.now()
      for (const [turnId, blockId, at] of [['user-turn-1', 'tool-turn-1', base], ['user-turn-2', 'tool-turn-2', base + 1_000]] as const) {
        service.notifyNativeProcessSnapshot({
          composerId: 'composer-alpha-123', observedAt: at, isGenerating: true,
          process: {
            turnId,
            items: [{ kind: 'tool', id: blockId, toolName: 'read_file', toolKind: 'read', summary: blockId, status: 'running' }],
            generatingBubbleCount: 1
          }
        })
        service.notifyNativeProcessSnapshot({
          composerId: 'composer-alpha-123', observedAt: at + 100, isGenerating: false
        })
      }
      bridge.setConversations({
        '1': [
          { id: 'reply:one', channelId: '1', role: 'assistant', text: '第一轮', timestamp: base + 200, status: 'complete', source: 'cursor' },
          { id: 'reply:two', channelId: '1', role: 'assistant', text: '第二轮', timestamp: base + 1_200, status: 'complete', source: 'cursor' }
        ]
      })
      const first = service.getSnapshot().conversations['1']!
      expect(first[0]).toMatchObject({ turn: 'cursor:user-turn-1', processBlocks: [{ id: 'tool-turn-1' }] })
      expect(first[1]).toMatchObject({ turn: 'cursor:user-turn-2', processBlocks: [{ id: 'tool-turn-2' }] })
      const second = service.getSnapshot().conversations['1']!
      expect(second.map((entry) => entry.processBlocks?.[0]?.id)).toEqual(['tool-turn-1', 'tool-turn-2'])
    } finally {
      service.dispose()
    }
  })

  it('does not finalize a native process when an active runtime inspect omits process payload', () => {
    const service = new DesktopSessionService(
      new FakeBridge(), new FakeTeam(teamSnapshot('composer-alpha-123')), { readWorkspace: () => telemetry() }
    )
    const update = (service as unknown as {
      updateLiveCursorProcess(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
    }).updateLiveCursorProcess.bind(service)
    try {
      const base = Date.now()
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
      expect(service.getSnapshot().liveProcess?.['1']?.blocks[0]).toMatchObject({ id: 'work', status: 'running' })
    } finally {
      service.dispose()
    }
  })

  it('persists two virtual replies from one never-ending native Cursor turn by outbound identity', () => {
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
    const relay = new ChannelMessageRelay(repository)
    relay.resetScope('run-a', 1)
    const attachProcess = vi.spyOn(relay, 'attachProcessToReply')
    const service = new DesktopSessionService(
      new FakeBridge(), new FakeTeam(active), { readWorkspace: () => telemetry() }, relay
    )
    const update = (service as unknown as {
      updateLiveCursorProcess(channelId: string, evidence: CursorComposerRuntimeEvidence): boolean
    }).updateLiveCursorProcess.bind(service)
    try {
      update('1', {
        composerId: 'composer-alpha-123', state: 'active', detail: 'observer', observedAt: 2_600,
        isGenerating: true,
        process: {
          turnId: 'same-native-turn-for-entire-session',
          items: [
            { kind: 'thinking', id: 'work-1', text: '处理第一问', status: 'done', startedAt: 1_200 },
            { kind: 'thinking', id: 'work-2', text: '处理第二问', status: 'done', startedAt: 2_200 }
          ],
          generatingBubbleCount: 1
        }
      })
      const replies = service.getSnapshot().conversations['1']!.filter((entry) => entry.role === 'assistant')
      expect(replies.map((entry) => ({ replyTo: entry.replyToEntryId, blocks: entry.processBlocks?.map((block) => block.id) }))).toEqual([
        { replyTo: `outbox:${firstMessage.id}`, blocks: ['work-1'] },
        { replyTo: `outbox:${secondMessage.id}`, blocks: ['work-2'] }
      ])
      expect(repository.listRepliesSince(0).map((reply) => reply.processBlocks?.map((block) => block.id))).toEqual([
        ['work-1'], ['work-2']
      ])
      const persistedWrites = attachProcess.mock.calls.length
      service.getSnapshot()
      expect(attachProcess).toHaveBeenCalledTimes(persistedWrites)
      update('1', {
        composerId: 'composer-alpha-123', state: 'unknown', detail: 'ended', observedAt: 2_700,
        isGenerating: false
      })
      expect(service.getSnapshot().conversations['1']!
        .filter((entry) => entry.role === 'assistant')
        .map((entry) => entry.processBlocks?.map((block) => block.id))).toEqual([
        ['work-1'], ['work-2']
      ])
    } finally {
      service.dispose()
      repository.close()
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
      join(mkdtempSync(join(tmpdir(), 'qingtian-p01-')), 'channel.sqlite3')
    )
    const relay = new ChannelMessageRelay(repository)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      // Agent 取走消息进入长任务：MCP 心跳停在 1_000，此后不再调用任何工具。
      repository.touchPresence('1', { waiting: false, connectionPhase: 'processing', lastSeenAt: 1_000 }, 1_000)
      const service = new DesktopSessionService(
        new FakeBridge(),
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
