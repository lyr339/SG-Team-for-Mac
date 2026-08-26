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

function bridgeSnapshot(): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: 'qunshu://local-channel-runtime', attempt: 0, lastError: '' },
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
      workEntries: [
        { kind: 'text', text: '好的，我先看一下代码结构。', line: 2, at: 40 },
        { kind: 'tool', text: 'Glob **/*.ts', toolName: 'Glob', line: 2, at: 40 }
      ]
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

}

class FakeTeam implements DesktopSessionTeamSource {
  readonly recorded: Parameters<DesktopSessionTeamSource['recordComposerBinding']>[0][] = []
  private snapshot = teamSnapshot()

  getSnapshot(): TeamControlSnapshot { return structuredClone(this.snapshot) }
  subscribe(): () => void { return () => undefined }
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
  it('adds only bound Composer metrics to the matching QingTian channel', () => {
    const snapshot = enrichDesktopSnapshot(
      bridgeSnapshot(),
      teamSnapshot('composer-alpha-123'),
      telemetry()
    )

    expect(snapshot.sessions[0]).toMatchObject({
      composerId: 'composer-alpha-123',
      composerTitle: '主控会话',
      startedAt: 20,
      contextUsage: { ratio: 0.63 },
      changes: { additions: 12, deletions: 4, files: 3 },
      workEntries: [
        { kind: 'text', text: '好的，我先看一下代码结构。', line: 2, at: 40 },
        { kind: 'tool', text: 'Glob **/*.ts', toolName: 'Glob', line: 2, at: 40 }
      ],
      executionProfile: {
        scope: 'cursor-composer-current',
        modelId: 'composer-2.5',
        displayName: 'Composer 2.5',
        options: ['Fast']
      },
      telemetry: { state: 'bound', source: 'cursor-local', bindingMethod: 'launch_marker' }
    })
    expect(snapshot.sessions[0]?.modelName).toBeUndefined()
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
