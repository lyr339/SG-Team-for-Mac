import { describe, expect, it } from 'vitest'
import type { ConversationEntry, ProcessBlock } from '../src/domain/conversation-entry'
import type { LiveProcessState } from '../src/shared/desktop-api'
import { projectVirtualProcessTurns } from '../src/renderer/src/virtual-process-turns'

function user(id: string, timestamp: number, deliveredAt?: number): ConversationEntry {
  return { id, channelId: '1', role: 'user', text: id, timestamp, deliveredAt, status: 'complete', source: 'desktop' }
}

function assistant(id: string, timestamp: number, blocks?: ProcessBlock[]): ConversationEntry {
  return { id, channelId: '1', role: 'assistant', text: id, timestamp, status: 'complete', source: 'cursor', processBlocks: blocks }
}

function block(id: string, startedAt: number): ProcessBlock {
  return { kind: 'thinking', id, text: id, status: 'done', startedAt }
}

function process(blocks: ProcessBlock[]): LiveProcessState {
  return { turn: 'cursor-native-long-turn', blocks, startedAt: 900, updatedAt: 2_000 }
}

describe('projectVirtualProcessTurns', () => {
  it('keeps the current process before a newly queued message until check_messages takes it', () => {
    const turns = projectVirtualProcessTurns([user('queued', 1_000)], process([block('old-work', 1_100)]))
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ id: 'prelude', position: -0.5 })
    expect(turns[0]?.process?.blocks.map((item) => item.id)).toEqual(['old-work'])
  })

  it('splits one native Cursor turn at the authoritative delivery boundary', () => {
    const turns = projectVirtualProcessTurns(
      [user('message-1', 1_000, 1_200)],
      process([block('before-delivery', 1_100), block('after-delivery', 1_300)])
    )
    expect(turns.map((turn) => ({ id: turn.id, position: turn.position, blocks: turn.process?.blocks.map((item) => item.id) }))).toEqual([
      { id: 'prelude', position: -0.5, blocks: ['before-delivery'] },
      { id: 'message-1', position: 0.5, blocks: ['after-delivery'] }
    ])
  })

  it('places a delivered-message process between its user bubble and persisted reply', () => {
    const turns = projectVirtualProcessTurns(
      [user('message-1', 1_000, 1_020), assistant('reply-1', 1_500)],
      process([block('work-1', 1_100)])
    )
    expect(turns[0]).toMatchObject({ id: 'message-1', position: 0.5 })
  })

  it('keeps work for the active message ahead of a later queued message', () => {
    const turns = projectVirtualProcessTurns(
      [user('message-1', 1_000, 1_050), user('queued-2', 1_200)],
      process([block('still-message-1', 1_300)])
    )
    expect(turns[0]).toMatchObject({ id: 'message-1', position: 0.5 })
  })

  it('does not replay blocks already persisted on a reply', () => {
    const persisted = block('persisted', 1_100)
    const turns = projectVirtualProcessTurns(
      [user('message-1', 1_000, 1_020), assistant('reply-1', 1_500, [persisted])],
      process([persisted, block('new', 1_600)])
    )
    expect(turns.flatMap((turn) => turn.process?.blocks.map((item) => item.id) ?? [])).toEqual(['new'])
  })

  it('uses enqueue time as the boundary for immediate non-queue transports', () => {
    const turns = projectVirtualProcessTurns(
      [user('plugin-message', 1_000)], process([block('plugin-work', 1_100)]), undefined, true
    )
    expect(turns[0]).toMatchObject({ id: 'plugin-message', position: 0.5 })
  })
})
