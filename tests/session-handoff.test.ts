import { describe, expect, it } from 'vitest'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import {
  buildSessionHandoffMessage,
  buildSessionHandoffRecord,
  formatHandoffTime,
  handoffRecordFileName,
  SESSION_HANDOFF_MARKER,
  type SessionTranscriptLocation
} from '../src/domain/session-handoff'
import { isOutboundDeliverableTo } from '../src/domain/channel-message'

const transcript: SessionTranscriptLocation = {
  path: '/Users/lyr/.cursor/projects/Users-lyr-Downloads-20260904/agent-transcripts/85bb41c4/85bb41c4.jsonl',
  exists: true,
  sizeBytes: 347_478,
  modifiedAt: new Date(2026, 8, 4, 14, 40).getTime(),
  recordCount: 191,
  resolution: 'global'
}
const issuedAt = new Date(2026, 8, 4, 20, 5).getTime()

describe('session handoff message', () => {
  it('addresses the rebuilt session itself and carries transcript path, record path and the stale-transcript guidance', () => {
    const text = buildSessionHandoffMessage({
      sourceChannelId: '1',
      sourceDisplayName: '独立席 1',
      sourceModelName: 'Claude Opus',
      target: { kind: 'self' },
      issuedAt,
      transcript,
      recordPath: '/Users/lyr/Library/Application Support/qingtian-team/handoff/CH-1-85bb41c4-20260904-200500.md',
      note: '接着把队列弹层收尾。'
    })
    expect(text.startsWith(`${SESSION_HANDOFF_MARKER}CH-1（独立席 1 · Claude Opus） 上一段会话的上下文 · 2026-09-04 20:05`)).toBe(true)
    expect(text).toContain('你是该席位重建后的新会话')
    expect(text).toContain(transcript.path)
    expect(text).toContain('191 条记录 · 339.3 KB · 最后写入 2026-09-04 14:40')
    expect(text).toContain('若文件修改时间早于本消息发出时间（2026-09-04 20:05）')
    expect(text).toContain('2. 拾光会话记录')
    expect(text).toContain('CH-1-85bb41c4-20260904-200500.md')
    expect(text).toContain('交接说明：接着把队列弹层收尾。')
    expect(text).toContain('向用户确认已接手')
  })

  it('describes a cross-session handoff and tolerates a transcript Cursor has not written yet', () => {
    const text = buildSessionHandoffMessage({
      sourceChannelId: '1',
      sourceDisplayName: '独立席 1',
      target: { kind: 'channel', channelId: '2' },
      issuedAt,
      transcript: { ...transcript, exists: false, sizeBytes: undefined, modifiedAt: undefined, recordCount: undefined, resolution: 'expected' }
    })
    expect(text).toContain('来自 CH-1（独立席 1） · 2026-09-04 20:05')
    expect(text).not.toContain('你是该席位重建后的新会话')
    expect(text).toContain('交接时该文件尚不存在')
    expect(text).not.toContain('拾光会话记录')
    expect(text).not.toContain('交接说明：')
  })

  it('clips over-long notes instead of rejecting them', () => {
    const text = buildSessionHandoffMessage({
      sourceChannelId: '1', sourceDisplayName: 'A', target: { kind: 'self' }, issuedAt, transcript,
      note: 'x'.repeat(5_000)
    })
    const noteLine = text.split('\n').find((line) => line.startsWith('交接说明：'))!
    expect(noteLine.length).toBe('交接说明：'.length + 2_000)
  })
})

describe('session handoff record (拾光侧会话记录)', () => {
  const entries: ConversationEntry[] = [
    {
      id: 'outbox:1', channelId: '1', role: 'user', source: 'desktop', status: 'complete',
      timestamp: new Date(2026, 8, 4, 19, 13, 30).getTime(), deliveredAt: 1, text: '你好，你是什么模型'
    },
    {
      id: 'reply:1', channelId: '1', role: 'assistant', source: 'cursor', status: 'complete',
      timestamp: new Date(2026, 8, 4, 19, 14, 13).getTime(), text: '你好！我是 Claude。',
      processBlocks: [
        { kind: 'thinking', id: 'th', text: '…', status: 'done' },
        { kind: 'tool', id: 'tool', toolName: 'read_file', status: 'done' }
      ]
    },
    {
      id: 'outbox:2', channelId: '1', role: 'user', source: 'desktop', status: 'complete',
      timestamp: new Date(2026, 8, 4, 19, 20).getTime(), text: '如图',
      attachments: [{ id: 'a', name: 'image.png', mimeType: 'image/png', size: 100, path: '/tmp/att/image.png' }]
    },
    {
      id: 'outbox:silent', channelId: '1', role: 'user', source: 'desktop', status: 'complete',
      timestamp: new Date(2026, 8, 4, 19, 21).getTime(), text: '【拾光内部协作通知】…', silent: true
    }
  ]

  it('renders header facts, every visible entry, attachment paths, queued state and process summaries', () => {
    const markdown = buildSessionHandoffRecord({
      channelId: '1', displayName: '独立席 1', workspacePath: '/Users/lyr/Downloads/20260904测试',
      runId: 'session-run:x:run-1', composerId: '85bb41c4-4815', modelName: 'Claude Opus',
      transcriptPath: transcript.path, issuedAt, entries
    })
    expect(markdown).toContain('# 拾光会话记录 · CH-1 独立席 1')
    expect(markdown).toContain('- 工程：/Users/lyr/Downloads/20260904测试')
    expect(markdown).toContain('- Cursor composerId：85bb41c4-4815')
    expect(markdown).toContain('- 消息：2 条用户消息 / 1 条 Agent 回复；时间范围 2026-09-04 19:13 – 2026-09-04 19:20')
    expect(markdown).toContain('## 用户 · 19:13:30\n\n你好，你是什么模型')
    expect(markdown).toContain('## Agent · 19:14:13\n\n你好！我是 Claude。\n\n（过程：2 步 · 1 次工具）')
    expect(markdown).toContain('（交接时尚未投递给 Agent）')
    expect(markdown).toContain('附件：image.png → /tmp/att/image.png')
    expect(markdown).not.toContain('内部协作通知')
    expect(markdown.endsWith('\n')).toBe(true)
  })

  it('names record files by channel, composer prefix and timestamp', () => {
    expect(handoffRecordFileName('1', '85bb41c4-4815-483a', issuedAt)).toBe('CH-1-85bb41c4-20260904-200500.md')
    expect(handoffRecordFileName('12', undefined, issuedAt)).toBe('CH-12-nocomposer-20260904-200500.md')
    expect(formatHandoffTime(issuedAt)).toBe('2026-09-04 20:05')
  })
})

describe('isOutboundDeliverableTo（等待新会话保持位）', () => {
  it('holds the message from the issuing session and from token-less callers, releases it to any other token', () => {
    const held = { holdSessionToken: 'seat-token-A' }
    expect(isOutboundDeliverableTo(held, 'seat-token-A')).toBe(false)
    expect(isOutboundDeliverableTo(held, undefined)).toBe(false)
    expect(isOutboundDeliverableTo(held, 'seat-token-B')).toBe(true)
    expect(isOutboundDeliverableTo({}, undefined)).toBe(true)
    expect(isOutboundDeliverableTo({ withdrawnAt: 1 }, 'seat-token-B')).toBe(false)
  })
})
