import type { AgentSession } from '../../domain/agent-session'
import type { DesktopSnapshot } from '../../shared/desktop-api'

// 会话对象指纹缓存：同一对象只算一次（WeakMap 随 GC 自动清理）。
const sessionFingerprintCache = new WeakMap<AgentSession, string>()
function sessionFingerprint(session: AgentSession): string {
  let fingerprint = sessionFingerprintCache.get(session)
  if (fingerprint === undefined) {
    fingerprint = JSON.stringify(session)
    sessionFingerprintCache.set(session, fingerprint)
  }
  return fingerprint
}

/**
 * 快照结构共享：整树替换会让 memo 子树全部失效。
 * 会话按指纹复用旧引用；conversations/liveProcess 按通道复用数组引用
 * （relay 侧增量重建后，未变通道天然同引用）。返回的新壳触发 App 本身重渲染即可。
 */
export function shareSnapshotStructure(previous: DesktopSnapshot, incoming: DesktopSnapshot): DesktopSnapshot {
  if (previous === incoming || previous.updatedAt === 0) return incoming
  const previousSessionsById = new Map(previous.sessions.map((session) => [session.id, session]))
  const sessions = incoming.sessions.map((session) => {
    const old = previousSessionsById.get(session.id)
    return old && sessionFingerprint(old) === sessionFingerprint(session) ? old : session
  })
  const conversations: DesktopSnapshot['conversations'] = {}
  for (const [channelId, entries] of Object.entries(incoming.conversations)) {
    conversations[channelId] = previous.conversations[channelId] === entries ? previous.conversations[channelId]! : entries
  }
  const liveProcess: DesktopSnapshot['liveProcess'] = incoming.liveProcess
    ? Object.fromEntries(Object.entries(incoming.liveProcess).map(([channelId, state]) => [
        channelId,
        previous.liveProcess?.[channelId] === state ? previous.liveProcess[channelId]! : state
      ]))
    : incoming.liveProcess
  const liveAgentResponses: DesktopSnapshot['liveAgentResponses'] = incoming.liveAgentResponses
    ? Object.fromEntries(Object.entries(incoming.liveAgentResponses).map(([channelId, state]) => [
        channelId,
        previous.liveAgentResponses?.[channelId] === state ? previous.liveAgentResponses[channelId]! : state
      ]))
    : incoming.liveAgentResponses
  return { ...incoming, sessions, conversations, liveProcess, liveAgentResponses }
}
