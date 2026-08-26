import type { AgentExecutionProfile, AgentSession, ContextUsage } from '../../domain/agent-session'
export { formatFileSize } from '../../shared/format-file-size'

/** 统一的时钟格式（HH:mm），全应用时间戳短格式唯一出口。 */
export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** 统一的完整日期时间格式，全应用长格式唯一出口。 */
export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
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

/** 紧凑相对时间（会话卡片指标行等窄空间）：刚刚 / N 秒前 / N 分钟前 / N 小时前 / N 天前。 */
export function formatRelativeTimeCompact(timestamp?: number): string | undefined {
  if (!timestamp) return undefined
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000))
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
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
  if (minutes < 1) return `${prefix}不到 1 分钟`
  if (minutes < 60) return `${prefix} ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) return `${prefix} ${hours} 小时${remainingMinutes ? ` ${remainingMinutes} 分` : ''}`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return `${prefix} ${days} 天${remainingHours ? ` ${remainingHours} 小时` : ''}`
}

export function formatAgentSessionDuration(
  session: Pick<AgentSession, 'startedAt' | 'disconnectedAt' | 'activeDurationMs' | 'online'>,
  now = Date.now()
): string {
  if (session.activeDurationMs !== undefined) {
    const label = formatDurationMilliseconds(session.activeDurationMs)
    return session.online ? label : `${label} · 已截止`
  }
  if (session.online) return formatSessionDuration(session.startedAt, now, '运行')
  if (!session.startedAt || !session.disconnectedAt) return '已离线'
  return `${formatSessionDuration(session.startedAt, session.disconnectedAt, '运行')} · 已截止`
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

/** 模型徽章（MAX / 思考 / 1M 一类），来自 Cursor 运行配置。 */
export function executionBadges(
  profile?: AgentExecutionProfile,
  sessionModelName?: string
): string[] {
  if (sessionModelName || !profile) return []
  const badges = [...profile.options]
  if (profile.maxMode && !badges.includes('Max')) badges.push('Max')
  return badges
}

/** 徽章色系：Max→橙、思考→紫、上下文规格（1M/200K）→蓝、其余→绿。 */
export type BadgeTone = 'max' | 'think' | 'context' | 'plain'

export function badgeTone(label: string): BadgeTone {
  const normalized = label.trim().toLowerCase()
  if (normalized === 'max') return 'max'
  if (normalized.includes('think') || label.includes('思考') || label.includes('推理')) return 'think'
  if (/^\d+(\.\d+)?\s*[km]$/.test(normalized) || label.includes('上下文')) return 'context'
  return 'plain'
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
  if (sessionModelName) return sessionModelName
  if (!profile) return '运行配置待读取'
  const options = [...profile.options]
  if (profile.maxMode && !options.includes('Max')) options.push('Max')
  return [profile.displayName, ...options].join(' · ')
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
