import type { CursorSessionUsage } from '../../domain/cursor-usage'
import {
  cursorUsageDetail,
  formatCostUsd,
  formatTokenCount,
  totalUsageTokens
} from '../../domain/cursor-usage'

interface SessionUsageStatProps {
  usage?: CursorSessionUsage
}

export function SessionUsageStat({ usage }: SessionUsageStatProps): React.JSX.Element | null {
  if (!usage || usage.turns <= 0) return null
  const tokens = formatTokenCount(totalUsageTokens(usage))
  const cost = formatCostUsd(usage.estimatedCostUsd)
  return (
    <span
      className="session-usage-stat"
      title={cursorUsageDetail(usage)}
      aria-label={`真实计费 token ${tokens}，等价 API 费用估算 ${cost}，${usage.turns} 回合`}
    >
      <span className="session-usage-stat__tokens"><i aria-hidden="true" />{tokens}<small>tok</small></span>
      <span className="session-usage-stat__cost">≈{cost}</span>
    </span>
  )
}
