import type { DesktopSnapshot, SendMessageAccepted, SendMessageInput } from '../shared/desktop-api'
import type { DesktopSessionTransport } from './desktop-session-service'
import type { TeamControlBridge } from './team-control-service'
import type { ChannelMessageRelay } from './channel-message-relay'

const LOCAL_ENDPOINT = 'qunshu://local-channel-runtime'

type SnapshotListener = (snapshot: DesktopSnapshot) => void

function localSnapshot(now = Date.now()): DesktopSnapshot {
  return {
    connection: {
      state: 'connected',
      endpoint: LOCAL_ENDPOINT,
      attempt: 0,
      lastError: ''
    },
    sessions: [],
    conversations: {},
    protocolIssues: [],
    updatedAt: now
  }
}

/**
 * 群枢本地通道桥。
 *
 * 旧版通过 qingtian-v2 的 3180 WebSocket 投递消息、发现通道；一体化后
 * 通道收发由 SQLite + qunshu-ch-N 内嵌统一 server 完成。这个桥只提供本机控制面
 * 快照与发送入口，确保组队、安装和启动不再依赖旧插件进程。
 */
export class LocalSessionBridge implements DesktopSessionTransport, TeamControlBridge {
  private readonly listeners = new Set<SnapshotListener>()
  private readonly unsubscribeRelay: () => void

  constructor(private readonly relay: ChannelMessageRelay) {
    this.unsubscribeRelay = relay.subscribe(() => this.emit())
  }

  getSnapshot(): DesktopSnapshot {
    return this.relay.applyTo(localSnapshot())
  }

  sendMessage(input: SendMessageInput): SendMessageAccepted {
    return this.relay.sendMessage(input)
  }

  beginConversationScope(input: { runId: string; startedAt: number }): DesktopSnapshot {
    if (!input.runId.trim() || !Number.isFinite(input.startedAt)) throw new Error('会话作用域无效')
    this.relay.resetScope(input.startedAt)
    const snapshot = this.getSnapshot()
    this.emit(snapshot)
    return snapshot
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.unsubscribeRelay()
    this.listeners.clear()
  }

  private emit(snapshot = this.getSnapshot()): void {
    for (const listener of this.listeners) listener(snapshot)
  }
}
