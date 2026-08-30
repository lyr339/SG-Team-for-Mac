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

export function SessionUsageStat({ usage, bound = false }: SessionUsageStatProps): React.JSX.Element | null {
  if (!usage || usage.turns <= 0) {
    return bound ? (
      <span className="session-usage-pending" title="等待 Cursor 完成首个可读取的计费回合">
        Token 待读取
      </span>
    ) : null
  }
  const tokens = formatTokenCount(totalUsageTokens(usage))
  const cost = formatCostUsd(usage.estimatedCostUsd)
  return (
    <span
      className="session-usage-stat"
      title={cursorUsageDetail(usage)}
      aria-label={`真实计费 token ${tokens}，等价 API 费用估算 ${cost}，${usage.turns} 回合`}
    >
      <span className="session-usage-stat__tokens"><i aria-hidden="true" />{tokens}<small>Tokens</small></span>
      <span className="session-usage-stat__cost">{cost}</span>
    </span>
  )
}
