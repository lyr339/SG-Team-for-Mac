import type { CursorSessionUsage } from '../../domain/cursor-usage'
import {
  cursorUsageDetail,
  formatCostUsd,
  formatTokenCount,
  totalUsageTokens
} from '../../domain/cursor-usage'

interface SessionUsageStatProps {
  usage?: CursorSessionUsage
  bound?: boolean
}

/**
 * 会话页头用量度量组（Orbit 主题「静默度量」）：
 * 排版即界面——小号大写标签 + 齐宽数字的两段式度量，hairline 竖分隔，
 * 无底色无描边，冷中性承载内容；完整明细走悬浮提示。
 * 未读取时同构降级为破折号（弱化），保持页头占位稳定不跳动。
 */
export function SessionUsageStat({ usage, bound = false }: SessionUsageStatProps): React.JSX.Element | null {
  const ready = Boolean(usage && usage.turns > 0)
  if (!ready && !bound) return null
  const tokens = ready ? formatTokenCount(totalUsageTokens(usage!)) : '—'
  const cost = ready ? formatCostUsd(usage!.estimatedCostUsd) : '—'
  return (
    <span
      className={`session-usage${ready ? '' : ' is-pending'}`}
      title={ready ? cursorUsageDetail(usage!) : '等待 Cursor 完成首个可读取的计费回合'}
      aria-label={ready
        ? `真实计费 token ${tokens}，等价 API 费用估算 ${cost}，${usage!.turns} 回合`
        : '用量待读取'}
    >
      <span className="session-usage__cell">
        <span className="session-usage__label">Tokens</span>
        <b className="session-usage__value">{tokens}</b>
      </span>
      <span className="session-usage__sep" aria-hidden="true" />
      <span className="session-usage__cell">
        <span className="session-usage__label">Cost</span>
        <b className="session-usage__value">{cost}</b>
      </span>
    </span>
  )
}
