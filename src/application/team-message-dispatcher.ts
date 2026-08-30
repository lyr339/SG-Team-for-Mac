import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { TeamControlSnapshot } from '../domain/team-control'
import type {
  DesktopSnapshot,
  SendMessageAccepted,
  SendMessageInput
} from '../shared/desktop-api'
import type { TeamMessageKind } from '../domain/team-collaboration'
import { teamMessageRequiresResponse } from '../domain/team-collaboration'

const DEFAULT_DISPATCH_INTERVAL_MS = 750

export interface TeamMessageDispatcherBridge {
  getSnapshot(): DesktopSnapshot
  sendMessage(input: SendMessageInput): SendMessageAccepted
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void
}

export interface TeamMessageDispatcherTeamSource {
  getSnapshot(): TeamControlSnapshot
  subscribe(listener: (snapshot: TeamControlSnapshot) => void): () => void
}

interface InFlightNotification {
  messageId: string
  commandId: string
  channelId: string
}

function notificationEnvelope(input: {
  messageId: string
  channelId: string
  senderLabel: string
  kind: TeamMessageKind
}): string {
  const requiresResponse = teamMessageRequiresResponse(input.kind)
  return [
    '【拾光内部协作通知】',
    `消息 ID：${input.messageId}`,
    `发送者：${input.senderLabel}；类型：${input.kind}。`,
    `请调用当前 CH-${input.channelId} 的 SG Team MCP team_read_message（channel_id:'${input.channelId}'），使用上面的 messageId 读取持久化正文。`,
    requiresResponse
      ? '处理后必须调用 team_respond_message 建立明确关联回应；不要只在普通回复中声称已处理。'
      : '读取并纳入当前工作上下文即可；如需回复，再调用 team_respond_message 建立关联。'
  ].join('\n')
}

function commandEntry(snapshot: DesktopSnapshot, channelId: string, commandId: string) {
  return snapshot.commandReceipts?.[commandId]
    ?? snapshot.conversations[channelId]?.find((entry) => entry.commandId === commandId)
}

export class TeamMessageDispatcher {
  private readonly inFlight = new Map<string, InFlightNotification>()
  private readonly unsubscribeBridge: () => void
  private readonly unsubscribeTeam: () => void
  private timer?: ReturnType<typeof setInterval>
  private dispatching = false

  constructor(
    private readonly repository: TeamCollaborationRepository,
    private readonly bridge: TeamMessageDispatcherBridge,
    private readonly team: TeamMessageDispatcherTeamSource
  ) {
    this.unsubscribeBridge = bridge.subscribe((snapshot) => this.inspectReceipts(snapshot))
    this.unsubscribeTeam = team.subscribe(() => this.dispatchPending())
  }

  start(intervalMs = DEFAULT_DISPATCH_INTERVAL_MS): void {
    this.stop()
    this.repository.recoverStaleSending(Date.now() - 30_000)
    this.dispatchPending()
    this.timer = setInterval(() => this.dispatchPending(), Math.max(250, intervalMs))
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  dispose(): void {
    this.stop()
    this.unsubscribeBridge()
    this.unsubscribeTeam()
    for (const pending of this.inFlight.values()) {
      this.repository.markNotificationResult(
        pending.messageId,
        'uncertain',
        '外置软件退出时尚未收到最终投递回执；未自动重发'
      )
    }
    this.inFlight.clear()
  }

  dispatchPending(): void {
    if (this.dispatching) return
    this.dispatching = true
    try {
      const bridgeSnapshot = this.bridge.getSnapshot()
      if (bridgeSnapshot.connection.state !== 'connected') return
      const team = this.team.getSnapshot()
      const runId = team.activeRun?.id
      if (!runId) return
      const memberBySlot = new Map(team.members.map((member) => [member.slot.id, member]))
      const inFlightChannels = new Set([...this.inFlight.values()].map((item) => item.channelId))

      for (const message of this.repository.listPendingNotifications(runId, 25)) {
        if (message.recipient.type !== 'agent') continue
        const member = memberBySlot.get(message.recipient.slotId)
        const channelId = member?.binding?.channelId
        // Team messages are durable and may safely enter the embedded channel
        // queue while an online Agent is busy. Requiring check_messages to be
        // the current last action deadlocked collaboration: a working Agent
        // could never be notified about new work until it was already idle.
        if (!channelId || !member.runtime?.online) continue
        if (inFlightChannels.has(channelId)) continue
        const senderLabel = message.sender.type === 'operator'
          ? '外置控制台'
          : memberBySlot.get(message.sender.slotId)?.role.name ?? message.sender.slotId
        try {
          const accepted = this.bridge.sendMessage({
            channelId,
            scopeRunId: message.runId,
            // 系统内部协作通知对用户不可见：只投递给 Agent，不写入会话时间线
            silent: true,
            text: notificationEnvelope({
              messageId: message.id,
              channelId,
              senderLabel,
              kind: message.kind
            })
          })
          const updated = this.repository.markNotificationSending(
            message.id,
            accepted.commandId,
            `已交给 CH-${channelId} 的拾光投递队列`
          )
          if (updated.receipt.notificationState !== 'sending') continue
          this.inFlight.set(message.id, {
            messageId: message.id,
            commandId: accepted.commandId,
            channelId
          })
          inFlightChannels.add(channelId)
        } catch (error) {
          this.repository.markNotificationResult(
            message.id,
            'failed',
            error instanceof Error ? error.message : String(error)
          )
        }
      }
      // 本地通道投递是同步完成的：发送回调返回时回执条目已存在，
      // 而桥事件触发的 inspectReceipts 先于 inFlight 登记执行，
      // 这里主动对账一次，避免回执永远停在 sending。
      this.inspectReceipts(this.bridge.getSnapshot())
    } finally {
      this.dispatching = false
    }
  }

  private inspectReceipts(snapshot: DesktopSnapshot): void {
    for (const [messageId, pending] of this.inFlight) {
      const entry = commandEntry(snapshot, pending.channelId, pending.commandId)
      if (!entry || entry.status === 'pending') continue
      if (entry.status === 'complete') {
        this.repository.markNotificationResult(
          messageId,
          'notified',
          `拾光已确认通知送入 CH-${pending.channelId}`,
          entry.timestamp
        )
      } else if (entry.status === 'failed') {
        const detail = entry.error || '拾光通知投递失败'
        const uncertain = /连接中断|未自动重发|超时/.test(detail)
        this.repository.markNotificationResult(
          messageId,
          uncertain ? 'uncertain' : 'failed',
          detail,
          entry.timestamp
        )
      }
      this.inFlight.delete(messageId)
    }
    this.dispatchPending()
  }
}
