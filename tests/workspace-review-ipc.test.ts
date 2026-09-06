import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceReviewReader } from '../src/infrastructure/git/workspace-review-reader'
import type { WorkspaceReviewWatcher } from '../src/infrastructure/git/workspace-review-watcher'
import { editorFileUrl, registerWorkspaceReviewIpc } from '../src/main/register-workspace-review-ipc'
import { IPC } from '../src/shared/desktop-api'

const { handlers, shell } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  shell: {
    showItemInFolder: vi.fn(),
    openExternal: vi.fn(async () => {}),
    openPath: vi.fn(async () => '')
  }
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name)
  },
  shell
}))
vi.mock('../src/main/ipc-security', () => ({ assertTrustedSender: vi.fn() }))

function fakeReader() {
  return {
    summary: vi.fn(async (options?: { scope?: string }) => ({
      state: 'clean', scope: options?.scope ?? 'uncommitted', workspaceName: 'demo', files: [], additions: 0, deletions: 0, revision: '', updatedAt: 1
    })),
    fileDiff: vi.fn(async ({ path }: { path: string }) => ({ state: 'ready', path, hunks: [], truncated: false })),
    apply: vi.fn(async () => ({ ok: true, message: '已暂存 a.ts' })),
    resolveWorkspaceFile: vi.fn(async (path: string) => `/repo/${path}`)
  }
}

function fakeWatcher(onChange: () => void) {
  return {
    active: false,
    start: vi.fn(function (this: { active: boolean }) { this.active = true }),
    stop: vi.fn(function (this: { active: boolean }) { this.active = false }),
    refresh: vi.fn(async () => {}),
    fire: onChange
  }
}

describe('workspace review IPC', () => {
  it('passes scope through, decorates summaries with the watcher state and pushes change signals', async () => {
    handlers.clear()
    const reader = fakeReader()
    const send = vi.fn()
    const window = { isDestroyed: () => false, webContents: { send } }
    let watcher: ReturnType<typeof fakeWatcher> | undefined
    const listeners: Array<() => void> = []
    const dispose = registerWorkspaceReviewIpc(
      reader as unknown as WorkspaceReviewReader,
      () => window as never,
      {
        watchWorkspace: {
          workspacePath: () => '/repo',
          subscribeWorkspaceChange: (listener) => { listeners.push(listener); return () => {} },
          createWatcher: (onChange) => {
            watcher = fakeWatcher(onChange)
            return watcher as unknown as WorkspaceReviewWatcher
          }
        }
      }
    )
    try {
      expect(watcher!.start).toHaveBeenCalledTimes(1)
      const summary = await handlers.get(IPC.workspaceReviewGet)!({}, { scope: 'branch' }) as { scope: string; liveUpdates: boolean }
      expect(reader.summary).toHaveBeenCalledWith({ scope: 'branch' })
      expect(summary).toMatchObject({ scope: 'branch', liveUpdates: true })
      await handlers.get(IPC.workspaceReviewGet)!({}, { scope: 'bogus' })
      expect(reader.summary).toHaveBeenLastCalledWith({ scope: undefined })

      watcher!.fire()
      expect(send).toHaveBeenCalledWith(IPC.workspaceReviewChanged)

      listeners[0]!()
      expect(watcher!.refresh).toHaveBeenCalledTimes(1)

      await handlers.get(IPC.workspaceReviewFile)!({}, { path: 'a.ts', scope: 'uncommitted' })
      expect(reader.fileDiff).toHaveBeenCalledWith({ path: 'a.ts', scope: 'uncommitted' })
      await expect(handlers.get(IPC.workspaceReviewFile)!({}, { path: '' })).rejects.toThrow('差异文件参数无效')
    } finally {
      dispose()
    }
    expect(watcher!.stop).toHaveBeenCalledTimes(1)
    expect(handlers.size).toBe(0)
  })

  it('validates git actions, notifies after success, and opens files through the editor deep link with a system fallback', async () => {
    handlers.clear()
    const reader = fakeReader()
    const send = vi.fn()
    const window = { isDestroyed: () => false, webContents: { send } }
    const dispose = registerWorkspaceReviewIpc(reader as unknown as WorkspaceReviewReader, () => window as never)
    try {
      const apply = handlers.get(IPC.workspaceReviewApply)!
      await expect(apply({}, { path: 'a.ts', action: 'destroy' })).rejects.toThrow('Git 操作类型无效')
      await apply({}, { path: 'a.ts', action: 'stage', hunkHeader: '@@ -1 +1 @@' })
      expect(reader.apply).toHaveBeenCalledWith({ path: 'a.ts', action: 'stage', hunkHeader: '@@ -1 +1 @@' })
      await apply({}, { path: 'a.ts', action: 'revert', hunkHeader: 'not a header' })
      expect(reader.apply).toHaveBeenLastCalledWith({ path: 'a.ts', action: 'revert' })
      expect(send).toHaveBeenCalledWith(IPC.workspaceReviewChanged)

      await handlers.get(IPC.workspaceReviewReveal)!({}, { path: 'a.ts' })
      expect(shell.showItemInFolder).toHaveBeenCalledWith('/repo/a.ts')

      const open = handlers.get(IPC.workspaceReviewOpen)!
      await expect(open({}, { path: 'src/a b.ts', line: 12 })).resolves.toEqual({ ok: true, method: 'editor' })
      expect(shell.openExternal).toHaveBeenLastCalledWith('cursor://file/repo/src/a%20b.ts:12')

      shell.openExternal.mockRejectedValueOnce(new Error('no handler'))
      await expect(open({}, { path: 'a.ts' })).resolves.toEqual({ ok: true, method: 'system' })
      expect(shell.openPath).toHaveBeenCalledWith('/repo/a.ts')

      shell.openExternal.mockRejectedValueOnce(new Error('no handler'))
      shell.openPath.mockResolvedValueOnce('No application knows how to open this file')
      await expect(open({}, { path: 'a.ts' })).resolves.toMatchObject({ ok: false, message: expect.stringContaining('No application') })
    } finally {
      dispose()
    }
  })

  it('builds editor deep links with URL-style paths on both platforms', () => {
    expect(editorFileUrl('cursor', '/repo/src/a b.ts', 12)).toBe('cursor://file/repo/src/a%20b.ts:12')
    expect(editorFileUrl('cursor', 'C:\\Users\\demo\\repo\\src\\a.ts')).toBe('cursor://file/C:/Users/demo/repo/src/a.ts')
    expect(editorFileUrl('cursor', 'C:\\Users\\demo\\repo\\中文\\a.ts', 3)).toBe('cursor://file/C:/Users/demo/repo/%E4%B8%AD%E6%96%87/a.ts:3')
  })
})
