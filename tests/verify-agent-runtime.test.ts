import { describe, expect, it } from 'vitest'
import { verifyAgentRuntime } from '../src/application/verify-agent-runtime'
import type { CursorTelemetrySnapshot } from '../src/domain/cursor-telemetry'
import type { TeamControlState } from '../src/domain/team-control'
import type { DesktopSnapshot } from '../src/shared/desktop-api'

function bridgeSnapshot(): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: 'qunshu://local-channel-runtime', attempt: 0, lastError: '' },
    sessions: [{
      id: 'qingtian-channel:1',
      channelId: '1',
      generation: 0,
      displayName: 'CH-1',
      roleName: '主控',
      status: 'waiting',
      currentTask: '',
      queueDepth: 0,
      connectionPhase: 'waiting',
      online: true,
      connected: true,
      waiting: true,
      workingFiles: [],
      healthEvidence: ['MCP 运行时心跳正常']
    }],
    conversations: {},
    protocolIssues: [],
    updatedAt: 100
  }
}

function team(status: TeamControlState['runs'][number]['status'] = 'ready'): TeamControlState {
  return {
    schemaVersion: 5,
    revision: 1,
    activeWorkspaceId: 'workspace-a',
    workspaces: [{
      id: 'workspace-a',
      name: 'alpha',
      path: '/workspace/alpha',
      createdAt: 1,
      updatedAt: 1
    }],
    runs: [{
      id: 'run-a',
      workspaceId: 'workspace-a',
      name: 'main',
      goal: 'test',
      templateId: 'default',
      status,
      createdAt: 1,
      updatedAt: 1
    }],
    roles: [],
    slots: [],
    bindings: [{
      id: 'binding-1',
      workspaceId: 'workspace-a',
      runId: 'run-a',
      slotId: 'slot-1',
      channelId: '1',
      agentSessionId: 'agent-1',
      generation: 'generation-a',
      composerBindingKey: 'generation-a',
      installedAt: 1,
      launchStatus: 'acknowledged',
      launchDetail: '',
      lastCheckInNote: '',
      composerId: 'composer-alpha-123'
    }],
    updatedAt: 1
  }
}

function telemetry(state: 'waiting' | 'stopped' | 'unknown', channelId = '1'): CursorTelemetrySnapshot {
  return {
    availability: 'available',
    workspacePath: '/workspace/alpha',
    composers: [{
      composerId: 'composer-alpha-123',
      title: 'alpha',
      activity: {
        state,
        channelId,
        detail: state === 'stopped' ? 'Agent 已停止监听' : 'verified'
      }
    }],
    bindingCandidates: [],
    updatedAt: 100
  }
}

describe('verified Agent runtime projection', () => {
  it('overrides a stale QingTian waiting flag when the bound Cursor Agent has stopped', () => {
    const snapshot = verifyAgentRuntime(bridgeSnapshot(), team(), telemetry('stopped'))

    expect(snapshot.sessions[0]).toMatchObject({
      status: 'offline',
      online: false,
      connected: false,
      waiting: false
    })
    expect(snapshot.sessions[0]?.healthEvidence).toContain('Agent 已停止监听')
  })

  it('keeps online only when the verified waiting activity belongs to the same channel', () => {
    const snapshot = verifyAgentRuntime(bridgeSnapshot(), team(), telemetry('waiting'))

    expect(snapshot.sessions[0]).toMatchObject({
      status: 'waiting',
      online: true,
      connected: true,
      waiting: true
    })
  })

  it('keeps a live-transport session online when the stale transcript waiting record lags behind presence', () => {
    // Agent 已取走消息开始处理（presence=processing），但转录最后动作仍是
    // check_messages（落盘滞后）——等待记录差异是读数时序竞态，不得改判离线
    const snapshot = bridgeSnapshot()
    snapshot.sessions[0] = {
      ...snapshot.sessions[0]!,
      status: 'running',
      waiting: false,
      connectionPhase: 'processing'
    }
    const result = verifyAgentRuntime(snapshot, team(), telemetry('waiting'))

    expect(result.sessions[0]).toMatchObject({ online: true, connected: true, waiting: false })
    expect(result.sessions[0]?.status).not.toBe('offline')
    expect(result.sessions[0]?.healthEvidence.join(' ')).toContain('时序差')
  })

  it('still stops the session when the waiting mismatch coincides with a dead transport', () => {
    const snapshot = bridgeSnapshot()
    snapshot.sessions[0] = {
      ...snapshot.sessions[0]!,
      online: false,
      connected: false,
      waiting: false,
      connectionPhase: ''
    }
    const result = verifyAgentRuntime(snapshot, team(), telemetry('waiting'))

    expect(result.sessions[0]).toMatchObject({ status: 'offline', online: false })
  })

  it('rejects activity from a different channel instead of reusing it', () => {
    const snapshot = verifyAgentRuntime(bridgeSnapshot(), team(), telemetry('waiting', '2'))

    expect(snapshot.sessions[0]).toMatchObject({ status: 'offline', online: false })
  })
})

