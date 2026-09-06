import { describe, expect, it, vi } from 'vitest'
import { isWatchRelevantPath, WorkspaceReviewWatcher } from '../src/infrastructure/git/workspace-review-watcher'

type Listener = (eventType: string, filename: string | Buffer | null) => void

function fakeWatch() {
  const watchers: Array<{ root: string; listener: Listener; closed: boolean; errorHandler?: (error: Error) => void }> = []
  const watch = (root: string, listener: Listener) => {
    const entry = { root, listener, closed: false, errorHandler: undefined as ((error: Error) => void) | undefined }
    watchers.push(entry)
    return {
      close: () => { entry.closed = true },
      on: (event: string, handler: (error: Error) => void) => {
        if (event === 'error') entry.errorHandler = handler
        return undefined as never
      }
    }
  }
  return { watchers, watch }
}

describe('isWatchRelevantPath', () => {
  it('ignores dependency and git object churn but keeps index, HEAD and refs', () => {
    expect(isWatchRelevantPath('src/app.ts')).toBe(true)
    expect(isWatchRelevantPath('node_modules/react/index.js')).toBe(false)
    expect(isWatchRelevantPath('packages/a/node_modules/x.js')).toBe(false)
    expect(isWatchRelevantPath('.git/objects/ab/cdef')).toBe(false)
    expect(isWatchRelevantPath('.git/index.lock')).toBe(false)
    expect(isWatchRelevantPath('.git/index')).toBe(true)
    expect(isWatchRelevantPath('.git/HEAD')).toBe(true)
    expect(isWatchRelevantPath('.git/refs/heads/main')).toBe(true)
    expect(isWatchRelevantPath('src/.DS_Store')).toBe(false)
    expect(isWatchRelevantPath('')).toBe(true)
  })
})

describe('WorkspaceReviewWatcher', () => {
  it('debounces bursts into one change signal and drops ignored paths', async () => {
    vi.useFakeTimers()
    try {
      const { watchers, watch } = fakeWatch()
      const onChange = vi.fn()
      const onStatus = vi.fn()
      const watcher = new WorkspaceReviewWatcher({
        workspacePath: () => '/repo/app',
        onChange,
        onStatus,
        debounceMs: 100,
        watch,
        resolveRoot: async () => '/repo'
      })
      watcher.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(watchers).toHaveLength(1)
      expect(watchers[0]!.root).toBe('/repo')
      expect(watcher.active).toBe(true)
      expect(onStatus).toHaveBeenCalledWith(true)

      const listener = watchers[0]!.listener
      listener('change', 'node_modules/x.js')
      listener('change', '.git/objects/aa/bb')
      await vi.advanceTimersByTimeAsync(200)
      expect(onChange).not.toHaveBeenCalled()

      listener('change', 'src/a.ts')
      listener('change', 'src/b.ts')
      listener('rename', '.git/index')
      await vi.advanceTimersByTimeAsync(99)
      expect(onChange).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2)
      expect(onChange).toHaveBeenCalledTimes(1)

      watcher.stop()
      expect(watchers[0]!.closed).toBe(true)
      expect(watcher.active).toBe(false)
      listener('change', 'src/c.ts')
      await vi.advanceTimersByTimeAsync(200)
      expect(onChange).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rebinds when the workspace path changes and stays inactive without a workspace', async () => {
    const { watchers, watch } = fakeWatch()
    let path: string | undefined
    const watcher = new WorkspaceReviewWatcher({
      workspacePath: () => path,
      onChange: () => {},
      watch,
      resolveRoot: async (workspace) => workspace
    })
    watcher.start()
    await watcher.refresh()
    expect(watchers).toHaveLength(0)
    expect(watcher.active).toBe(false)

    path = '/repo-a'
    await watcher.refresh()
    expect(watchers.map((entry) => entry.root)).toEqual(['/repo-a'])
    await watcher.refresh()
    expect(watchers).toHaveLength(1)

    path = '/repo-b'
    await watcher.refresh()
    expect(watchers[0]!.closed).toBe(true)
    expect(watchers.map((entry) => entry.root)).toEqual(['/repo-a', '/repo-b'])
    expect(watcher.root).toBe('/repo-b')

    watchers[1]!.errorHandler?.(new Error('EMFILE'))
    expect(watcher.active).toBe(false)
    watcher.stop()
  })

  it('falls back to inactive when the platform refuses recursive watching', async () => {
    const watcher = new WorkspaceReviewWatcher({
      workspacePath: () => '/repo',
      onChange: () => {},
      watch: () => { throw new Error('recursive not supported') },
      resolveRoot: async () => '/repo'
    })
    watcher.start()
    await watcher.refresh()
    expect(watcher.active).toBe(false)
    watcher.stop()
  })
})
