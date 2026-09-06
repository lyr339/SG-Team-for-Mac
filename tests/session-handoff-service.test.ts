import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionHandoffService } from '../src/application/session-handoff-service'
import { RevealPathPolicy } from '../src/application/reveal-path-policy'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import { emptyTeamControlSnapshot, type TeamControlSnapshot } from '../src/domain/team-control'
import { CursorComposerTelemetryReader, cursorProjectDirectoryNames } from '../src/infrastructure/cursor/cursor-composer-telemetry'
import type { DesktopSnapshot, SendMessageInput } from '../src/shared/desktop-api'

const COMPOSER = '85bb41c4-4815-483a-a7c3-2815aab7f223'

function session(channelId: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: `sg-channel:${channelId}`,
    channelId,
    generation: 0,
    displayName: `独立席 ${channelId}`,
    roleName: '独立席',
    roleTemplateKey: 'solo',
    status: 'waiting',
    currentTask: '',
    queueDepth: 0,
    connectionPhase: 'waiting',
    online: true,
    connected: true,
    waiting: true,
    workingFiles: [],
    healthEvidence: [],
    ...overrides
  }
}

function team(sessionToken?: string): TeamControlSnapshot {
  const run = {
    id: 'session-run:ws:run-1', workspaceId: 'ws', name: '测试 · 独立会话', goal: '', templateId: 'independent-session-v1',
    status: 'running' as const, createdAt: 1, updatedAt: 1
  }
  return {
    ...emptyTeamControlSnapshot(),
    activeWorkspaceId: 'ws',
    workspaces: [{ id: 'ws', name: '20260904测试', path: '/Users/lyr/Downloads/20260904测试', createdAt: 1, updatedAt: 1 }],
    runs: [run],
    activeRun: run,
    bindings: [{
      id: 'b1', workspaceId: 'ws', runId: run.id, slotId: 's1', channelId: '1', agentSessionId: 'a1', generation: 'g1',
      installedAt: 1, launchStatus: 'delivered', launchDetail: '', lastCheckInNote: '', composerBindingKey: 'g1',
      composerId: COMPOSER, sessionToken
    }]
  }
}

