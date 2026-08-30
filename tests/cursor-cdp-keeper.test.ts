import { describe, expect, it } from 'vitest'
import {
  CursorCdpKeeper,
  type CdpAutoHealEvent
} from '../src/infrastructure/cursor/cursor-cdp-keeper'
import type { CursorCdpRestartResult } from '../src/infrastructure/cursor/cursor-cdp-restart'

interface KeeperFixture {
  keeper: CursorCdpKeeper
  events: CdpAutoHealEvent[]
  restarts: number[]
  restartWorkspaces: Array<string | undefined>
  setRunning: (pid: number, startedAt: string) => void
  setStopped: () => void
  setPortReady: (ready: boolean) => void
  setEnabled: (enabled: boolean) => void
  setWorkspacePath: (path: string | undefined) => void
  advance: (ms: number) => void
}

function fixture(options: { platform?: NodeJS.Platform } = {}): KeeperFixture {
  const platform = options.platform ?? 'darwin'
  let currentTime = 1_000_000
  let running: { pid: number; startedAt: string } | undefined = { pid: 4242, startedAt: 'Tue Aug 25 06:00:00 2026' }
  let portReady = false
  let enabled = true
  let workspacePath: string | undefined = '/workspace/qingtian'
  const events: CdpAutoHealEvent[] = []
  const restarts: number[] = []
  const restartWorkspaces: Array<string | undefined> = []

  const execFileFn = (async (command: string, args: string[]) => {
    if (command === 'powershell.exe') {
      // Windows：一次调用返回 pid + StartTime 压缩 JSON；未运行输出空
      if (!running) return { stdout: '', stderr: '' }
      return { stdout: JSON.stringify({ Id: running.pid, StartTime: running.startedAt }), stderr: '' }
    }
    if (command === 'pgrep') {
      if (!running) {
        const error = new Error('no matching processes') as Error & { code: number }
        error.code = 1
        throw error
      }
      return { stdout: `${running.pid}\n`, stderr: '' }
    }
    if (command === 'ps') return { stdout: `${running?.startedAt ?? ''}\n`, stderr: '' }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }) as never

  const keeper = new CursorCdpKeeper({
    port: 9333,
    isEnabled: () => enabled,
    workspacePath: () => workspacePath,
    emit: (event) => events.push(event),
    restart: (port, restartWorkspacePath) => {
      restarts.push(port)
      restartWorkspaces.push(restartWorkspacePath)
      // 模拟重启：进程指纹更换（新 pid）
      if (running) running = { pid: running.pid + 1, startedAt: 'Tue Aug 25 06:30:00 2026' }
      return Promise.resolve<CursorCdpRestartResult>({ ok: true, message: '已重启' })
    },
    execFileFn,
    fetchFn: () => portReady
      ? Promise.resolve({ status: 200 })
      : Promise.reject(new Error('connect ECONNREFUSED')),
    sleep: (ms) => {
      currentTime += ms
      return Promise.resolve()
    },
    now: () => currentTime,
    platform
  })

  return {
    keeper,
    events,
    restarts,
    restartWorkspaces,
    setRunning: (pid, startedAt) => { running = { pid, startedAt } },
    setStopped: () => { running = undefined },
    setPortReady: (ready) => { portReady = ready },
    setEnabled: (value) => { enabled = value },
    setWorkspacePath: (path) => { workspacePath = path },
    advance: (ms) => { currentTime += ms }
  }
}

