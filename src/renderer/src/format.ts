import type { AgentExecutionProfile, AgentSession, ContextUsage } from '../../domain/agent-session'
export { formatFileSize } from '../../shared/format-file-size'

/** 统一的时钟格式（HH:mm），全应用时间戳短格式唯一出口。 */
export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return '暂无活动证据'
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000))
  if (seconds < 10) return '刚刚活动'
  if (seconds < 60) return `${seconds} 秒前活动`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前活动`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时前活动`
}

export function formatTokenCount(tokens: number): string {
  const value = Math.max(0, Math.round(tokens))
  const compact = (amount: number): string => amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0+$/, '')
  if (value < 1_000) return value.toLocaleString()
  if (value < 1_000_000) return `${compact(value / 1_000)}K`
  if (value < 1_000_000_000) return `${compact(value / 1_000_000)}M`
  return `${compact(value / 1_000_000_000)}B`
}

export function formatSessionDuration(
  startedAt?: number,
  endedAt = Date.now(),
  prefix = '持续'
): string {
  if (!startedAt) return '时长待绑定'
  return formatDurationMilliseconds(Math.max(0, endedAt - startedAt), prefix)
}

export function formatDurationMilliseconds(durationMs: number, prefix = '运行'): string {
  const minutes = Math.max(0, Math.floor(durationMs / 60_000))
  const lead = prefix ? `${prefix} ` : ''
  if (minutes < 1) return `${lead}不到 1 分钟`
  if (minutes < 60) return `${lead}${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) return `${lead}${hours} 小时${remainingMinutes ? ` ${remainingMinutes} 分` : ''}`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return `${lead}${days} 天${remainingHours ? ` ${remainingHours} 小时` : ''}`
}

export function formatAgentSessionDuration(
  session: Pick<AgentSession, 'startedAt' | 'disconnectedAt' | 'activeDurationMs' | 'online'>,
  now = Date.now()
): string {
  if (session.activeDurationMs !== undefined) {
    const label = formatDurationMilliseconds(session.activeDurationMs, '')
    return session.online ? label : `${label} · 截止`
  }
  if (session.online) return formatSessionDuration(session.startedAt, now, '')
  if (!session.startedAt || !session.disconnectedAt) return '离线'
  return `${formatSessionDuration(session.startedAt, session.disconnectedAt, '')} · 截止`
}

/**
 * 上下文压力的“天色”三档：晴（青绿）→ 午后（琥珀）→ 日暮（红）。
 * 清晰、预警、危险三档上下文压力语义，避免通用渐变掩盖真实状态。
 */
export type ContextTone = 'clear' | 'afternoon' | 'dusk'

export function contextTone(percent?: number): ContextTone | undefined {
  if (percent === undefined) return undefined
  if (percent >= 85) return 'dusk'
  if (percent >= 60) return 'afternoon'
  return 'clear'
}

export function modelDisplayName(
  profile?: AgentExecutionProfile,
  sessionModelName?: string
): string {
  return sessionModelName || profile?.displayName || '配置待读取'
}

/** 模型徽章（Max / Think / 1M 一类），来自 Cursor 运行配置；有会话模型名时同样展示。 */
export function executionBadges(profile?: AgentExecutionProfile): string[] {
  if (!profile) return []
  return [...profile.options].sort((left, right) => badgeRank(left) - badgeRank(right))
}

/** 徽章色系：思考/强度→紫、上下文规格→蓝、其余→绿。 */
export type BadgeTone = 'max' | 'think' | 'context' | 'effort' | 'fast' | 'plain'

export function badgeTone(label: string): BadgeTone {
  const normalized = label.trim().toLowerCase()
  if (normalized === 'max mode') return 'max'
  if (normalized.includes('think')) return 'think'
  if (/^\d+(\.\d+)?\s*[km]$/.test(normalized) || label.includes('上下文')) return 'context'
  if (['low', 'medium', 'high', 'extra high', 'max'].includes(normalized)) return 'effort'
  if (normalized === 'fast') return 'fast'
  return 'plain'
}

/** 徽章固定顺序：Thinking → Context → Effort → Fast/其余。 */
function badgeRank(label: string): number {
  const normalized = label.trim().toLowerCase()
  if (normalized.includes('think')) return 0
  const tone = badgeTone(label)
  if (tone === 'context') return 1
  if (['low', 'medium', 'high', 'extra high', 'max'].includes(normalized)) return 2
  return normalized === 'fast' ? 3 : 4
}

function formatContextTokenCount(value: number): string {
  return formatTokenCount(value)
}

export function contextPercent(usage?: ContextUsage): number | undefined {
  if (!usage || !Number.isFinite(usage.ratio)) return undefined
  return Math.min(100, Math.max(0, usage.ratio * 100))
}

export function formatContextUsage(usage?: ContextUsage): string {
  const percent = contextPercent(usage)
  if (percent === undefined) return '等待 Cursor 遥测'
  const percentLabel = `${percent.toFixed(1).replace(/\.0$/, '')}%`
  if (usage?.used === undefined || usage.limit === undefined) return percentLabel
  return `${formatContextTokenCount(usage.used)} / ${formatContextTokenCount(usage.limit)} · ${percentLabel}`
}

export function formatExecutionProfile(
  profile?: AgentExecutionProfile,
  sessionModelName?: string
): string {
  if (!profile) return sessionModelName ?? '运行配置待读取'
  const name = sessionModelName || profile.displayName
  return [name, ...executionBadges(profile)].join(' · ')
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    starting: '启动中',
    idle: '未待命',
    running: '运行中',
    waiting: '待命中',
    review: '待验收',
    blocked: '等待拍板',
    reviving: '恢复中',
    offline: '离线',
    stopped: '已停止'
  }
  return labels[status] ?? status
}
