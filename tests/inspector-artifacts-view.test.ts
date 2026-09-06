import { describe, expect, it } from 'vitest'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import type { WorkspaceReviewSummary } from '../src/domain/workspace-review'
import { projectArtifacts, replyImageArtifacts } from '../src/renderer/src/inspector/artifacts-view'

const entries: ConversationEntry[] = [
  {
    id: 'u1', channelId: '2', role: 'user', text: '看图', timestamp: 1, deliveredAt: 2, status: 'complete', source: 'desktop',
    attachments: [
      { id: 'att-1', name: 'shot.png', mimeType: 'image/png', size: 10, path: '/tmp/att/shot.png', previewUrl: 'data:image/png;base64,AAAA' },
      { id: 'att-2', name: 'notes.txt', mimeType: 'text/plain', size: 3 }
    ]
  },
  {
    id: 'r1', channelId: '2', role: 'assistant', timestamp: 3, status: 'complete', source: 'cursor',
    text: '截图如下 ![登录页](/tmp/login.png) 以及远程 ![logo](https://example.com/a.png) 和重复 ![again](/tmp/login.png)'
  }
]

describe('artifacts projection', () => {
  it('extracts local image references from replies, skipping remote links and duplicates', () => {
    const items = replyImageArtifacts(entries[1]!)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'image', source: 'reply', name: '登录页', entryId: 'r1' })
    expect(items[0]!.attachment).toMatchObject({ path: '/tmp/login.png', mimeType: 'image/png', previewUrl: 'sg-image://local/%2Ftmp%2Flogin.png' })
  })

  it('merges reply images, user image attachments and worktree additions, newest conversation item first', () => {
    const summary: WorkspaceReviewSummary = {
      state: 'ready', scope: 'uncommitted', workspaceName: 'demo', revision: 'r', updatedAt: 1, additions: 3, deletions: 0,
      files: [
        { path: 'docs/diagram.png', status: 'untracked', staged: false, unstaged: true },
        { path: 'src/new-module.ts', status: 'added', staged: true, unstaged: false, additions: 3, deletions: 0 },
        { path: 'src/changed.ts', status: 'modified', staged: false, unstaged: true }
      ]
    }
    const view = projectArtifacts(entries, summary, '/Users/me/demo')
    expect(view.images.map((item) => [item.source, item.name])).toEqual([
      ['reply', '登录页'],
      ['user', 'shot.png'],
      ['worktree', 'diagram.png']
    ])
    expect(view.images[2]!.attachment).toMatchObject({ path: '/Users/me/demo/docs/diagram.png', previewUrl: 'sg-image://local/%2FUsers%2Fme%2Fdemo%2Fdocs%2Fdiagram.png' })
    expect(view.files).toEqual([expect.objectContaining({ kind: 'file', relativePath: 'src/new-module.ts', name: 'new-module.ts' })])
  })

  it('returns an empty view without a review summary or images', () => {
    expect(projectArtifacts([], undefined)).toEqual({ images: [], files: [] })
  })
})