function harness(options: { sessionToken?: string; transcriptExists?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sg-handoff-'))
  const projectsRoot = join(root, 'projects')
  const transcriptDir = join(projectsRoot, 'Users-lyr-Downloads-20260904', 'agent-transcripts', COMPOSER)
  if (options.transcriptExists !== false) {
    mkdirSync(transcriptDir, { recursive: true })
    writeFileSync(join(transcriptDir, `${COMPOSER}.jsonl`), '{"role":"user"}\n{"role":"assistant"}\n\n', 'utf8')
  }
  const reader = new CursorComposerTelemetryReader({ projectsRoot })
  const sent: SendMessageInput[] = []
  const entries: ConversationEntry[] = [
    { id: 'outbox:1', channelId: '1', role: 'user', source: 'desktop', status: 'complete', timestamp: 1_000, deliveredAt: 1_100, text: '你好' },
    { id: 'reply:1', channelId: '1', role: 'assistant', source: 'cursor', status: 'complete', timestamp: 2_000, text: '你好！我是 Claude。' }
  ]
  const desktop: DesktopSnapshot = {
    connection: { state: 'connected', endpoint: 'shiguang://local-channel-runtime', attempt: 0, lastError: '' },
    sessions: [session('1', { composerId: COMPOSER, modelName: 'Claude Opus' }), session('2', { waiting: false, status: 'running' })],
    conversations: { '1': entries },
    protocolIssues: [],
    updatedAt: 1
  }
  const teamSnapshot = team(options.sessionToken)
  const service = new SessionHandoffService({
    team: { getSnapshot: () => teamSnapshot },
    sessions: {
      getSnapshot: () => desktop,
      sendMessage: (input) => { sent.push(input); return { commandId: `cmd-${sent.length}` } },
      currentSessionToken: (channelId) => teamSnapshot.bindings.find((binding) => binding.channelId === channelId)?.sessionToken
    },
    locateTranscript: (composerId, workspacePath) => reader.locateTranscript(composerId, workspacePath),
    conversationsOf: (channelId) => desktop.conversations[channelId],
    handoffRoot: join(root, 'handoff'),
    now: () => new Date(2026, 8, 4, 20, 5).getTime()
  })
  return { service, sent, root, projectsRoot, transcriptDir }
}

describe('cursorProjectDirectoryNames', () => {
  it('derives the ASCII-stripped directory Cursor actually uses for non-ASCII workspace names first', () => {
    expect(cursorProjectDirectoryNames('/Users/lyr/Downloads/20260904测试')[0]).toBe('Users-lyr-Downloads-20260904')
    expect(cursorProjectDirectoryNames('/Users/lyr/Downloads/sg/sg-team')[0]).toBe('Users-lyr-Downloads-sg-sg-team')
  })

  it('lower-cases the Windows drive letter the way Cursor names project directories', () => {
    const names = cursorProjectDirectoryNames('C:\\Users\\admin\\Downloads\\sg-team\\sg-team')
    expect(names[0]).toBe('c-Users-admin-Downloads-sg-team-sg-team')
    expect(names).toContain('C-Users-admin-Downloads-sg-team-sg-team')
  })
})

describe('SessionHandoffService', () => {
  it('locates the transcript by workspace directory with size, mtime and record count', () => {
    const { service, transcriptDir } = harness({ sessionToken: 'seat-A' })
    const context = service.context('1')
    expect(context).toMatchObject({
      channelId: '1', displayName: '独立席 1', composerId: COMPOSER, modelName: 'Claude Opus',
      holdSupported: true, userMessageCount: 1, assistantMessageCount: 1, firstMessageAt: 1_000, lastMessageAt: 2_000
    })
    expect(context.transcript).toMatchObject({
      path: join(transcriptDir, `${COMPOSER}.jsonl`), exists: true, recordCount: 2, resolution: 'workspace'
    })
    expect(context.transcript?.sizeBytes).toBeGreaterThan(0)
  })

  it('still reports the exact expected path when Cursor has not written the transcript yet', () => {
    const { service, transcriptDir } = harness({ sessionToken: 'seat-A', transcriptExists: false })
    const context = service.context('1')
    expect(context.transcript).toMatchObject({ path: join(transcriptDir, `${COMPOSER}.jsonl`), exists: false, resolution: 'expected' })
  })

  it('delivers to the same seat with the hold flag and writes the 拾光 record next to the message', () => {
    const { service, sent, root, projectsRoot } = harness({ sessionToken: 'seat-A' })
    const result = service.deliver({ sourceChannelId: '1', target: { kind: 'self' }, note: '接着做队列弹层' })
    expect(result).toMatchObject({ targetChannelId: '1', held: true, commandId: 'cmd-1' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ channelId: '1', holdUntilNewSession: true })
    expect(sent[0]?.text).toContain('【会话交接】CH-1（独立席 1 · Claude Opus） 上一段会话的上下文')
    expect(sent[0]?.text).toContain(result.transcriptPath)
    expect(sent[0]?.text).toContain('交接说明：接着做队列弹层')
    expect(result.recordPath).toBe(join(root, 'handoff', 'CH-1-85bb41c4-20260904-200500.md'))
    expect(existsSync(result.recordPath!)).toBe(true)
    const record = readFileSync(result.recordPath!, 'utf8')
    expect(record).toContain('# 拾光会话记录 · CH-1 独立席 1')
    expect(record).toContain('你好！我是 Claude。')
    expect(record).toContain(`- Cursor 转录：${result.transcriptPath}`)
    // 「在 Finder 中显示」白名单：交接记录目录与转录目录内允许，其余拒绝
    const policy = new RevealPathPolicy([join(root, 'handoff'), projectsRoot])
    expect(policy.allows(result.recordPath!)).toBe(true)
    expect(policy.allows(result.transcriptPath)).toBe(true)
    expect(policy.allows('/etc/passwd')).toBe(false)
    expect(policy.allows(`${join(root, 'handoff')}-evil/x.md`)).toBe(false)
  })

  it('delivers to another session as a plain queued message and refuses self via the channel form', () => {
    const { service, sent } = harness({ sessionToken: 'seat-A' })
    const result = service.deliver({ sourceChannelId: '1', target: { kind: 'channel', channelId: '2' } })
    expect(result).toMatchObject({ targetChannelId: '2', held: false })
    expect(sent[0]).toMatchObject({ channelId: '2' })
    expect(sent[0]?.holdUntilNewSession).toBeUndefined()
    expect(sent[0]?.text).toContain('来自 CH-1（独立席 1 · Claude Opus）')
    expect(() => service.deliver({ sourceChannelId: '1', target: { kind: 'channel', channelId: '1' } })).toThrowError(/本会话/)
    expect(() => service.deliver({ sourceChannelId: '1', target: { kind: 'channel', channelId: '9' } })).toThrowError(/不在当前运行/)
  })

  it('falls back to a plain queue for self when the seat has no session token (legacy session)', () => {
    const { service, sent } = harness({})
    expect(service.context('1').holdSupported).toBe(false)
    const result = service.deliver({ sourceChannelId: '1', target: { kind: 'self' } })
    expect(result.held).toBe(false)
    expect(sent[0]?.holdUntilNewSession).toBeUndefined()
  })

  it('refuses to hand off a channel without a bound composer', () => {
    const { service } = harness({ sessionToken: 'seat-A' })
    expect(() => service.deliver({ sourceChannelId: '2', target: { kind: 'self' } })).toThrowError(/尚未绑定 Cursor Composer/)
  })
})