describe('证据缺失不再一票否决传输层活性（实机回归：Agent 在岗却被误判离线）', () => {
  function teamWithoutComposer(status: TeamControlState['runs'][number]['status'] = 'completed'): TeamControlState {
    const state = team(status)
    state.bindings = state.bindings.map((binding) => ({ ...binding, composerId: undefined }))
    return state
  }

  function offlineBridgeSnapshot(): DesktopSnapshot {
    const snapshot = bridgeSnapshot()
    snapshot.sessions = snapshot.sessions.map((session) => ({
      ...session,
      status: 'offline',
      online: false,
      connected: false,
      waiting: false,
      connectionPhase: ''
    }))
    return snapshot
  }

  it('未绑定 composerId 但通道活性健康 → 保持在线并标注未验证', () => {
    const snapshot = verifyAgentRuntime(bridgeSnapshot(), teamWithoutComposer(), telemetry('waiting'))

    expect(snapshot.sessions[0]).toMatchObject({
      status: 'waiting',
      online: true,
      connected: true,
      waiting: true
    })
    expect(snapshot.sessions[0]?.healthEvidence.join('\n')).toContain('按通道活性保持在线')
  })

  it('未绑定 composerId 且传输断开 → 维持离线判词', () => {
    const snapshot = verifyAgentRuntime(offlineBridgeSnapshot(), teamWithoutComposer('running'), telemetry('waiting'))

    expect(snapshot.sessions[0]).toMatchObject({ status: 'offline', online: false })
    expect(snapshot.sessions[0]?.healthEvidence).toContain('TeamRun 已开始，但当前通道尚未绑定可验证的 Cursor 会话')
  })

  it('遥测不可用但通道活性健康 → 保持在线并标注未验证', () => {
    const unavailable: CursorTelemetrySnapshot = {
      ...telemetry('waiting'),
      availability: 'unavailable',
      issue: 'Cursor 状态库读取失败'
    }
    const snapshot = verifyAgentRuntime(bridgeSnapshot(), team('running'), unavailable)

    expect(snapshot.sessions[0]).toMatchObject({ online: true, connected: true, waiting: true })
    expect(snapshot.sessions[0]?.healthEvidence.join('\n')).toContain('绑定状态未验证')
  })

  it('活性未知但通道活性健康 → 保持在线并标注未验证', () => {
    const snapshot = verifyAgentRuntime(bridgeSnapshot(), team('running'), telemetry('unknown'))

    expect(snapshot.sessions[0]).toMatchObject({ online: true, connected: true, waiting: true })
    expect(snapshot.sessions[0]?.healthEvidence.join('\n')).toContain('按通道活性保持在线')
  })

  it('活性未知且传输断开 → 维持离线判词', () => {
    const unknownTelemetry = telemetry('unknown')
    unknownTelemetry.composers = unknownTelemetry.composers.map((composer) => ({
      ...composer,
      activity: composer.activity ? { ...composer.activity, detail: '' } : composer.activity
    }))
    const snapshot = verifyAgentRuntime(offlineBridgeSnapshot(), team('running'), unknownTelemetry)

    expect(snapshot.sessions[0]).toMatchObject({ status: 'offline', online: false })
    expect(snapshot.sessions[0]?.healthEvidence).toContain('缺少可验证的 Cursor Agent 活性证据')
  })

  it('干活中（遥测 active）即使插件传输租约陈旧断开 → 保持在线（实机回归：一干活就离线）', () => {
    const activeTelemetry: CursorTelemetrySnapshot = {
      availability: 'available',
      composers: [{
        composerId: 'composer-alpha-123',
        title: '会话',
        activity: { state: 'active', detail: '长轮询已结束，Agent 正在处理（转录活动新鲜）' }
      }],
      bindingCandidates: [],
      updatedAt: 100
    }
    const snapshot = verifyAgentRuntime(offlineBridgeSnapshot(), team(), activeTelemetry)

    expect(snapshot.sessions[0]).toMatchObject({ online: true, connected: true, waiting: false, status: 'running' })
    expect(snapshot.sessions[0]?.healthEvidence.join('\n')).toContain('通道租约陈旧')
  })

  it('长任务宽限内（workInProgress）且 MCP 心跳新鲜 → 保持在线（活性未验证）', () => {
    const graceTelemetry: CursorTelemetrySnapshot = {
      availability: 'available',
      composers: [{
        composerId: 'composer-alpha-123',
        title: '会话',
        activity: { state: 'unknown', workInProgress: true, detail: 'Agent 疑似在执行长任务（转录暂停增长），无死亡证据' }
      }],
      bindingCandidates: [],
      updatedAt: 100
    }
    const snapshot = verifyAgentRuntime(bridgeSnapshot(), team('running'), graceTelemetry)

    expect(snapshot.sessions[0]).toMatchObject({ online: true, connected: true, status: 'running' })
    expect(snapshot.sessions[0]?.healthEvidence.join('\n')).toContain('宽限期内保持在线')
  })

  it('长任务宽限但 MCP 心跳已过期 → 诚实离线（消除假在线）', () => {
    const graceTelemetry: CursorTelemetrySnapshot = {
      availability: 'available',
      composers: [{
        composerId: 'composer-alpha-123',
        title: '会话',
        activity: { state: 'unknown', workInProgress: true, detail: 'Agent 疑似在执行长任务（转录暂停增长），无死亡证据' }
      }],
      bindingCandidates: [],
      updatedAt: 100
    }
    const snapshot = verifyAgentRuntime(offlineBridgeSnapshot(), team('running'), graceTelemetry)

    expect(snapshot.sessions[0]).toMatchObject({ online: false, connected: false, status: 'offline' })
    expect(snapshot.sessions[0]?.healthEvidence.join('\n')).toContain('MCP 心跳已过期')
  })
})

