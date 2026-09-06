import { describe, expect, it } from 'vitest'
import { sortConversationEntries, type ConversationEntry } from '../src/domain/conversation-entry'
import { projectTurnTimeline } from '../src/renderer/src/timeline-view'

function user(id: string, timestamp: number, deliveredAt?: number): ConversationEntry {
  return { id, channelId: '1', role: 'user', text: id, timestamp, deliveredAt, status: 'complete', source: 'desktop' }
}

function assistant(
  id: string,
  timestamp: number,
  replyToEntryId?: string,
  processBlocks?: ConversationEntry['processBlocks']
): ConversationEntry {
  return {
    id, channelId: '1', role: 'assistant', text: id, timestamp, status: 'complete', source: 'cursor',
    replyToEntryId, processBlocks
  }
}

function process(blocks: Array<{ id: string; startedAt: number }>): {
  turn: string
  startedAt: number
  updatedAt: number
  blocks: import('../src/domain/conversation-entry').ProcessBlock[]
} {
  return {
    turn: 'cursor:native-long-turn',
    startedAt: blocks[0]?.startedAt ?? 900,
    updatedAt: 2_000,
    blocks: blocks.map((block) => ({ kind: 'thinking', id: block.id, text: block.id, status: 'running', startedAt: block.startedAt }))
  }
}

