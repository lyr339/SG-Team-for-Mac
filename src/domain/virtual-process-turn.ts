import type { ConversationEntry, ProcessBlock } from './conversation-entry'

export interface VirtualProcessBlockSegment {
  anchorEntryId?: string
  blocks: ProcessBlock[]
  startedAt: number
}

function deliveredAt(entry: ConversationEntry, immediateDelivery: boolean): number | undefined {
  return entry.deliveredAt ?? (immediateDelivery ? entry.timestamp : undefined)
}

/** 按消息真实投递时间，把一个长期 Cursor turn 的原生块切成用户消息级片段。 */
export function partitionVirtualProcessBlocks(
  entries: ConversationEntry[],
  blocks: ProcessBlock[],
  fallbackStartedAt: number,
  immediateDelivery = false,
  excludedIds: ReadonlySet<string> = new Set()
): VirtualProcessBlockSegment[] {
  const users = entries
    .filter((entry) => entry.role === 'user' && deliveredAt(entry, immediateDelivery) !== undefined)
    .sort((left, right) => deliveredAt(left, immediateDelivery)! - deliveredAt(right, immediateDelivery)!)
  const segments = new Map<string, VirtualProcessBlockSegment>()
  for (const block of blocks) {
    if (excludedIds.has(block.id)) continue
    const startedAt = block.startedAt ?? fallbackStartedAt
    let low = 0
    let high = users.length - 1
    let anchorIndex = -1
    while (low <= high) {
      const middle = (low + high) >>> 1
      if (deliveredAt(users[middle]!, immediateDelivery)! <= startedAt) {
        anchorIndex = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    const anchor = anchorIndex >= 0 ? users[anchorIndex] : undefined
    const key = anchor?.id ?? '__prelude__'
    const segment = segments.get(key) ?? { anchorEntryId: anchor?.id, blocks: [], startedAt }
    segment.blocks.push(block)
    segment.startedAt = Math.min(segment.startedAt, startedAt)
    segments.set(key, segment)
  }
  return [...segments.values()]
}
