import { describe, expect, it } from 'vitest'
import {
  DEFAULT_UNANSWERED_TTL_MS,
  findUnansweredDirectives,
  leadSilenceEvidence
} from '../src/domain/team-collab-sweeps'
import { emptyTeamCollaborationSnapshot, type TeamMessage } from '../src/domain/team-collaboration'

const NOW = 1_800_000_000_000

function makeMessage(overrides: Partial<TeamMessage>): TeamMessage {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 10)}`,
    runId: 'run-1',
    threadId: 'thread-1',
    sender: { type: 'agent', slotId: 'slot-lead' },
    recipient: { type: 'agent', slotId: 'slot-backend' },
    kind: 'notice',
    content: '内容',
    clientMessageId: `cm-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: NOW,
    receipt: { notificationState: 'notified', updatedAt: NOW },
    ...overrides
  } as TeamMessage
}

function snapshotWith(messages: TeamMessage[]) {
  const snapshot = emptyTeamCollaborationSnapshot('run-1')
  for (const message of messages) {
    snapshot.messages[message.id] = message
    snapshot.messageOrder.push(message.id)
  }
  return snapshot
}

describe('findUnansweredDirectives', () => {
  it('超龄未回应的 directive/question 被抓出', () => {
    const old = makeMessage({
      id: 'm-old',
      kind: 'directive',
      createdAt: NOW - DEFAULT_UNANSWERED_TTL_MS - 1_000
    })
    const fresh = makeMessage({ id: 'm-fresh', kind: 'question', createdAt: NOW - 60_000 })
    const result = findUnansweredDirectives(snapshotWith([old, fresh]), NOW)
    expect(result.map((item) => item.id)).toEqual(['m-old'])
    expect(result[0]?.ageMs).toBeGreaterThan(DEFAULT_UNANSWERED_TTL_MS)
  })

  it('已有 response 关联的消息不算挂死', () => {
    const question = makeMessage({
      id: 'm-q',
      kind: 'question',
      createdAt: NOW - DEFAULT_UNANSWERED_TTL_MS * 2
    })
    const answer = makeMessage({
      id: 'm-a',
      kind: 'response',
      replyToMessageId: 'm-q',
      createdAt: NOW - DEFAULT_UNANSWERED_TTL_MS
    })
    expect(findUnansweredDirectives(snapshotWith([question, answer]), NOW)).toEqual([])
  })

  it('notice/status/response 不需要回应，不参与挂死判定', () => {
    const notice = makeMessage({
      id: 'm-n',
      kind: 'notice',
      createdAt: NOW - DEFAULT_UNANSWERED_TTL_MS * 3
    })
    expect(findUnansweredDirectives(snapshotWith([notice]), NOW)).toEqual([])
  })
})

describe('leadSilenceEvidence（正面终止证据口径）', () => {
  it('runtime 新鲜活性一票否决陈旧 liveness 离线记录', () => {
    // ping 失败残留的 suspected 记录无刷新机制，runtime 新鲜即健在直接证据
    expect(leadSilenceEvidence({
      runtime: { online: true, lastSeenAt: NOW },
      liveness: {
        channelId: '1',
        liveness: 'suspected_offline',
        lastVerifiedAt: NOW - 5_000,
        consecutiveFailures: 2
      },
      now: NOW
    })).toBeNull()
  })

  it('runtime 缺失时即使 confirmed_offline 也不诱导接管', () => {
    expect(leadSilenceEvidence({
      liveness: {
        channelId: '1',
        liveness: 'confirmed_offline',
        lastVerifiedAt: NOW - 5_000,
        consecutiveFailures: 3
      },
      now: NOW
    })).toBeNull()
  })

  it('被动 online=false 只属于 suspected，不构成证据', () => {
    expect(leadSilenceEvidence({
      runtime: { online: false, runtimeEvidence: 'suspected', lastSeenAt: NOW - 1_000 },
      now: NOW
    })).toBeNull()
  })

  it('runtime lastSeenAt 长时间静默也不构成证据', () => {
    expect(leadSilenceEvidence({
      runtime: { online: false, runtimeEvidence: 'suspected', lastSeenAt: NOW - 3_600_000 },
      now: NOW
    })).toBeNull()
  })

  it('健康主控不误报：lastSeenAt 新鲜时其余时间戳再旧也返回 null', () => {
    // 回归主控复审指出的缺陷：签到/ping 等一次性事件时间戳不作心跳口径
    expect(leadSilenceEvidence({
      runtime: { online: true, lastSeenAt: NOW - 5_000 },
      liveness: {
        channelId: '1',
        liveness: 'active',
        lastVerifiedAt: NOW - 3_600_000,
        consecutiveFailures: 0,
        lastPongAt: NOW - 3_600_000
      },
      installedAt: NOW - 86_400_000,
      now: NOW
    })).toBeNull()
  })

  it('绑定后从未上线仍是证据不足', () => {
    expect(leadSilenceEvidence({
      installedAt: NOW - 86_400_000,
      now: NOW
    })).toBeNull()
    expect(leadSilenceEvidence({ now: NOW })).toBeNull()
  })

  it('processing 长任务不因 no-pong 或时间陈旧误报', () => {
    expect(leadSilenceEvidence({
      runtime: {
        online: false,
        runtimeEvidence: 'suspected',
        status: 'running',
        connectionPhase: 'processing',
        lastSeenAt: NOW - 3_600_000
      },
      liveness: {
        channelId: '1', liveness: 'confirmed_offline', lastVerifiedAt: NOW,
        consecutiveFailures: 3
      },
      now: NOW
    })).toBeNull()
  })

  it('Cursor/运行时明确终止才返回可广播证据', () => {
    expect(leadSilenceEvidence({
      runtime: {
        online: false,
        runtimeEvidence: 'stopped',
        status: 'offline',
        connectionPhase: 'cursor_stopped'
      },
      now: NOW
    })).toContain('Cursor 已明确终止')
  })
})
