import { describe, expect, it } from 'vitest'
import { shareSnapshotStructure } from '../src/renderer/src/snapshot-sharing'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry } from '../src/domain/conversation-entry'

function sessionOf(id: string, task: string): AgentSession {
  return {
    id,
    channelId: id,
    displayName: `Agent ${id}`,
    roleName: '角色',
    status: 'waiting',
    currentTask: task,
    queueDepth: 0,
    connectionPhase: 'waiting',
    online: true,
    connected: true,
    waiting: true,
    telemetry: { state: 'bound', detail: '', source: 'cursor-local' }
  } as AgentSession
}

function entryOf(id: string, text: string): ConversationEntry {
  return { id, channelId: '1', role: 'assistant', text, timestamp: 1, status: 'complete', source: 'cursor' } as ConversationEntry
}

function snapshotOf(overrides: Partial<DesktopSnapshot>): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: '', attempt: 0, lastError: '' },
    sessions: [],
    conversations: {},
    protocolIssues: [],
    updatedAt: 1,
    ...overrides
  } as DesktopSnapshot
}

describe('shareSnapshotStructure', () => {
  it('内容未变的会话复用旧引用，变化的才换新', () => {
    const previous = snapshotOf({ sessions: [sessionOf('1', '旧任务'), sessionOf('2', '不变')] })
    const incoming = snapshotOf({ sessions: [sessionOf('1', '新任务'), sessionOf('2', '不变')], updatedAt: 2 })
    const merged = shareSnapshotStructure(previous, incoming)
    expect(merged.sessions[0]).not.toBe(previous.sessions[0])
    expect(merged.sessions[1]).toBe(previous.sessions[1])
  })

  it('同引用的通道消息数组原样保留，不同引用才替换', () => {
    const shared = [entryOf('e1', '你好')]
    const previous = snapshotOf({ conversations: { '1': shared, '2': [entryOf('e2', '旧')] } })
    const incoming = snapshotOf({ conversations: { '1': shared, '2': [entryOf('e2', '旧')] }, updatedAt: 2 })
    const merged = shareSnapshotStructure(previous, incoming)
    expect(merged.conversations['1']).toBe(shared)
  })

  it('实时回答状态按通道保持结构共享', () => {
    const live = {
      id: 'bubble-1', channelId: '1', text: '正在生成', status: 'streaming' as const,
      startedAt: 10, updatedAt: 20
    }
    const previous = snapshotOf({ liveAgentResponses: { '1': live } })
    const incoming = snapshotOf({ liveAgentResponses: { '1': live }, updatedAt: 2 })
    expect(shareSnapshotStructure(previous, incoming).liveAgentResponses?.['1']).toBe(live)
  })

  it('初始快照（updatedAt=0）与同一对象直接放行', () => {
    const initial = snapshotOf({ updatedAt: 0 })
    const incoming = snapshotOf({ sessions: [sessionOf('1', '任务')], updatedAt: 1 })
    expect(shareSnapshotStructure(initial, incoming)).toBe(incoming)
    expect(shareSnapshotStructure(incoming, incoming)).toBe(incoming)
  })
})
