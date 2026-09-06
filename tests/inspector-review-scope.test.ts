import { describe, expect, it } from 'vitest'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import type { WorkspaceReviewSummary } from '../src/domain/workspace-review'
import {
  filterSummaryToPaths,
  latestDeliveredUserIndex,
  normalizeReviewPath,
  processBlockPath,
  reviewPathsMatch,
  turnMutatedPaths
} from '../src/renderer/src/inspector/review-scope'

const workspace = '/Users/me/project'

function user(id: string, timestamp: number, deliveredAt?: number): ConversationEntry {
  return { id, channelId: '2', role: 'user', text: `消息 ${id}`, timestamp, status: 'complete', source: 'desktop', deliveredAt }
}

function reply(id: string, timestamp: number, paths: string[]): ConversationEntry {
  return {
    id, channelId: '2', role: 'assistant', text: '完成', timestamp, status: 'complete', source: 'cursor',
    processBlocks: paths.map((path, index) => ({
      kind: 'tool' as const, id: `${id}:edit:${index}`, toolName: 'edit_file', toolKind: 'edit' as const, status: 'done' as const, summary: path
    }))
  }
}

describe('review scope path helpers', () => {
  it('normalizes separators, strips the workspace prefix and ./', () => {
    expect(normalizeReviewPath(`${workspace}/src/a.ts`, workspace)).toBe('src/a.ts')
    expect(normalizeReviewPath('.\\src\\b.ts', workspace)).toBe('src/b.ts')
    expect(normalizeReviewPath('/other/root/c.ts', workspace)).toBe('/other/root/c.ts')
  })

  it('matches by path-segment suffix so nested workspaces still line up with repo-relative paths', () => {
    expect(reviewPathsMatch('packages/app/src/a.ts', 'src/a.ts')).toBe(true)
    expect(reviewPathsMatch('src/a.ts', 'src/b.ts')).toBe(false)
    expect(reviewPathsMatch('a.ts', 'src/a.ts')).toBe(true)
    expect(reviewPathsMatch('other/a.ts', 'src/a.ts')).toBe(false)
  })

  it('reads the file path from summary first and falls back to known input keys, skipping command lines', () => {
    expect(processBlockPath({ kind: 'tool', id: '1', toolName: 'edit', toolKind: 'edit', status: 'done', summary: 'src/x.ts' })).toBe('src/x.ts')
    expect(processBlockPath({ kind: 'tool', id: '2', toolName: 'write', toolKind: 'write', status: 'done', input: { target_file: 'docs/y.md' } })).toBe('docs/y.md')
    expect(processBlockPath({ kind: 'tool', id: '3', toolName: 'shell', toolKind: 'command', status: 'done', summary: 'npm test --run' })).toBeUndefined()
  })
})

describe('turn scope', () => {
  it('collects edit / write paths after the latest delivered user message, including the live process', () => {
    const entries: ConversationEntry[] = [
      user('u1', 1, 2),
      reply('r1', 3, [`${workspace}/src/old.ts`]),
      user('u2', 10, 11),
      reply('r2', 12, [`${workspace}/src/new.ts`, 'src/new.ts']),
      user('u3', 20) // 排队未投递：不夺走上一轮
    ]
    expect(latestDeliveredUserIndex(entries)).toBe(2)
    const paths = turnMutatedPaths(entries, {
      turn: 'live', startedAt: 13, updatedAt: 14,
      blocks: [
        { kind: 'tool', id: 'live-write', toolName: 'write', toolKind: 'write', status: 'running', summary: `${workspace}/src/live.ts` },
        { kind: 'tool', id: 'live-read', toolName: 'read_file', toolKind: 'read', status: 'done', summary: `${workspace}/src/ignored.ts` }
      ]
    }, workspace)
    expect(paths).toEqual(['src/new.ts', 'src/live.ts'])
  })

  it('filters a summary down to touched files and recomputes totals', () => {
    const summary: WorkspaceReviewSummary = {
      state: 'ready', scope: 'uncommitted', workspaceName: 'demo', revision: 'r1', updatedAt: 1,
      additions: 30, deletions: 12,
      files: [
        { path: 'src/new.ts', status: 'modified', staged: false, unstaged: true, additions: 10, deletions: 2 },
        { path: 'src/other.ts', status: 'modified', staged: false, unstaged: true, additions: 20, deletions: 10 }
      ]
    }
    const filtered = filterSummaryToPaths(summary, ['src/new.ts'])
    expect(filtered.files.map((file) => file.path)).toEqual(['src/new.ts'])
    expect(filtered).toMatchObject({ additions: 10, deletions: 2, state: 'ready' })
    expect(filterSummaryToPaths(summary, [])).toMatchObject({ state: 'clean', files: [] })
  })
})