describe('projectTurnTimeline（阶段 F：统一回合身份）', () => {
  it('keeps one stable turn key across queued → delivered → responding → sealed (§8.5-1)', () => {
    const queued = projectTurnTimeline({ entries: [user('u1', 1_000)] })
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ key: 'turn:u1', phase: 'queued' })

    const delivered = projectTurnTimeline({ entries: [user('u1', 1_000, 1_100)] })
    expect(delivered[0]).toMatchObject({ key: 'turn:u1', phase: 'delivered' })

    const responding = projectTurnTimeline({
      entries: [user('u1', 1_000, 1_100)],
      liveProcess: process([{ id: 'work-1', startedAt: 1_200 }]),
      agentRunning: true
    })
    expect(responding[0]).toMatchObject({ key: 'turn:u1', phase: 'responding' })
    expect(responding[0]?.process?.blocks.map((block) => block.id)).toEqual(['work-1'])

    const sealed = projectTurnTimeline({
      entries: [user('u1', 1_000, 1_100), assistant('a1', 1_500, 'u1')]
    })
    expect(sealed[0]).toMatchObject({
      key: 'turn:u1', phase: 'sealed',
      reply: expect.objectContaining({ id: 'a1' })
    })

    // 身份恒定：四阶段同一 key
    expect(new Set([queued, delivered, responding, sealed].flatMap((items) => items.map((item) => item.key))))
      .toEqual(new Set(['turn:u1']))
  })

  it('renders the live process inside its anchored turn, not as a separate timeline row', () => {
    const items = projectTurnTimeline({
      entries: [user('u1', 1_000, 1_100)],
      liveProcess: process([{ id: 'work-1', startedAt: 1_200 }]),
      liveResponse: { id: 'bubble-1', channelId: '1', text: '流式正文', status: 'streaming', startedAt: 1_300, updatedAt: 1_350 },
      agentRunning: true
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: 'turn:u1', phase: 'responding' })
    expect(items[0]?.response?.id).toBe('bubble-1')
  })

  it('falls back to entry identity for legacy replies without an outbound link', () => {
    const items = projectTurnTimeline({
      entries: [assistant('legacy-1', 1_500)]
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: 'entry:legacy-1', phase: 'sealed' })
  })

  it('emits a detached prelude item for processes before the first user message', () => {
    const items = projectTurnTimeline({
      entries: [user('u1', 2_000, 2_100)],
      liveProcess: process([{ id: 'old-work', startedAt: 1_200 }])
    })
    expect(items.map((item) => ({ key: item.key, phase: item.phase }))).toEqual([
      { key: `turn:prelude:cursor:native-long-turn`, phase: 'responding' },
      { key: 'turn:u1', phase: 'delivered' }
    ])
  })

  it('keeps a message queued before the previous reply landed below that reply, in both orderings (2026-09-06 报告)', () => {
    // 用户在 A 的回复落库（1_500）之前就排队了 B（1_300）；B 在 1_800 才被取走并开始执行。
    const a = user('u-a', 1_000, 1_100)
    const replyA = assistant('reply-a', 1_500, 'u-a')
    const bQueued = user('u-b', 1_300)
    const bDelivered = user('u-b', 1_300, 1_800)

    // 排队期：B 排在一切已发生内容之后，回复仍归 A。
    const queuedEntries = sortConversationEntries([a, bQueued, replyA])
    expect(queuedEntries.map((entry) => entry.id)).toEqual(['u-a', 'reply-a', 'u-b'])
    const queued = projectTurnTimeline({ entries: queuedEntries, agentRunning: true })
    expect(queued.map((item) => [item.key, item.phase])).toEqual([
      ['turn:u-a', 'sealed'],
      ['turn:u-b', 'queued']
    ])

    // 执行期：B 的过程流在自己的回合里，位于 A 的最终回复之下，不再产生孤立的 entry: 条目。
    const runningEntries = sortConversationEntries([a, bDelivered, replyA])
    expect(runningEntries.map((entry) => entry.id)).toEqual(['u-a', 'reply-a', 'u-b'])
    const running = projectTurnTimeline({
      entries: runningEntries,
      liveProcess: process([{ id: 'work-b', startedAt: 1_900 }]),
      agentRunning: true
    })
    expect(running.map((item) => [item.key, item.phase])).toEqual([
      ['turn:u-a', 'sealed'],
      ['turn:u-b', 'responding']
    ])
    expect(running[0]?.reply?.id).toBe('reply-a')
    expect(running[1]?.process?.blocks.map((block) => block.id)).toEqual(['work-b'])
  })

  it('keeps legacy data without delivery timestamps in creation order', () => {
    // 无 deliveredAt 的旧消息：有链路的回复证明它进过对话（紧贴回复之前）；
    // 回复完全无链路的旧会话退回创建时刻顺序，不会整批被当成"排队中"沉到底部。
    const linked = sortConversationEntries([assistant('a1', 1_500, 'u1'), user('u2', 2_000), user('u1', 1_000)])
    expect(linked.map((entry) => entry.id)).toEqual(['u1', 'a1', 'u2'])
    const unlinked = sortConversationEntries([assistant('a1', 1_500), user('u2', 2_000), user('u1', 1_000)])
    expect(unlinked.map((entry) => entry.id)).toEqual(['u1', 'a1', 'u2'])
  })

  it('anchors a legacy reply without an outbound link to the user message right before it', () => {
    // 无 replyToEntryId 的旧回复：锚到时间线上紧邻其前的用户消息，排队中的消息不会抢走它。
    const items = projectTurnTimeline({
      entries: [user('u1', 1_000, 1_100), assistant('legacy-1', 1_500), user('u2', 1_200)]
    })
    expect(items.map((item) => [item.key, item.phase])).toEqual([
      ['turn:u1', 'sealed'],
      ['turn:u2', 'queued']
    ])
    expect(items[0]?.reply?.id).toBe('legacy-1')
  })

  it('keeps error entries as standalone rows without hijacking turn grouping', () => {
    const items = projectTurnTimeline({
      entries: [
        user('u1', 1_000, 1_100),
        { id: 'err1', channelId: '1', role: 'error', text: '失败', timestamp: 1_200, status: 'failed', source: 'desktop', error: 'boom' },
        assistant('a1', 1_500, 'u1')
      ]
    })
    expect(items.map((item) => item.key)).toEqual(['turn:u1', 'entry:err1'])
    expect(items[0]?.phase).toBe('sealed')
  })
})
