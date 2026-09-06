import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildHunkPatch,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainV2,
  parseUnifiedDiff,
  WorkspaceReviewReader
} from '../src/infrastructure/git/workspace-review-reader'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' })
}

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

  it('parses name-status records including renames as committed branch changes', () => {
    const value = ['M', 'src/app.ts', 'A', 'src/new.ts', 'R100', 'old.ts', 'renamed.ts', 'D', 'gone.ts', ''].join('\0')
    expect(parseNameStatusZ(value)).toEqual([
      { path: 'src/app.ts', status: 'modified', staged: false, unstaged: false, committed: true },
      { path: 'src/new.ts', status: 'added', staged: false, unstaged: false, committed: true },
      { path: 'renamed.ts', previousPath: 'old.ts', status: 'renamed', staged: false, unstaged: false, committed: true },
      { path: 'gone.ts', status: 'deleted', staged: false, unstaged: false, committed: true }
    ])
  })

  it('cuts a single hunk out of a unified diff by its exact header and rejects stale headers', () => {
    const raw = [
      'diff --git a/a.ts b/a.ts',
      'index 1111..2222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      '-one',
      '+ONE',
      ' two',
      '@@ -10,2 +10,2 @@',
      ' ten',
      '-eleven',
      '+ELEVEN',
      ''
    ].join('\n')
    expect(buildHunkPatch(raw, '@@ -10,2 +10,2 @@')).toBe([
      'diff --git a/a.ts b/a.ts',
      'index 1111..2222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,2 +10,2 @@',
      ' ten',
      '-eleven',
      '+ELEVEN',
      ''
    ].join('\n'))
    expect(buildHunkPatch(raw, '@@ -99,1 +99,1 @@')).toBeUndefined()
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
    // 夹具断言字节级内容；本机全局 core.autocrlf=true（Windows 常见）会让 checkout 写回 CRLF。
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root })
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

  it('reports the head commit and branch when the worktree is clean', async () => {
    const root = repository()
    const reader = new WorkspaceReviewReader(() => root)
    const summary = await reader.summary()
    expect(summary.state).toBe('clean')
    expect(summary.scope).toBe('uncommitted')
    expect(summary.headCommit).toMatchObject({ subject: 'initial' })
    expect(summary.headCommit?.short).toMatch(/^[0-9a-f]{7,}$/)
    expect(summary.branch?.current).toBeTruthy()
  })

  it('branch scope compares against the merge-base and merges committed with uncommitted changes', async () => {
    const root = repository()
    git(root, 'branch', '-M', 'main')
    git(root, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(root, 'feature.ts'), 'export const feature = true\n')
    git(root, 'add', 'feature.ts')
    git(root, 'commit', '-qm', 'add feature')
    writeFileSync(join(root, 'app.ts'), 'const value = 2\n')
    const reader = new WorkspaceReviewReader(() => root)

    const uncommitted = await reader.summary({ scope: 'uncommitted' })
    expect(uncommitted.files.map((file) => file.path)).toEqual(['app.ts'])

    const branch = await reader.summary({ scope: 'branch' })
    expect(branch.scope).toBe('branch')
    expect(branch.branch).toMatchObject({ current: 'feature', base: 'main' })
    expect(branch.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'feature.ts', status: 'added', committed: true, additions: 1 }),
      expect.objectContaining({ path: 'app.ts', status: 'modified', committed: false, unstaged: true, additions: 1, deletions: 1 })
    ]))
    const diff = await reader.fileDiff({ path: 'feature.ts', scope: 'branch' })
    expect(diff.state).toBe('ready')
    expect(diff.hunks[0]?.lines).toEqual([expect.objectContaining({ kind: 'addition', text: 'export const feature = true' })])
    // uncommitted 范围下已提交文件没有待审查差异。
    await expect(reader.fileDiff({ path: 'feature.ts' })).resolves.toMatchObject({ state: 'missing' })

    git(root, 'checkout', '-q', 'main')
    const onBase = await reader.summary({ scope: 'branch' })
    expect(onBase.branch?.onBase).toBe(true)
    expect(onBase.detail).toContain('基线分支')
  })

  it('stages, unstages and reverts whole files, sending untracked files to the trash port', async () => {
    const root = repository()
    const trashed: string[] = []
    const reader = new WorkspaceReviewReader(() => root, { trashItem: async (path) => { trashed.push(path); rmSync(path) } })
    writeFileSync(join(root, 'app.ts'), 'const value = 2\n')
    writeFileSync(join(root, 'notes.md'), 'draft\n')

    await expect(reader.apply({ path: 'app.ts', action: 'stage' })).resolves.toMatchObject({ ok: true })
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('app.ts')
    await expect(reader.apply({ path: 'app.ts', action: 'unstage' })).resolves.toMatchObject({ ok: true })
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('')
    await expect(reader.apply({ path: 'app.ts', action: 'revert' })).resolves.toMatchObject({ ok: true })
    expect(readFileSync(join(root, 'app.ts'), 'utf8')).toBe('const value = 1\n')

    await expect(reader.apply({ path: 'notes.md', action: 'revert' })).resolves.toMatchObject({ ok: true, message: expect.stringContaining('回收站') })
    expect(trashed).toEqual([join(realpathSync(root), 'notes.md')])
    expect(existsSync(join(root, 'notes.md'))).toBe(false)
    await expect(reader.apply({ path: 'notes.md', action: 'revert' })).resolves.toMatchObject({ ok: false, message: expect.stringContaining('请刷新') })
    await expect(reader.apply({ path: '../escape.ts', action: 'stage' })).resolves.toMatchObject({ ok: false })
  })

  it('stages and reverts a single hunk by header, and refuses when the file is partially staged', async () => {
    const root = repository()
    writeFileSync(join(root, 'app.ts'), Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') + '\n')
    git(root, 'add', 'app.ts')
    git(root, 'commit', '-qm', 'thirty lines')
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
    lines[1] = 'line 2 changed'
    lines[27] = 'line 28 changed'
    writeFileSync(join(root, 'app.ts'), lines.join('\n') + '\n')
    const reader = new WorkspaceReviewReader(() => root)
    const diff = await reader.fileDiff({ path: 'app.ts' })
    expect(diff.hunks).toHaveLength(2)
    const [first, second] = diff.hunks

    await expect(reader.apply({ path: 'app.ts', action: 'stage', hunkHeader: first!.header })).resolves.toMatchObject({ ok: true })
    expect(git(root, 'diff', '--cached').trim()).toContain('+line 2 changed')
    expect(git(root, 'diff', '--cached').trim()).not.toContain('line 28 changed')
    // 现在文件同时有已暂存与未暂存改动：按块操作拒绝，不错位。
    await expect(reader.apply({ path: 'app.ts', action: 'revert', hunkHeader: second!.header })).resolves.toMatchObject({ ok: false, message: expect.stringContaining('错位') })
    await expect(reader.apply({ path: 'app.ts', action: 'unstage' })).resolves.toMatchObject({ ok: true })
    await expect(reader.apply({ path: 'app.ts', action: 'revert', hunkHeader: second!.header })).resolves.toMatchObject({ ok: true })
    const content = readFileSync(join(root, 'app.ts'), 'utf8')
    expect(content).toContain('line 2 changed')
    expect(content).not.toContain('line 28 changed')
    await expect(reader.apply({ path: 'app.ts', action: 'stage', hunkHeader: '@@ -999,1 +999,1 @@' })).resolves.toMatchObject({ ok: false, message: expect.stringContaining('已变化') })
  })

  it('resolves workspace files for reveal / open and rejects escapes', async () => {
    const root = repository()
    const reader = new WorkspaceReviewReader(() => root)
    await expect(reader.resolveWorkspaceFile('app.ts')).resolves.toBe(join(realpathSync(root), 'app.ts'))
    await expect(reader.resolveWorkspaceFile('../x')).rejects.toThrow('超出当前工作区')
    await expect(reader.resolveWorkspaceFile('/etc/hosts')).rejects.toThrow('文件路径无效')
  })
})
