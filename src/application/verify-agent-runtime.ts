import type { AgentSession } from '../domain/agent-session'
import type { CursorTelemetrySnapshot } from '../domain/cursor-telemetry'
import type { RuntimeBinding, TeamControlState } from '../domain/team-control'
import type { DesktopSnapshot } from '../shared/desktop-api'

export type TeamRuntimeContext = Pick<
  TeamControlState,
  'activeWorkspaceId' | 'runs' | 'bindings'
>

function activeRun(team: TeamRuntimeContext): TeamRuntimeContext['runs'][number] | undefined {
  if (!team.activeWorkspaceId) return undefined
  return team.runs
    .filter((candidate) => candidate.workspaceId === team.activeWorkspaceId)
    .sort((left, right) => right.createdAt - left.createdAt)[0]
}

function activeBindings(team: TeamRuntimeContext): RuntimeBinding[] {
  const run = activeRun(team)
  if (!run) return []
  return team.bindings.filter((binding) => binding.runId === run.id)
}

function stoppedSession(
  session: AgentSession,
  detail: string,
  evidence: 'stopped' | 'suspected' = 'stopped'
): AgentSession {
  return {
    ...session,
    status: 'offline',
    online: false,
    connected: false,
    runtimeEvidence: evidence,
    waiting: false,
    connectionPhase: '',
    healthEvidence: [...session.healthEvidence, detail]
  }
}

/** 传输层是否断言了通道活性（插件确认 Cursor Agent 已连接，而非仅 MCP 进程存活）。 */
function transportAlive(session: AgentSession): boolean {
  return session.online && session.connected
}

/**
 * 证据缺失时的降级标注：保留传输层在线判定，仅追加「未验证」证据。
 * 适用于绑定注册表/遥测无法提供绑定证据、但插件层确认 Agent 仍连接的场景
 * （如绑定回执缺失、手动发起的 Agent、团队重装后旧代次 Agent 仍在通道工作）。
 */
function unverifiedSession(session: AgentSession, detail: string): AgentSession {
  return {
    ...session,
    runtimeEvidence: transportAlive(session) ? 'active' : session.runtimeEvidence,
    healthEvidence: [...session.healthEvidence, detail]
  }
}

/**
 * Verifies QingTian transport state against the exact bound Cursor Composer.
 * A live MCP process is not sufficient evidence that its Cursor Agent still
 * exists; this is the single projection used by both Team and Session views.
 *
 * 判定原则：只有正面矛盾证据（绑定会话消失、活性属于其他通道、已停止、
 * 传输断开、等待状态不一致）才能把通道改判离线；证据缺失（未绑定、遥测
 * 不可用、活性未知）在传输层活性健康时只降级为「未验证」标注——通道层
 * 活性（check_messages 心跳/处理阶段）只能由存活的 Agent 产生。
 */
