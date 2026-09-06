import type { ConversationEntry } from '../../domain/conversation-entry'
import type { LiveAgentResponseState, LiveProcessState } from '../../shared/desktop-api'
import { projectVirtualProcessTurns } from './virtual-process-turns'

/**
 * 阶段 F（RC-8）：统一回合时间线投影。
 *
 * 业务回合从入队到历史的完整生命周期使用同一 DOM 身份：
 *   key = turn:<outboundId>
 * queued → delivered → responding → sealed，仅 phase 字段推进——
 * 组件不再因 key 变化被卸载重建，打字机缓冲 / Thought 展开 / 工具展开 /
 * ResizeObserver 贴底位置全部保留。
 *
 * 历史兼容：旧数据缺少 outboundId 时回退 entry 身份（entry:<id>），只投影
 * 存量，不参与相位推进。
 */
export type TurnTimelinePhase = 'queued' | 'delivered' | 'responding' | 'sealed'

export interface TurnTimelineItem {
  /** 稳定 DOM key：turn:<outboundId>；旧数据回退 entry:<id>。 */
  key: string
  phase: TurnTimelinePhase
  /** 排序位置（会话时间线索引的邻域值）。 */
  position: number
  /** 用户消息（queued/delivered//responding/sealed 全阶段保留渲染）。 */
  user?: ConversationEntry
  /** 实时过程（responding 阶段）。 */
  process?: LiveProcessState
  /** Cursor 原生回复流（responding 阶段）。 */
  response?: LiveAgentResponseState
  /** 已落库回复（sealed 阶段）。 */
  reply?: ConversationEntry
  /** 无锚过程（首条消息之前的遗留过程），独立渲染不打断分组。 */
  detached?: LiveProcessState
}

export interface TurnTimelineInput {
  entries: readonly ConversationEntry[]
  liveProcess?: LiveProcessState
  liveResponse?: LiveAgentResponseState
  /** 非队列传输（插件直连）按入队即投递处理。 */
  immediateDelivery?: boolean
  /** Agent 正在运行（处理占位判定）。 */
  agentRunning?: boolean
}

/**
 * 回复按 outboundId 精确关联用户消息；旧数据（无 replyToEntryId）回退为时间线上
 * 紧邻其前的用户消息——entries 已按进入对话的时刻排序（sortConversationEntries），
 * 排队中的消息在末尾，不会被误认成更早回复的锚点。
 */
function replyAnchorIndex(entries: readonly ConversationEntry[], reply: ConversationEntry): number {
  if (reply.replyToEntryId) {
    const index = entries.findIndex((entry) => entry.id === reply.replyToEntryId)
    if (index >= 0) return index
  }
  const replyIndex = entries.indexOf(reply)
  for (let index = (replyIndex >= 0 ? replyIndex : entries.length) - 1; index >= 0; index -= 1) {
    if (entries[index]!.role === 'user') return index
  }
  return -1
}

/**
 * 把会话条目 + 实时过程/回复流投影为统一回合时间线。
 * 前置条件：entries 已过滤 silent；liveProcess/liveResponse 属当前通道。
 */
export function projectTurnTimeline(input: TurnTimelineInput): TurnTimelineItem[] {
  const { entries, liveProcess, liveResponse, immediateDelivery = false, agentRunning = false } = input
  const items: TurnTimelineItem[] = []
  const consumedUserIds = new Set<string>()

  // 实时过程/回复按既有虚拟回合分段锚定（复用 Stage B 的关闭边界语义）
  const virtualTurns = projectVirtualProcessTurns(entries, liveProcess, liveResponse, immediateDelivery)
  const liveByAnchor = new Map(virtualTurns
    .filter((turn) => turn.id !== 'prelude')
    .map((turn) => [turn.id, turn]))
  const preludeTurn = virtualTurns.find((turn) => turn.id === 'prelude')

  // pass 1：用户消息 → 回合起点；关联回复封口
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.role !== 'user') continue
    if (consumedUserIds.has(entry.id)) continue
    consumedUserIds.add(entry.id)

    // 该回合的回复：精确锚定在「本消息之后、下一用户消息之前」
    let nextUserIndex = entries.findIndex((candidate, cursor) => (
      cursor > index && candidate.role === 'user'
    ))
    if (nextUserIndex < 0) nextUserIndex = entries.length
    let reply: ConversationEntry | undefined
    for (let cursor = index + 1; cursor < nextUserIndex; cursor += 1) {
      const candidate = entries[cursor]!
      if (candidate.role === 'assistant') {
        if (replyAnchorIndex(entries, candidate) === index) {
          reply = candidate
          break
        }
      }
    }

    const live = liveByAnchor.get(entry.id)
    const delivered = entry.deliveredAt !== undefined || immediateDelivery
    const phase: TurnTimelinePhase = reply
      ? 'sealed'
      : live || (agentRunning && delivered)
        ? 'responding'
        : delivered
          ? 'delivered'
          : 'queued'

    // sealed 阶段仍携带锚定到本回合的实时过程：已随回复持久化的块已被
    // projectVirtualProcessTurns 按 id 剔除，剩余的是「回复先落库、封口帧稍后
    // 到达」窗口内的过程——渲染层用它兜底，过程卡不会在封口瞬间消失再出现。
    items.push({
      key: `turn:${entry.id}`,
      phase,
      position: index,
      user: entry,
      process: live?.process,
      response: live?.response,
      reply
    })
  }

  // pass 2：无精确锚的回复（旧数据 / replyToEntryId 缺失且时间窗兜底失败）
  const consumedReplyIds = new Set(items.flatMap((item) => (item.reply ? [item.reply.id] : [])))
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.role !== 'assistant' || consumedReplyIds.has(entry.id)) continue
    items.push({
      key: `entry:${entry.id}`,
      phase: 'sealed',
      position: index + 0.25,
      reply: entry
    })
  }

  // pass 3：首条用户消息之前的遗留过程（prelude）独立成项
  if (preludeTurn && (preludeTurn.process?.blocks.length || preludeTurn.response)) {
    const firstUserIndex = entries.findIndex((entry) => entry.role === 'user')
    items.push({
      key: `turn:prelude:${liveProcess?.turn ?? 'process'}`,
      phase: 'responding',
      position: firstUserIndex >= 0 ? firstUserIndex - 0.5 : -0.5,
      process: preludeTurn.process,
      response: preludeTurn.response,
      detached: preludeTurn.process
    })
  }

  // pass 4：其它角色（error / system）保持 entry 身份直渲染
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.role === 'user' || entry.role === 'assistant') continue
    items.push({
      key: `entry:${entry.id}`,
      phase: 'sealed',
      position: index + 0.5,
      reply: entry
    })
  }

  return items.sort((left, right) => (
    left.position - right.position || left.key.localeCompare(right.key)
  ))
}