describe('unbound channel zombie detection via channel-level transcript evidence', () => {
  function teamWithoutComposer(status: TeamControlState['runs'][number]['status']): TeamControlState {
    const base = team(status)
    return {
      ...base,
      bindings: base.bindings.map(({ composerId: _composerId, ...rest }) => rest)
    }
  }

  function telemetryWithChannelActivities(
    channelActivities: CursorTelemetrySnapshot['channelActivities']
  ): CursorTelemetrySnapshot {
    return {
      availability: 'available',
      workspacePath: '/workspace/alpha',
      composers: [],
      bindingCandidates: [],
      channelActivities,
      updatedAt: 100
    }
  }

  it('keeps an unbound channel online when fresh MCP heartbeat contradicts stale transcript-stop evidence', () => {
    const snapshot = verifyAgentRuntime(
      bridgeSnapshot(),
      teamWithoutComposer('completed'),
      telemetryWithChannelActivities({
        '1': { channelId: '1', state: 'stopped', detail: '通道会话已同步最后回复并停止监听（转录不再增长）' }
      })
    )
    expect(snapshot.sessions[0]).toMatchObject({ status: 'waiting', online: true, connected: true })
    expect(snapshot.sessions[0]?.healthEvidence.join('\n')).toContain('按实时通道活性保持在线')
  })

  it('does not mark an active unbound channel offline while MCP heartbeat is fresh', () => {
    const snapshot = verifyAgentRuntime(
      bridgeSnapshot(),
      teamWithoutComposer('running'),
      telemetryWithChannelActivities({
        '1': { channelId: '1', state: 'stopped', detail: '通道转录长时间无产出，与传输层轮询保活矛盾（疑似认证失效的僵尸会话）' }
      })
    )
    expect(snapshot.sessions[0]).toMatchObject({ status: 'waiting', online: true, connected: true })
    expect(snapshot.sessions[0]?.healthEvidence.join('\n')).toContain('按实时通道活性保持在线')
  })

  it('marks an unbound channel offline when stopped transcript evidence coincides with stale transport', () => {
    const offline = bridgeSnapshot()
    offline.sessions[0] = {
      ...offline.sessions[0]!,
      status: 'offline',
      online: false,
      connected: false,
      waiting: false
    }
    const snapshot = verifyAgentRuntime(
      offline,
      teamWithoutComposer('running'),
      telemetryWithChannelActivities({
        '1': { channelId: '1', state: 'stopped', detail: '通道转录长时间无产出，与传输层轮询保活矛盾（疑似认证失效的僵尸会话）' }
      })
    )
    expect(snapshot.sessions[0]).toMatchObject({ status: 'offline', online: false })
    expect(snapshot.sessions[0]?.healthEvidence.join('\n')).toContain('尚未绑定可验证的 Cursor 会话')
  })

  it('keeps an unbound channel online while transcript evidence shows fresh activity', () => {
    const snapshot = verifyAgentRuntime(
      bridgeSnapshot(),
      teamWithoutComposer('completed'),
      telemetryWithChannelActivities({
        '1': { channelId: '1', state: 'active', detail: '通道会话转录仍在增长' }
      })
    )
    expect(snapshot.sessions[0]).toMatchObject({ status: 'waiting', online: true, connected: true })
  })

  it('keeps the previous degraded-online behavior when channel evidence is missing or inconclusive', () => {
    for (const channelActivities of [
      undefined,
      { '1': { channelId: '1', state: 'unknown', detail: '通道会话产出暂停，未达僵尸判定上限' } }
    ] as CursorTelemetrySnapshot['channelActivities'][]) {
      const running = verifyAgentRuntime(
        bridgeSnapshot(),
        teamWithoutComposer('running'),
        telemetryWithChannelActivities(channelActivities)
      )
      expect(running.sessions[0]).toMatchObject({ online: true, connected: true })
      expect(running.sessions[0]?.healthEvidence.join('\n')).toContain('传输层活性正常')

      const completed = verifyAgentRuntime(
        bridgeSnapshot(),
        teamWithoutComposer('completed'),
        telemetryWithChannelActivities(channelActivities)
      )
      expect(completed.sessions[0]).toMatchObject({ status: 'waiting', online: true })
    }
  })
})
