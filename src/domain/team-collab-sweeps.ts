import type {
  ChannelLivenessRecord,
  TeamCollaborationSnapshot,
  TeamMessage
} from './team-collaboration'
import { hasInFlightExecution, isExplicitlyStoppedPhase } from './channel-message'
import type { AgentSessionStatus } from './agent-session'

/**
 * 协作域挂死清扫的纯函数判定。
 *
 * 背景：任务/评审租约已有 task-pool 清扫器回收，但协作域（消息、主控心跳）
 * 此前没有任何回收与提醒机制——directive/question 发出无人回应即永久挂起，
 * 主控掉线也只有等成员自己发现后手动 team_run claim_lead。
 */

/** directive/question 未获回应的超龄阈值（默认 30 分钟）。 */
export const DEFAULT_UNANSWERED_TTL_MS = 30 * 60_000

/** 同一条超龄消息的提醒防抖窗：窗内不重复提醒。 */
export const UNANSWERED_ALERT_DEBOUNCE_MS = 30 * 60_000

const REQUIRES_RESPONSE = new Set<TeamMessage['kind']>(['directive', 'question'])

export interface UnansweredMessage {
  id: string
  threadId: string
  kind: TeamMessage['kind']
  sender: TeamMessage['sender']
  recipient: TeamMessage['recipient']
  createdAt: number
  ageMs: number
  contentPreview: string
}

/**
 * 找出快照里超龄未获回应的 directive/question。
 * 「已回应」的判定：存在一条 response 消息的 replyToMessageId 指向它。
 * operator 发出的与发给 operator 的都纳入（控制台调度同样可能挂死）。
 */
export function findUnansweredDirectives(
  snapshot: TeamCollaborationSnapshot,
  now: number,
  ttlMs: number = DEFAULT_UNANSWERED_TTL_MS
): UnansweredMessage[] {
  const answered = new Set<string>()
  for (const id of snapshot.messageOrder) {
    const message = snapshot.messages[id]
    if (message?.kind === 'response' && message.replyToMessageId) {
      answered.add(message.replyToMessageId)
    }
  }
  const result: UnansweredMessage[] = []
  for (const id of snapshot.messageOrder) {
    const message = snapshot.messages[id]
    if (!message || !REQUIRES_RESPONSE.has(message.kind)) continue
    if (answered.has(message.id)) continue
    const ageMs = now - message.createdAt
    if (ageMs < ttlMs) continue
    result.push({
      id: message.id,
      threadId: message.threadId,
      kind: message.kind,
      sender: message.sender,
      recipient: message.recipient,
      createdAt: message.createdAt,
      ageMs,
      contentPreview: message.content.slice(0, 120)
    })
  }
  return result
}

export interface LeadSilenceInput {
  /**
   * 主控成员运行态。runtimeEvidence=stopped / cursor_stopped 是接管提醒的
   * 正面终止证据；普通 online=false、lastSeenAt 陈旧只属于 suspected。
   */
  runtime?: {
    online: boolean
    status?: AgentSessionStatus
    connectionPhase?: string
    runtimeEvidence?: 'active' | 'suspected' | 'stopped'
    lastSeenAt?: number
    lastAgentActivityAt?: number
  }
  /** ping 记录只供审计；no-pong 不单独构成接管证据。 */
  liveness?: ChannelLivenessRecord
  /** 绑定安装时间只供审计，不作失联判定。 */
  installedAt?: number
  now: number
}

/**
 * 有效主控失联证据。只接受 Cursor/运行时正面终止；被动静默、online=false、
 * ping no-pong 与历史 suspected 记录均属于证据不足，不生成会诱导接管的广播。
 */
export function leadSilenceEvidence(input: LeadSilenceInput): string | null {
  const runtime = input.runtime
  const phase = runtime?.connectionPhase ?? ''
  if (runtime?.runtimeEvidence === 'stopped' || isExplicitlyStoppedPhase(phase)) {
    return `Cursor 已明确终止（connectionPhase=${phase}）`
  }
  // 执行中的 Agent 按协议不会持续轮询，也可能暂时无法 pong。此时 lastSeenAt
  // 陈旧只是正常执行现象，不能作为主控失联证据；正面终止相位已在上方处理。
  if (hasInFlightExecution(runtime)) return null
  // active 与 suspected 都不广播。suspected 只表示被动租约陈旧/证据不足；即使
  // ping 多次未响应，也可能只是 Agent 正在跑长命令。接管提醒必须等 stopped。
  return null
}
