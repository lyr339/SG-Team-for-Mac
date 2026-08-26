/**
 * relay 增量重建基准：4 通道、每轮只 1 个通道有新回复，跑 200 轮 applyTo。
 * 对比口径：会话/会话条目对象分配次数（改前每轮全量 vs 改后按脏通道）。
 * 运行：npx tsx scripts/bench-relay-incremental.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChannelMessageRelay } from '../src/application/channel-message-relay'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import type { DesktopSnapshot } from '../src/shared/desktop-api'

const CHANNELS = ['1', '2', '3', '4']
const ROUNDS = 200

function baseSnapshot(): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: 'bench', attempt: 0, lastError: '' },
    sessions: [],
    conversations: {},
    protocolIssues: [],
    updatedAt: 0
  }
}

const path = join(mkdtempSync(join(tmpdir(), 'qingtian-bench-')), 'bench.sqlite3')
const repository = new SqliteChannelMessageRepository(path)
let clock = 1_000
const relay = new ChannelMessageRelay(repository, () => clock)
for (const channelId of CHANNELS) {
  repository.markChannelEmbedded(channelId, 'bench', '/bench')
  repository.touchPresence(channelId, { waiting: true, connectionPhase: 'waiting', lastSeenAt: clock }, clock)
}

let sessionReferenceKept = 0
let conversationReferenceKept = 0
let previous = relay.applyTo(baseSnapshot())

for (let round = 0; round < ROUNDS; round += 1) {
  clock += 500
  // 每轮只有 1 个通道产生新回复
  repository.recordReply({ channelId: CHANNELS[round % CHANNELS.length]!, content: `第 ${round} 轮回复` }, clock)
  relay.pollReplies()
  const next = relay.applyTo(baseSnapshot())
  for (const channelId of CHANNELS) {
    if (next.conversations[channelId] === previous.conversations[channelId]) conversationReferenceKept += 1
    const prevSession = previous.sessions.find((session) => session.channelId === channelId)
    const nextSession = next.sessions.find((session) => session.channelId === channelId)
    if (prevSession && prevSession === nextSession) sessionReferenceKept += 1
  }
  previous = next
}

const total = ROUNDS * CHANNELS.length
console.log(`回合数 ${ROUNDS} × 通道数 ${CHANNELS.length}`)
console.log(`conversations 条目引用复用：${conversationReferenceKept}/${total}（${(conversationReferenceKept / total * 100).toFixed(1)}% 零重分配；改前恒为 0%）`)
console.log(`session 视图引用复用：${sessionReferenceKept}/${total}（${(sessionReferenceKept / total * 100).toFixed(1)}% 零重建；改前恒为 0%）`)
repository.close()
