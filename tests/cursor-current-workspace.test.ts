import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, it, expect, vi } from 'vitest'
import { CursorCdpSessionCreator, CURRENT_WORKSPACE_EXPRESSION } from '../src/infrastructure/cursor/cursor-cdp-session-creator'

const target = { id: 'window-1', type: 'page', title: '无关标题', url: 'file:///workbench.html', webSocketDebuggerUrl: 'ws://localhost/window-1' }

/** VS Code `URI.path` 形态：恒以 `/` 开头、`/` 分隔（Windows 下为 `/C:/Users/...`），与原生路径不同。 */
function uriPathOf(nativePath: string): string {
  const posix = nativePath.replace(/\\/g, '/')
  return posix.startsWith('/') ? posix : `/${posix}`
}

describe('Cursor 当前窗口工作区检测', () => {
  it('每拍重新枚举，A→重载→B→空窗口→关闭，不沿用旧路径', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sg-workspace-'))
    mkdirSync(join(root, 'A')); mkdirSync(join(root, 'B'))
    const fetchTargets = vi.fn().mockResolvedValue([target])
    let config: unknown = { workspace: { id: 'a', uri: { scheme: 'file', path: uriPathOf(join(root, 'A')) } } }
    const evaluate = vi.fn(async (_socket: string, expression: string) => runInNewContext(expression, { window: { vscode: { context: { configuration: () => config } } } }))
    const reader = new CursorCdpSessionCreator({ fetchTargets, evaluate })
    try {
      expect((await reader.detectCurrentWorkspace()).workspace?.name).toBe('A')
      config = undefined
      const missing = await reader.detectCurrentWorkspace()
      expect(missing.state).toBe('unavailable')
      expect(missing.workspace).toBeUndefined()
      config = { workspace: { id: 'b', uri: { scheme: 'file', path: uriPathOf(join(root, 'B')) } } }
      fetchTargets.mockResolvedValue([{ ...target, id: 'window-2', webSocketDebuggerUrl: 'ws://localhost/window-2' }])
      expect(await reader.detectCurrentWorkspace()).toMatchObject({ state: 'detected', source: 'cursor-window', workspace: { name: 'B', cursorWorkspaceId: 'b' } })
      expect(evaluate.mock.calls.at(-1)?.[0]).toBe('ws://localhost/window-2')
      config = {}
      expect((await reader.detectCurrentWorkspace()).detail).toBe('Cursor 未打开工作区')
      fetchTargets.mockResolvedValue([])
      expect((await reader.detectCurrentWorkspace()).workspace).toBeUndefined()
      expect(fetchTargets).toHaveBeenCalledTimes(5)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('多窗口、连接错误、远程、多根及失效目录均不猜项目', async () => {
    const fetchTargets = vi.fn().mockResolvedValue([target, { ...target, id: 'other' }])
    const evaluate = vi.fn()
    const reader = new CursorCdpSessionCreator({ fetchTargets, evaluate })
    expect((await reader.detectCurrentWorkspace()).state).toBe('ambiguous')
    expect(evaluate).not.toHaveBeenCalled()
    fetchTargets.mockRejectedValueOnce(new Error('connection refused'))
    expect((await reader.detectCurrentWorkspace()).state).toBe('unavailable')
    fetchTargets.mockResolvedValue([target])
    for (const config of [
      { remoteAuthority: 'ssh-host', workspace: {} },
      { workspace: { configPath: { scheme: 'file', path: '/test.code-workspace' } } },
      { workspace: { uri: { scheme: 'file', path: '/missing-project-for-test-929991' } } }
    ]) {
      evaluate.mockImplementation(async () => runInNewContext(CURRENT_WORKSPACE_EXPRESSION, { window: { vscode: { context: { configuration: () => config } } } }))
      const missing = await reader.detectCurrentWorkspace()
      expect(missing.state).toBe('unavailable')
      expect(missing.workspace).toBeUndefined()
    }
  })
})
