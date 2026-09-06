// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceReviewFileDiff, WorkspaceReviewSummary } from '../src/domain/workspace-review'
import { buildFileQuote, buildHunkQuote, ReviewPanel, splitPath } from '../src/renderer/src/inspector/ReviewPanel'

const hunk: WorkspaceReviewFileDiff['hunks'][number] = {
  header: '@@ -10,3 +10,3 @@ function login()',
  skippedBefore: 9,
  lines: [
    { kind: 'context', text: 'const theme = useTheme()', oldLine: 10, newLine: 10 },
    { kind: 'deletion', text: 'const color = theme.light', oldLine: 11 },
    { kind: 'addition', text: 'const color = theme.dark', newLine: 11 },
    { kind: 'context', text: 'return color', oldLine: 12, newLine: 12 }
  ]
}

function summaryOf(scope: 'uncommitted' | 'branch', revision: string): WorkspaceReviewSummary {
  return {
    state: 'ready', scope, workspaceName: 'demo', revision, updatedAt: 1, additions: 6, deletions: 2, liveUpdates: true,
    branch: { current: 'feature/dark', base: 'main' },
    files: [
      { path: 'src/login.tsx', status: 'modified', staged: false, unstaged: true, additions: 4, deletions: 1 },
      { path: 'src/theme.ts', status: 'modified', staged: true, unstaged: false, additions: 2, deletions: 1 },
      ...(scope === 'branch' ? [{ path: 'docs/dark.md', status: 'added' as const, staged: false, unstaged: false, committed: true, additions: 12, deletions: 0 }] : [])
    ]
  }
}

interface ApiMock {
  getWorkspaceReview: ReturnType<typeof vi.fn>
  getWorkspaceReviewFile: ReturnType<typeof vi.fn>
  applyWorkspaceReviewAction: ReturnType<typeof vi.fn>
  openWorkspaceFile: ReturnType<typeof vi.fn>
  revealWorkspaceFile: ReturnType<typeof vi.fn>
  onWorkspaceReviewChanged: ReturnType<typeof vi.fn>
  fireChange: () => void
}

function installApi(): ApiMock {
  let revision = 1
  let changeListener: (() => void) | undefined
  const api: ApiMock = {
    getWorkspaceReview: vi.fn(async (input?: { scope?: 'uncommitted' | 'branch' }) => summaryOf(input?.scope ?? 'uncommitted', `rev-${revision}`)),
    getWorkspaceReviewFile: vi.fn(async ({ path }: { path: string }) => ({ state: 'ready', path, truncated: false, hunks: [hunk] })),
    applyWorkspaceReviewAction: vi.fn(async () => { revision += 1; return { ok: true, message: '已撤销 src/login.tsx 的改动' } }),
    openWorkspaceFile: vi.fn(async () => ({ ok: true, method: 'editor' })),
    revealWorkspaceFile: vi.fn(async () => true),
    onWorkspaceReviewChanged: vi.fn((listener: () => void) => { changeListener = listener; return () => { changeListener = undefined } }),
    fireChange: () => { revision += 1; changeListener?.() }
  }
  Object.defineProperty(window, 'qingtianDesktop', { configurable: true, value: api })
  return api
}

