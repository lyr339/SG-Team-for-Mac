import type { ConversationEntry, ProcessBlock } from '../../domain/conversation-entry'
import { partitionVirtualProcessBlocks } from '../../domain/virtual-process-turn'
import type { LiveAgentResponseState, LiveProcessState } from '../../shared/desktop-api'

export interface VirtualProcessTurn {
  id: string
  position: number
  process?: LiveProcessState
  response?: LiveAgentResponseState
  live: boolean
}

interface TurnGroup {
  anchorId?: string
  blocks: ProcessBlock[]
  response?: LiveAgentResponseState
}

function anchorForTime(entries: ConversationEntry[], timestamp: number, immediateDelivery: boolean): string | undefined {
  let anchor: ConversationEntry | undefined
  for (const entry of entries) {
    if (entry.role !== 'user') continue
    const deliveredAt = entry.deliveredAt ?? (immediateDelivery ? entry.timestamp : undefined)
    if (deliveredAt === undefined || deliveredAt > timestamp) continue
    const anchorDeliveredAt = anchor?.deliveredAt ?? (anchor && immediateDelivery ? anchor.timestamp : -1)
    if (!anchor || deliveredAt >= anchorDeliveredAt) anchor = entry
  }
  return anchor?.id
}

/**
 * 把 Cursor 的单个长期原生 turn 投影成拾光用户消息级回合。
 * `deliveredAt` 是消息真正从 check_messages 进入模型的边界；仅入队、尚未取走的
 * 用户消息不会提前夺走正在执行的旧过程。原生 block id 用于剔除已随回复持久化的步骤。
 */
export function projectVirtualProcessTurns(
  entries: ConversationEntry[],
  process?: LiveProcessState,
  response?: LiveAgentResponseState,
  immediateDelivery = false
): VirtualProcessTurn[] {
  if (!process?.blocks.length && !response) return []

  const persistedBlockIds = new Set(entries.flatMap((entry) => (
    entry.processBlocks?.map((block) => block.id) ?? []
  )))
  const groups = new Map<string, TurnGroup>()
  const groupFor = (anchorId?: string): TurnGroup => {
    const key = anchorId ?? '__prelude__'
    const existing = groups.get(key)
    if (existing) return existing
    const created: TurnGroup = { anchorId, blocks: [] }
    groups.set(key, created)
    return created
  }

  for (const segment of partitionVirtualProcessBlocks(
    entries, process?.blocks ?? [], process?.startedAt ?? 0, immediateDelivery, persistedBlockIds
  )) {
    groupFor(segment.anchorEntryId).blocks.push(...segment.blocks)
  }
  if (response) groupFor(anchorForTime(entries, response.startedAt, immediateDelivery)).response = response

  const entryIndex = new Map(entries.map((entry, index) => [entry.id, index] as const))
  const positionFor = (group: TurnGroup): number => {
    if (!group.anchorId) {
      const startedAt = group.blocks[0]?.startedAt ?? group.response?.startedAt ?? process?.startedAt ?? 0
      const followingEntry = entries.findIndex((entry) => entry.timestamp >= startedAt)
      if (followingEntry >= 0) return followingEntry - 0.5
      const firstUser = entries.findIndex((entry) => entry.role === 'user')
      return firstUser >= 0 ? firstUser - 0.5 : entries.length + 0.5
    }
    const anchorIndex = entryIndex.get(group.anchorId) ?? entries.length - 1
    let nextUserIndex = entries.findIndex((entry, index) => index > anchorIndex && entry.role === 'user')
    if (nextUserIndex < 0) nextUserIndex = entries.length
    const explicitReplyIndex = entries.findIndex((entry, index) => (
      index > anchorIndex && index < nextUserIndex && entry.replyToEntryId === group.anchorId
    ))
    const replyIndex = explicitReplyIndex >= 0 ? explicitReplyIndex : entries.findIndex((entry, index) => (
      index > anchorIndex && index < nextUserIndex && entry.role === 'assistant'
    ))
    return replyIndex >= 0 ? replyIndex - 0.5 : anchorIndex + 0.5
  }

  let truncationAssigned = false
  return [...groups.values()]
    .filter((group) => group.blocks.length || group.response)
    .map((group): VirtualProcessTurn => {
      const startedAt = group.blocks[0]?.startedAt ?? group.response?.startedAt ?? process?.startedAt ?? Date.now()
      const segmentProcess = group.blocks.length && process ? {
        ...process,
        turn: `${process.turn}:virtual:${group.anchorId ?? 'prelude'}`,
        blocks: group.blocks,
        startedAt,
        truncatedItemCount: !truncationAssigned ? process.truncatedItemCount : undefined
      } : undefined
      if (segmentProcess) truncationAssigned = true
      return {
        id: group.anchorId ?? 'prelude',
        position: positionFor(group),
        process: segmentProcess,
        response: group.response,
        live: group.response?.status === 'streaming'
          || group.blocks.some((block) => block.status === 'running')
      }
    })
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
}
