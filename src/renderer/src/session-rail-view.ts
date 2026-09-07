import type { AgentSession } from '../../domain/agent-session'
import { isAgentOnDuty, isProcessingPhase } from '../../domain/channel-message'
import { contextPercent, statusLabel } from './format'

/**
 * 会话侧栏（名册）的视图折叠：分组、状态色调、标题拆分与头部摘要都在这里决定，
 * 行组件与侧栏只负责摆放。分组即色调——同一个函数同时决定「排在哪一组」与
 * 「状态点是什么颜色」，两者永远一致。
 */
export type SessionRailGroupId = 'active' | 'attention' | 'waiting' | 'offline'

export const SESSION_RAIL_GROUPS: ReadonlyArray<{ id: SessionRailGroupId; label: string; detail: string }> = [
  { id: 'active', label: '执行中', detail: '正在启动、恢复或处理任务' },
  { id: 'attention', label: '需关注', detail: '等待拍板、验收或重新进入待命' },
  { id: 'waiting', label: '待命', detail: '已在线并持续等待新消息' },
  { id: 'offline', label: '离线', detail: '当前没有可信的 Cursor 运行时活性' }
]

type RailSessionFacts = Pick<AgentSession, 'online' | 'status' | 'runtimeEvidence' | 'waiting' | 'connectionPhase'>

/** 分类只投影现有运行事实，不改变 Agent 状态；离线证据始终拥有最高优先级。 */
export function sessionRailGroupOf(session: RailSessionFacts): SessionRailGroupId {
  if (!session.online || session.status === 'offline' || session.status === 'stopped' || session.runtimeEvidence === 'stopped') return 'offline'
  if (session.status === 'blocked' || session.status === 'review') return 'attention'
  if (session.status === 'running' || session.status === 'starting' || session.status === 'reviving'
    || isProcessingPhase(session.connectionPhase ?? '')) return 'active'
  if (session.status === 'waiting' || isAgentOnDuty(session)) return 'waiting'
  return 'attention'
}

/** 行内状态词：离线统一说「已离线」，其余沿用全应用的状态文案。 */
export function sessionRailStateLabel(session: RailSessionFacts): string {
  return sessionRailGroupOf(session) === 'offline' ? '已离线' : statusLabel(session.status)
}

/**
 * 把 displayName 拆成「角色名 + 通道号」两段：App 组装的显示名形如「架构实现 · CH-2」，
 * 未绑定席位的通道只有「SG Team CH-4」。通道号单独用等宽数字排，角色名可截断。
 */
export function sessionRailTitle(session: Pick<AgentSession, 'displayName' | 'channelId'>): { name: string; channel: string } {
  const channel = `CH-${session.channelId}`
  const name = session.displayName
    .replace(/\s*·\s*CH-\d+\s*$/u, '')
    .replace(/^SG Team\s+CH-\d+$/u, 'SG Team')
    .trim()
  return { name: name || 'SG Team', channel }
}

/** 头部摘要：各状态组的数量 + 排队总数，代替旧版的三段筛选器。 */
export function sessionRailSummary(sessions: ReadonlyArray<RailSessionFacts & Pick<AgentSession, 'queueDepth'>>): string {
  if (!sessions.length) return ''
  const counts = new Map<SessionRailGroupId, number>()
  let queued = 0
  for (const session of sessions) {
    const group = sessionRailGroupOf(session)
    counts.set(group, (counts.get(group) ?? 0) + 1)
    queued += Math.max(0, session.queueDepth ?? 0)
  }
  const parts = SESSION_RAIL_GROUPS
    .filter((group) => (counts.get(group.id) ?? 0) > 0)
    .map((group) => `${counts.get(group.id)} ${group.label}`)
  if (queued > 0) parts.push(`排队 ${queued}`)
  return parts.join(' · ')
}

/**
 * 上下文光环：环绕头像的一圈弧，弧长 = 上下文占用比例。SVG 圆用 pathLength=100
 * 归一化，dasharray 直接写百分比；空值（遥测未到）不画弧，只留轨道。
 */
export function contextRingDash(percent: number | undefined): string | undefined {
  if (percent === undefined || !Number.isFinite(percent)) return undefined
  const clamped = Math.min(100, Math.max(0, percent))
  // 极小的占用仍给一段可见弧，避免 0.3% 被圆头端点吞掉后看起来像「没有数据」。
  const visible = clamped > 0 && clamped < 1.5 ? 1.5 : clamped
  return `${Math.round(visible * 10) / 10} 100`
}

export function sessionRailContextPercent(session: Pick<AgentSession, 'contextUsage'>): number | undefined {
  return contextPercent(session.contextUsage)
}
