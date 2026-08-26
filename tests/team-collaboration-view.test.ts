import { describe, expect, it } from 'vitest'
import type { TeamCollaborationSnapshot, TeamMessage } from '../src/domain/team-collaboration'
import { emptyTeamCollaborationSnapshot } from '../src/domain/team-collaboration'
import type { TeamRun } from '../src/domain/team-control'
import {
  summarizeTeamCollaborationForRun,
  visibleTeamCollaborationSnapshot
} from '../src/renderer/src/team/team-collaboration-view'

type ActiveRun = Pick<TeamRun, 'id' | 'status'>

function run(id: string, status: TeamRun['status'] = 'running'): ActiveRun {
  return { id, status }
}

function message(input: {
  id: string
  runId: string
  recipient: TeamMessage['recipient']
  kind?: TeamMessage['kind']
  readAt?: number
  respondedAt?: number
}): TeamMessage {
  return {
    id: input.id,
    runId: input.runId,
    threadId: `thread:${input.id}`,
    sender: input.recipient.type === 'operator'
      ? { type: 'agent', slotId: 'slot:lead' }
      : { type: 'operator' },
    recipient: input.recipient,
    kind: input.kind ?? 'directive',
    content: 'message',
    clientMessageId: `client:${input.id}`,
    createdAt: 1_000,
    receipt: {
      notificationState: 'notified',
      notificationDetail: 'done',
      readAt: input.readAt,
      respondedAt: input.respondedAt,
      updatedAt: 1_000
    }
  }
}

function collaboration(runId: string, messages: TeamMessage[]): TeamCollaborationSnapshot {
  return {
    ...emptyTeamCollaborationSnapshot(runId),
    revision: 2,
    threads: messages.map((item) => ({
      id: item.threadId,
      runId,
      subject: item.id,
      createdAt: item.createdAt,
      updatedAt: item.createdAt
    })),
    messages: Object.fromEntries(messages.map((item) => [item.id, item])),
    messageOrder: messages.map((item) => item.id)
  }
}

describe('team collaboration view state', () => {
  it('hides stale messages from a previous run', () => {
    const previous = collaboration('run:old', [
      message({ id: 'm1', runId: 'run:old', recipient: { type: 'operator' } }),
      message({ id: 'm2', runId: 'run:old', recipient: { type: 'operator' } })
    ])

    expect(summarizeTeamCollaborationForRun(previous, run('run:new', 'draft'))).toEqual({
      operatorUnread: 0,
      pendingAgentReplies: 0,
      threadCount: 0
    })
    expect(visibleTeamCollaborationSnapshot(previous, run('run:new', 'draft'))).toMatchObject({
      runId: 'run:new',
      messageOrder: []
    })
  })

  it.each(['draft', 'ready'] as const)('hides same-run collaboration while %s', (status) => {
    const current = collaboration('run:1', [
      message({ id: 'm1', runId: 'run:1', recipient: { type: 'operator' } })
    ])

    expect(summarizeTeamCollaborationForRun(current, run('run:1', status))).toEqual({
      operatorUnread: 0,
      pendingAgentReplies: 0,
      threadCount: 0
    })
    expect(visibleTeamCollaborationSnapshot(current, run('run:1', status)).messageOrder).toEqual([])
  })

  it('clears current-run notification counters after completion', () => {
    const current = collaboration('run:1', [
      message({ id: 'm1', runId: 'run:1', recipient: { type: 'operator' } }),
      message({ id: 'm2', runId: 'run:1', recipient: { type: 'agent', slotId: 'slot:builder' } })
    ])

    expect(summarizeTeamCollaborationForRun(current, run('run:1', 'completed'))).toEqual({
      operatorUnread: 0,
      pendingAgentReplies: 0,
      threadCount: 0
    })
    expect(visibleTeamCollaborationSnapshot(current, run('run:1', 'completed')).messageOrder).toEqual([])
  })

  it('counts only active-run operator unread and agent messages that still require replies', () => {
    const current = collaboration('run:1', [
      message({ id: 'unread', runId: 'run:1', recipient: { type: 'operator' } }),
      message({ id: 'read', runId: 'run:1', recipient: { type: 'operator' }, readAt: 1_100 }),
      message({ id: 'pending', runId: 'run:1', recipient: { type: 'agent', slotId: 'slot:builder' } }),
      message({ id: 'answered', runId: 'run:1', recipient: { type: 'agent', slotId: 'slot:builder' }, respondedAt: 1_200 }),
      message({ id: 'status', runId: 'run:1', recipient: { type: 'agent', slotId: 'slot:builder' }, kind: 'status' })
    ])

    expect(summarizeTeamCollaborationForRun(current, run('run:1'))).toEqual({
      operatorUnread: 1,
      pendingAgentReplies: 1,
      threadCount: 5
    })
  })
})