describe('ReviewPanel', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    localStorage.clear()
  })

  it('shows files with branch info, filters the turn scope by touched paths and re-fetches on scope switch', async () => {
    const api = installApi()
    const root = createRoot(container)
    await act(async () => root.render(<ReviewPanel workspaceKey="ws" turnPaths={['src/login.tsx']} />))
    expect(container.textContent).toContain('src/')
    expect(container.textContent).toContain('login.tsx')
    expect(container.textContent).toContain('theme.ts')
    expect(container.textContent).toContain('feature/dark → main')
    expect(container.textContent).toContain('实时')
    expect(container.textContent).toContain('2 个文件')
    // 首个文件默认展开并读取差异；字级高亮只标出变化的 token。
    expect(api.getWorkspaceReviewFile).toHaveBeenCalledWith({ path: 'src/login.tsx', scope: 'uncommitted' })
    const marks = Array.from(container.querySelectorAll('.review-line mark')).map((mark) => mark.textContent)
    expect(marks).toEqual(['light', 'dark'])
    // 已暂存文件显示状态标签。
    expect(container.textContent).toContain('已暂存')

    const scopeButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.inspector-review__scope > button'))
    expect(scopeButtons.map((button) => button.textContent)).toEqual(['未提交', '本轮1', '分支'])
    await act(async () => scopeButtons[1]!.click())
    expect(container.textContent).toContain('login.tsx')
    expect(container.textContent).not.toContain('theme.ts')
    expect(container.textContent).toContain('1 个文件')
    expect(localStorage.getItem('qingtian-team.inspector:review-scope')).toBe('turn')

    await act(async () => scopeButtons[2]!.click())
    expect(api.getWorkspaceReview).toHaveBeenLastCalledWith({ scope: 'branch' })
    expect(container.textContent).toContain('dark.md')
    expect(container.textContent).toContain('已提交')
    // 分支范围只读：没有 Git 动作按钮。
    expect(container.querySelector('[aria-label="撤销 src/login.tsx"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('reloads when the main process pushes a change signal and re-reads expanded diffs on a new revision', async () => {
    const api = installApi()
    const root = createRoot(container)
    await act(async () => root.render(<ReviewPanel workspaceKey="ws" turnPaths={[]} />))
    const before = api.getWorkspaceReview.mock.calls.length
    const diffCallsBefore = api.getWorkspaceReviewFile.mock.calls.length
    await act(async () => api.fireChange())
    expect(api.getWorkspaceReview.mock.calls.length).toBeGreaterThan(before)
    expect(api.getWorkspaceReviewFile.mock.calls.length).toBeGreaterThan(diffCallsBefore)
    await act(async () => root.unmount())
    expect(api.onWorkspaceReviewChanged).toHaveBeenCalledTimes(1)
  })

  it('quotes a hunk into the composer and only reverts after explicit confirmation', async () => {
    const api = installApi()
    const onQuote = vi.fn()
    const root = createRoot(container)
    await act(async () => root.render(<ReviewPanel workspaceKey="ws" turnPaths={[]} onQuote={onQuote} />))

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="反馈这段差异给 Agent"]')!.click())
    expect(onQuote).toHaveBeenCalledTimes(1)
    const quoted = onQuote.mock.calls[0]![0] as string
    expect(quoted).toContain('`src/login.tsx` L10–L12')
    expect(quoted).toContain('```diff')
    expect(quoted).toContain('-const color = theme.light')
    expect(quoted).toContain('+const color = theme.dark')

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="撤销 src/login.tsx"]')!.click())
    expect(api.applyWorkspaceReviewAction).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('恢复到 HEAD 版本')
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '取消')!.click())
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(api.applyWorkspaceReviewAction).not.toHaveBeenCalled()

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="撤销 src/login.tsx"]')!.click())
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '确认撤销')!.click())
    expect(api.applyWorkspaceReviewAction).toHaveBeenCalledWith({ path: 'src/login.tsx', action: 'revert' })
    expect(container.textContent).toContain('已撤销 src/login.tsx 的改动')

    // 纯未暂存文件的 hunk 可以直接暂存（无需确认）；已暂存文件不提供 hunk 暂存。
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂存代码块 L10"]')!.click())
    expect(api.applyWorkspaceReviewAction).toHaveBeenLastCalledWith({ path: 'src/login.tsx', action: 'stage', hunkHeader: hunk.header })
    await act(async () => root.unmount())
  })

  it('keeps the expanded diff on screen while a new revision is being read instead of flashing a skeleton', async () => {
    const api = installApi()
    let release: ((diff: WorkspaceReviewFileDiff) => void) | undefined
    api.getWorkspaceReviewFile.mockImplementation(async ({ path }: { path: string }) => {
      // 第二次读取挂起：模拟 git diff 尚未返回的窗口。
      if (api.getWorkspaceReviewFile.mock.calls.length > 1) {
        return new Promise<WorkspaceReviewFileDiff>((done) => { release = done })
      }
      return { state: 'ready', path, truncated: false, hunks: [hunk] }
    })
    const root = createRoot(container)
    await act(async () => root.render(<ReviewPanel workspaceKey="ws" turnPaths={[]} />))
    expect(container.querySelector('.review-line')).toBeTruthy()
    const lineBefore = container.querySelector('.review-line')

    await act(async () => api.fireChange())
    // 新 revision 已到、差异还在路上：旧差异原样留在屏幕上，没有骨架屏。
    expect(container.querySelector('.review-file__loading')).toBeNull()
    expect(container.querySelector('.review-line')).toBe(lineBefore)
    expect(release).toBeTypeOf('function')

    const replaced: WorkspaceReviewFileDiff = {
      state: 'ready', path: 'src/login.tsx', truncated: false,
      hunks: [{ ...hunk, lines: [{ kind: 'addition', text: 'const color = theme.midnight', newLine: 11 }] }]
    }
    await act(async () => { release!(replaced) })
    expect(container.textContent).toContain('theme.midnight')
    expect(container.textContent).not.toContain('theme.light')

    // 收起状态的文件不会沿用旧差异：展开时重新读取（骨架屏出现在首次展开）。
    const heads = Array.from(container.querySelectorAll<HTMLButtonElement>('.review-file__head'))
    const callsBefore = api.getWorkspaceReviewFile.mock.calls.length
    await act(async () => heads[1]!.click())
    expect(api.getWorkspaceReviewFile.mock.calls.length).toBe(callsBefore + 1)
    expect(container.querySelector('.review-file__loading')).toBeTruthy()
    await act(async () => root.unmount())
  })

  it('pauses polling while hidden, defers pushed changes and catches up once visible again', async () => {
    vi.useFakeTimers()
    try {
      const api = installApi()
      const root = createRoot(container)
      const render = (paused: boolean): Promise<void> => act(async () => root.render(
        <ReviewPanel workspaceKey="ws" turnPaths={[]} paused={paused} pollIntervalMs={{ live: 1_000, fallback: 500 }} />
      ))
      await render(false)
      const afterMount = api.getWorkspaceReview.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(1_050) })
      expect(api.getWorkspaceReview.mock.calls.length).toBe(afterMount + 1)

      await render(true)
      const whenPaused = api.getWorkspaceReview.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(api.getWorkspaceReview.mock.calls.length).toBe(whenPaused)
      // 收起期间的推送只记标记，不发请求。
      await act(async () => api.fireChange())
      expect(api.getWorkspaceReview.mock.calls.length).toBe(whenPaused)

      // 展开：补拉一次，并恢复轮询。
      await render(false)
      expect(api.getWorkspaceReview.mock.calls.length).toBe(whenPaused + 1)
      await act(async () => { await vi.advanceTimersByTimeAsync(1_050) })
      expect(api.getWorkspaceReview.mock.calls.length).toBe(whenPaused + 2)
      await act(async () => root.unmount())
    } finally {
      vi.useRealTimers()
    }
  })

  it('splits paths so the extension survives truncation', () => {
    expect(splitPath('src/renderer/workspace-inspector.css')).toEqual({ dir: 'src/renderer/', stem: 'workspace-inspector', ext: '.css' })
    expect(splitPath('README')).toEqual({ dir: '', stem: 'README', ext: '' })
    expect(splitPath('.gitignore')).toEqual({ dir: '', stem: '.gitignore', ext: '' })
    expect(splitPath('docs/notes.')).toEqual({ dir: 'docs/', stem: 'notes.', ext: '' })
    expect(splitPath('tests/inspector-shell.test.tsx')).toEqual({ dir: 'tests/', stem: 'inspector-shell.test', ext: '.tsx' })
  })

  it('builds plain-text quotes for files and hunks', () => {
    expect(buildFileQuote({ path: 'src/a.ts', status: 'modified', staged: false, unstaged: true, additions: 3, deletions: 1 })).toBe('> 关于 `src/a.ts`（已修改 · +3 −1）：\n\n')
    expect(buildHunkQuote('src/a.ts', hunk)).toContain(hunk.header)
  })
})