describe('CursorCdpKeeper（CDP 端口 auto-heal 看门）', () => {
  it('stays fully silent while the feature is disabled', async () => {
    const { keeper, events, restarts, setEnabled } = fixture()
    setEnabled(false)
    await keeper.checkNow()
    await keeper.checkNow()
    expect(events).toHaveLength(0)
    expect(restarts).toHaveLength(0)
  })

  it('stays silent when Cursor is not running or the port is already ready', async () => {
    const { keeper, events, restarts, setStopped, setRunning, setPortReady } = fixture()
    setStopped()
    await keeper.checkNow()
    expect(events).toHaveLength(0)

    setRunning(4242, 'Tue Aug 25 06:00:00 2026')
    setPortReady(true)
    await keeper.checkNow()
    expect(events).toHaveLength(0)
    expect(restarts).toHaveLength(0)
  })

  it('stays silent during a suppression window even if the port is not ready (account switch boot window)', async () => {
    const { keeper, events, restarts, advance } = fixture()
    // 账号切换流程：杀进程（指纹清空）→ 带端口拉起新进程 → 启动窗口内端口未就绪
    keeper.suppress(120_000)
    await keeper.checkNow()
    await keeper.checkNow()
    expect(events).toHaveLength(0)
    expect(restarts).toHaveLength(0)

    // 抑制窗口过期后恢复正常看门行为（新进程仍端口未就绪 → 进入倒计时）
    advance(120_001)
    await keeper.checkNow()
    expect(events[0]).toMatchObject({ phase: 'countdown' })
  })

  it('counts down and restarts with the port arg when the port is missing and not cancelled', async () => {
    const { keeper, events, restarts } = fixture()
    await keeper.checkNow()
    expect(events[0]).toMatchObject({ phase: 'countdown', processKey: '4242:Tue Aug 25 06:00:00 2026', port: 9333 })
    expect(events.at(-1)).toMatchObject({ phase: 'done', ok: true })
    expect(restarts).toEqual([9333])
  })

  it('passes the latest active workspace path into restart', async () => {
    const { keeper, restartWorkspaces, setWorkspacePath } = fixture()
    setWorkspacePath('/workspace/active-team')
    await keeper.checkNow()
    expect(restartWorkspaces).toEqual(['/workspace/active-team'])
  })

  it('does not restart when the user cancels the countdown, and never nags the same process again', async () => {
    const { keeper, events, restarts } = fixture()
    const ticking = keeper.checkNow()
    // 倒计时进行中用户取消
    while (!keeper.countdownActive) await Promise.resolve()
    keeper.cancelCountdown()
    await ticking
    expect(restarts).toHaveLength(0)
    expect(events.map((event) => event.phase)).toEqual(['countdown', 'cancelled'])

    // 同一进程指纹：后续轮询不再打扰
    await keeper.checkNow()
    await keeper.checkNow()
    expect(events).toHaveLength(2)
    expect(restarts).toHaveLength(0)
  })

  it('triggers only once per process fingerprint even across repeated polls', async () => {
    const { keeper, events, restarts } = fixture()
    await keeper.checkNow()
    await keeper.checkNow()
    await keeper.checkNow()
    expect(events.filter((event) => event.phase === 'countdown')).toHaveLength(1)
    expect(restarts).toHaveLength(1)
  })

  it('does not loop-restart when the relaunched process still lacks the port', async () => {
    const { keeper, events, restarts } = fixture()
    // 第一次：重启（进程指纹换成 4243）
    await keeper.checkNow()
    expect(restarts).toHaveLength(1)
    // 重启后的新进程端口仍不就绪（异常）——新指纹已在 done 后标记处理，不得二次自动重启
    await keeper.checkNow()
    await keeper.checkNow()
    expect(restarts).toHaveLength(1)
    expect(events.filter((event) => event.phase === 'countdown')).toHaveLength(1)
  })

  it('resets fingerprint memory once Cursor fully exits, so the next launch is evaluated fresh', async () => {
    const { keeper, events, restarts, setStopped, setRunning, setPortReady } = fixture()
    await keeper.checkNow()
    expect(restarts).toHaveLength(1)

    setStopped()
    await keeper.checkNow()
    // 用户手动启动 Cursor（又忘带参数）→ 新进程应重新评估（再触发一次倒计时）
    setRunning(5555, 'Tue Aug 25 07:00:00 2026')
    setPortReady(false)
    await keeper.checkNow()
    expect(events.filter((event) => event.phase === 'countdown')).toHaveLength(2)
    expect(restarts).toHaveLength(2)
  })

  it('skips the restart when the port becomes ready during the countdown window', async () => {
    const { keeper, events, restarts, setPortReady } = fixture()
    const ticking = keeper.checkNow()
    // 倒计时进行中：用户已手动带参重启，端口就绪
    while (!keeper.countdownActive) await Promise.resolve()
    setPortReady(true)
    await ticking
    expect(restarts).toHaveLength(0)
    expect(events.map((event) => event.phase)).toEqual(['countdown', 'done'])
    const last = events.at(-1)
    if (last?.phase === 'done') expect(last.message).toContain('无需重启')
  })

  it('skips the restart when Cursor exits during the countdown window', async () => {
    const { keeper, events, restarts, setStopped } = fixture()
    const ticking = keeper.checkNow()
    while (!keeper.countdownActive) await Promise.resolve()
    // 倒计时进行中：用户直接关闭了 Cursor
    setStopped()
    await ticking
    expect(restarts).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ phase: 'done', ok: true })
    const last = events.at(-1)
    if (last?.phase === 'done') expect(last.message).toContain('已退出')
  })

  it('skips the restart when the process changed mid-countdown, then evaluates the new process fresh', async () => {
    const { keeper, events, restarts, setRunning } = fixture()
    const ticking = keeper.checkNow()
    while (!keeper.countdownActive) await Promise.resolve()
    // 倒计时进行中：用户手动重启了 Cursor（新指纹，仍无端口）
    setRunning(5555, 'Tue Aug 25 07:00:00 2026')
    await ticking
    expect(restarts).toHaveLength(0)
    const last = events.at(-1)
    if (last?.phase === 'done') expect(last.message).toContain('已更换')
    // 下一轮按新进程指纹重新评估：倒计时并重启一次
    await keeper.checkNow()
    expect(restarts).toEqual([9333])
  })

  // ── Windows（PowerShell 探测，与 mac pgrep/ps 彻底分离）──────────────────────

  it('windows: counts down and restarts via the PowerShell process probe', async () => {
    const { keeper, events, restarts } = fixture({ platform: 'win32' })
    await keeper.checkNow()
    // PowerShell 探测返回的指纹（pid + StartTime）参与倒计时事件
    expect(events[0]).toMatchObject({ phase: 'countdown', processKey: '4242:Tue Aug 25 06:00:00 2026', port: 9333 })
    expect(events.at(-1)).toMatchObject({ phase: 'done', ok: true })
    expect(restarts).toEqual([9333])
  })

  it('windows: stays silent when Cursor is not running', async () => {
    const { keeper, events, restarts, setStopped } = fixture({ platform: 'win32' })
    setStopped()
    await keeper.checkNow()
    await keeper.checkNow()
    expect(events).toHaveLength(0)
    expect(restarts).toHaveLength(0)
  })

  it('windows: does not nag the same process fingerprint twice', async () => {
    const { keeper, events, restarts } = fixture({ platform: 'win32' })
    await keeper.checkNow()
    await keeper.checkNow()
    await keeper.checkNow()
    expect(events.filter((event) => event.phase === 'countdown')).toHaveLength(1)
    expect(restarts).toHaveLength(1)
  })
})
