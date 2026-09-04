import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseNumstatZ,
  parsePorcelainV2,
  parseUnifiedDiff,
  WorkspaceReviewReader
} from '../src/infrastructure/git/workspace-review-reader'

describe('workspace review parsers', () => {
  it('parses normal, renamed, untracked and conflicted porcelain v2 records', () => {
    const input = [
      '1 .M N... 100644 100644 100644 aaaa bbbb src/app.ts',
      '2 R. N... 100644 100644 100644 aaaa bbbb R100 src/new name.ts',
      'src/old name.ts',
      '? notes.txt',
      'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.ts',
      ''
    ].join('\0')
    expect(parsePorcelainV2(input)).toEqual([
      { path: 'src/app.ts', status: 'modified', staged: false, unstaged: true },
      { path: 'src/new name.ts', previousPath: 'src/old name.ts', status: 'renamed', staged: true, unstaged: false },
      { path: 'notes.txt', status: 'untracked', staged: false, unstaged: true },
      { path: 'conflict.ts', status: 'conflicted', staged: true, unstaged: true }
    ])
  })

  it('parses numstat including rename and binary records', () => {
    const value = ['4\t2\tsrc/app.ts', '-\t-\timage.png', '0\t0\t', 'old.ts', 'new.ts', ''].join('\0')
    expect(Object.fromEntries(parseNumstatZ(value))).toEqual({
      'src/app.ts': { additions: 4, deletions: 2, binary: false },
      'image.png': { additions: undefined, deletions: undefined, binary: true },
      'new.ts': { additions: 0, deletions: 0, binary: false }
    })
  })

  it('keeps line numbers and unchanged gaps when parsing unified diff hunks', () => {
    const parsed = parseUnifiedDiff([
      'diff --git a/a.ts b/a.ts',
      '@@ -10,3 +10,3 @@',
      ' before',
      '-old',
      '+new',
      ' after',
      '@@ -30,2 +30,3 @@',
      ' context',
      '+extra',
      ''
    ].join('\n'))
    expect(parsed.truncated).toBe(false)
    expect(parsed.hunks[0]).toMatchObject({ skippedBefore: 9 })
    expect(parsed.hunks[0]?.header).toBe('@@ -10,3 +10,3 @@')
    expect(parsed.hunks[0]?.lines).toEqual([
      { kind: 'context', text: 'before', oldLine: 10, newLine: 10 },
      { kind: 'deletion', text: 'old', oldLine: 11 },
      { kind: 'addition', text: 'new', newLine: 11 },
      { kind: 'context', text: 'after', oldLine: 12, newLine: 12 }
    ])
    expect(parsed.hunks[1]).toMatchObject({ skippedBefore: 17 })
  })
})

describe('WorkspaceReviewReader', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function repository(): string {
    const root = mkdtempSync(join(tmpdir(), 'sg-review-'))
    roots.push(root)
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, 'app.ts'), 'const value = 1\n')
    execFileSync('git', ['add', 'app.ts'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: root })
    return root
  }

  it('returns real worktree totals and a one-file diff without touching the index', async () => {
    const root = repository()
    writeFileSync(join(root, 'app.ts'), 'const value = 2\nconst added = true\n')
    const reader = new WorkspaceReviewReader(() => root)
    const summary = await reader.summary()
    expect(summary).toMatchObject({ state: 'ready', additions: 2, deletions: 1 })
    expect(summary.files).toEqual([
      expect.objectContaining({ path: 'app.ts', status: 'modified', staged: false, unstaged: true, additions: 2, deletions: 1 })
    ])

    const diff = await reader.fileDiff({ path: 'app.ts' })
    expect(diff.state).toBe('ready')
    expect(diff.hunks[0]?.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'deletion', text: 'const value = 1' }),
      expect.objectContaining({ kind: 'addition', text: 'const value = 2' }),
      expect.objectContaining({ kind: 'addition', text: 'const added = true' })
    ]))
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' })).toBe('')
    await expect(reader.fileDiff({ path: '.git/config' })).resolves.toMatchObject({
      state: 'missing', detail: '文件已无待审查变更'
    })
  })

  it('changes the summary revision when content changes but line counts stay equal', async () => {
    const root = repository()
    const reader = new WorkspaceReviewReader(() => root)
    writeFileSync(join(root, 'app.ts'), 'const value = 2\n')
    const first = await reader.summary()
    await new Promise((resolve) => setTimeout(resolve, 5))
    writeFileSync(join(root, 'app.ts'), 'const value = 3\n')
    const second = await reader.summary()
    expect(second.revision).not.toBe(first.revision)
    expect(second).toMatchObject({ additions: 1, deletions: 1 })
  })

  it('includes an untracked text file as additions and rejects paths outside the repository', async () => {
    const root = repository()
    writeFileSync(join(root, 'notes.md'), 'one\ntwo\n')
    const reader = new WorkspaceReviewReader(() => root)
    const summary = await reader.summary()
    expect(summary.files).toContainEqual(expect.objectContaining({
      path: 'notes.md', status: 'untracked', additions: 2, deletions: 0
    }))
    await expect(reader.fileDiff({ path: '../outside.txt' })).rejects.toThrow('超出当前工作区')
  })

  it('reports a non-git workspace as an explicit state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sg-review-plain-'))
    roots.push(root)
    await expect(new WorkspaceReviewReader(() => root).summary()).resolves.toMatchObject({ state: 'not_git' })
  })

  it('scopes a nested workspace and its file reads to that subtree', async () => {
    const root = repository()
    const workspace = join(root, 'packages', 'app')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'inside.ts'), 'inside\n')
    writeFileSync(join(root, 'outside.ts'), 'outside\n')
    const reader = new WorkspaceReviewReader(() => workspace)
    const summary = await reader.summary()
    expect(summary.files.map((file) => file.path)).toEqual(['packages/app/inside.ts'])
    await expect(reader.fileDiff({ path: 'outside.ts' })).rejects.toThrow('超出当前工作区')
  })
})
