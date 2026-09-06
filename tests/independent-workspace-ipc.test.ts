import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { registerTeamControlIpc } from '../src/main/register-team-control-ipc'
import { IPC } from '../src/shared/desktop-api'
import { workspaceIdentityOf } from '../src/infrastructure/cursor/workspace-identity'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import { CursorUsageTracker } from '../src/application/cursor-usage-tracker'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({ ipcMain: {
  handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
  removeHandler: (name: string) => handlers.delete(name)
}, dialog: {} }))
vi.mock('../src/main/ipc-security', () => ({ assertTrustedSender: vi.fn() }))

it('创建前确认 Cursor 工程：旧路径不签发身份，新路径传入 configureIndependentWorkspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sg-independent-ipc-'))
  mkdirSync(join(root, 'A')); mkdirSync(join(root, 'B'))
  const a = workspaceIdentityOf(join(root, 'A'))
  const b = workspaceIdentityOf(join(root, 'B'))
  const configure = vi.fn(() => ({ activeWorkspaceId: b.id }))
  const dispose = registerTeamControlIpc(
    { subscribe: () => () => {}, configureIndependentWorkspace: configure } as unknown as Parameters<typeof registerTeamControlIpc>[0],
    { getSnapshot: () => ({ cursorModels: [] }) } as unknown as Parameters<typeof registerTeamControlIpc>[1],
    () => undefined,
    { detectCurrentWorkspace: async () => ({ state: 'detected', workspace: b, candidates: [], detail: 'IDE', observedAt: 1 }) }
  )
  try {
    const create = handlers.get(IPC.teamControlCreateIndependent)!
    await expect(create({}, { workspacePath: a.path, sessions: [{}] })).rejects.toThrow('创建配置仍为「A」')
    expect(configure).not.toHaveBeenCalled()
    await create({}, { workspacePath: b.path, sessions: [{}] })
    expect(configure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: b.id, workspacePath: b.path }))
  } finally { dispose(); rmSync(root, { recursive: true, force: true }) }
})

it('显式结束后补收最终样本再冻结；结束失败不冻结', async () => {
  const ended = emptyTeamControlSnapshot()
  const tracker = new CursorUsageTracker()
  tracker.recordRequestSample({ composerId: 'c', generationId: 'g', used: 1000, occurredAt: 1 })
  const end = vi.fn(() => ended)
  let release!: () => void
  const tail = new Promise<void>((resolve) => { release = resolve })
  const onRunEnded = vi.fn(async (snapshot) => {
    expect(snapshot).toBe(ended)
    await tail
    tracker.recordRequestSample({ composerId: 'c', generationId: 'g', used: 1100, stopped: true, occurredAt: 2 })
    tracker.setCollecting(false)
  })
  const dispose = registerTeamControlIpc(
    { subscribe: () => () => {}, endActiveRun: end } as unknown as Parameters<typeof registerTeamControlIpc>[0],
    {} as Parameters<typeof registerTeamControlIpc>[1], () => undefined,
    { onRunEnded, detectCurrentWorkspace: async () => ({ state: 'unavailable', candidates: [], detail: '测试不检测', observedAt: 1 }) }
  )
  try {
    const finish = handlers.get(IPC.teamControlEndRun)!
    let resolved = false
    const result = Promise.resolve(finish({})).then(() => { resolved = true })
    expect(onRunEnded).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(resolved).toBe(false)
    release(); await result
    const usage = tracker.getSnapshot().c!
    expect(usage.inputTokens).toBe(2100)
    expect(usage.outputTokens).toBeGreaterThan(0)
    expect(usage.ledger?.frozenAt).toBeDefined()
    end.mockImplementation(() => { throw new Error('end failed') })
    await expect(finish({})).rejects.toThrow('end failed')
    expect(onRunEnded).toHaveBeenCalledTimes(1)
  } finally { tracker.dispose(); dispose() }
})