export function verifyAgentRuntime(
  snapshot: DesktopSnapshot,
  team: TeamRuntimeContext,
  telemetry: CursorTelemetrySnapshot
): DesktopSnapshot {
  const run = activeRun(team)
  const bindings = activeBindings(team)
  if (!run || bindings.length === 0) return snapshot
  const requiresCursorEvidence = ['running', 'attention', 'paused', 'completed'].includes(run.status)
  const bindingByChannel = new Map(bindings.map((binding) => [binding.channelId, binding]))
  if (telemetry.availability !== 'available') {
    if (!requiresCursorEvidence) return snapshot
    return {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => {
        if (!bindingByChannel.has(session.channelId)) return session
        return transportAlive(session)
          ? unverifiedSession(session, `遥测不可用，绑定状态未验证（传输层活性正常）${telemetry.issue ? `：${telemetry.issue}` : ''}`)
          : stoppedSession(session, telemetry.issue || 'Cursor 本机遥测不可用，无法验证 Agent 在线', 'suspected')
      })
    }
  }
  const composerById = new Map(telemetry.composers.map((composer) => [composer.composerId, composer]))

  const sessions = snapshot.sessions.map((session): AgentSession => {
    const binding = bindingByChannel.get(session.channelId)
    if (!binding) return session
    if (!binding.composerId) {
      // 无 composer 绑定时通道显示完全来自传输层（插件 WS 自报）。认证失效的
      // composer 可能空转轮询维持保活——用通道级转录产出证据交叉验证：
      // 有正面停止证据（record_reply 收尾 / 转录长期沉默与轮询矛盾）才改判离线。
      const channelEvidence = telemetry.channelActivities?.[session.channelId]
      if (channelEvidence?.state === 'stopped' && transportAlive(session)) {
        return unverifiedSession(
          session,
          'Cursor 转录活性滞后，但内嵌 MCP 心跳仍新鲜，按实时通道活性保持在线'
        )
      }
      if (!requiresCursorEvidence) return session
      return transportAlive(session)
        ? unverifiedSession(session, '尚未绑定可验证的 Cursor 会话（传输层活性正常，按通道活性保持在线）')
        : stoppedSession(session, 'TeamRun 已开始，但当前通道尚未绑定可验证的 Cursor 会话', 'suspected')
    }
    const composer = composerById.get(binding.composerId)
    if (!composer) return stoppedSession(session, '已绑定的 Cursor 会话已不存在')
    const activity = composer?.activity
    if (!activity || activity.state === 'unknown') {
      if (!requiresCursorEvidence) return session
      // 长任务宽限必须以 MCP 心跳新鲜为前提（S3 遥测诚实化）：
      // 死亡 Agent（Cursor 连接错误/配额耗尽）的转录同样暂停增长，
      // 唯一能区分「长命令」与「死亡」的活证据是通道心跳仍在刷新。
      if (activity?.workInProgress) {
        if (transportAlive(session)) {
          return {
            ...session,
            status: 'running',
            online: true,
            connected: true,
            runtimeEvidence: 'active',
            waiting: false,
            healthEvidence: [...session.healthEvidence, `${activity.detail}；MCP 心跳新鲜，宽限期内保持在线（未验证）`]
          }
        }
        return stoppedSession(session, `${activity.detail}；MCP 心跳已过期，宽限不再保持在线`, 'suspected')
      }
      return transportAlive(session)
        ? unverifiedSession(session, `${activity?.detail || '缺少可验证的 Cursor Agent 活性证据'}（传输层活性正常，按通道活性保持在线）`)
        : stoppedSession(session, activity?.detail || '缺少可验证的 Cursor Agent 活性证据', 'suspected')
    }
    if (activity.channelId && activity.channelId !== session.channelId) {
      return stoppedSession(session, `Cursor 会话活性属于 CH-${activity.channelId}，当前通道拒绝复用`)
    }
    if (activity.state === 'stopped') return stoppedSession(session, activity.detail)

    if (activity.state === 'waiting') {
      if (!session.waiting) {
        // 转录动作滞后于 presence：keepalive 返回/开始处理消息的瞬间，转录里
        // 最后动作仍是 check_messages。presence 新鲜在线说明 Agent 活着，状态
        // 差异是读数时序竞态而非矛盾证据——保持在线并标注，不改判离线。
        if (transportAlive(session)) {
          return unverifiedSession(
            session,
            `${activity.detail}；通道 presence 为实时处理态，等待记录差异按转录落盘时序差处理（保持在线）`
          )
        }
        return stoppedSession(session, 'Cursor 会话等待记录与当前通道状态不一致', 'suspected')
      }
      return {
        ...session,
        status: 'waiting',
        online: true,
        connected: true,
        runtimeEvidence: 'active',
        waiting: true,
        healthEvidence: [...session.healthEvidence, activity.detail]
      }
    }
    // active：遥测已给出正面活性证据（转录增长/有效租约）。
    // 干活时插件传输租约陈旧断开属正常，正面生存证据优先——否则「一干活就离线」；
    // 死亡判定由 activity 的 stopped / unknown（宽限耗尽）分支承担
    const transport = session.online && session.connected
    return {
      ...session,
      status: 'running',
      online: true,
      connected: true,
      runtimeEvidence: 'active',
      waiting: false,
      lastAgentActivityAt: activity.observedAt ?? session.lastAgentActivityAt,
      healthEvidence: [...session.healthEvidence, transport ? activity.detail : `${activity.detail}（通道租约陈旧，按会话活性证据保持在线）`]
    }
  })

  return { ...snapshot, sessions }
}
