import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restartCursorWithCdp } from '../src/infrastructure/cursor/cursor-cdp-restart'

interface FakeExec {
  calls: string[]
  cursorProcesses: number
  openCalled: boolean
  failOpen?: boolean
}

function createHarness(options: { cursorProcesses?: number; portReadyAfter?: number; failOpen?: boolean } = {}) {
  const exec: FakeExec = { calls: [], cursorProcesses: options.cursorProcesses ?? 0, openCalled: false, failOpen: options.failOpen }
  let clock = 0
  let fetchCount = 0
  const execFileFn = async (file: string, args?: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
    const command = `${file} ${(args ?? []).join(' ')}`
    exec.calls.push(command)
    if (file === 'pgrep') {
      if (exec.cursorProcesses <= 0) {
        const error = new Error('no match') as Error & { code?: number }
        error.code = 1
        throw error
      }
      return { stdout: Array.from({ length: exec.cursorProcesses }, (_, index) => `${1000 + index}`).join('\n'), stderr: '' }
    }
    if (file === 'osascript') {
      exec.cursorProcesses = 0
      return { stdout: '', stderr: '' }
    }
    if (file === 'open') {
      if (exec.failOpen) throw new Error('open failed')
      exec.openCalled = true
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  const portReadyAfter = options.portReadyAfter ?? 1
  const fetchFn = async (): Promise<{ status: number }> => {
    fetchCount += 1
    if (!exec.openCalled || fetchCount <= portReadyAfter) throw new Error('ECONNREFUSED')
    return { status: 200 }
  }
  const sleep = async (ms: number): Promise<void> => { clock += ms }
  const now = (): number => clock
  return { exec, execFileFn, fetchFn, sleep, now, getFetchCount: () => fetchCount }
}

describe('restartCursorWithCdp', () => {
  it('非 macOS 直接拒绝', async () => {
    const harness = createHarness()
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'linux',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('macOS')
  })

  it('Cursor 未运行：跳过退出直接启动并等端口就绪', async () => {
    const harness = createHarness({ cursorProcesses: 0, portReadyAfter: 2 })
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'darwin',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('9333')
    expect(harness.exec.calls.some((call) => call.startsWith('osascript'))).toBe(false)
    expect(harness.exec.calls.some((call) => call.includes('open -a Cursor --args --remote-debugging-port=9333'))).toBe(true)
  })

  it('带工作区路径时：直接打开 IDE 工作区并附加端口参数', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'qingtian-cdp-workspace-'))
    const harness = createHarness({ cursorProcesses: 0, portReadyAfter: 1 })
    const result = await restartCursorWithCdp({
      port: 9333,
      workspacePath,
      platform: 'darwin',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('打开团队工作区')
    expect(harness.exec.calls.some((call) => call.includes(`open -a Cursor ${workspacePath} --args --remote-debugging-port=9333`))).toBe(true)
  })

  it('Cursor 运行中：先优雅退出再带参启动', async () => {
    const harness = createHarness({ cursorProcesses: 2, portReadyAfter: 1 })
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'darwin',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(true)
    const quitIndex = harness.exec.calls.findIndex((call) => call.includes('tell application "Cursor" to quit'))
    const openIndex = harness.exec.calls.findIndex((call) => call.startsWith('open -a Cursor'))
    expect(quitIndex).toBeGreaterThanOrEqual(0)
    expect(openIndex).toBeGreaterThan(quitIndex)
  })

  it('端口一直不就绪 → 明确报错', async () => {
    const harness = createHarness({ cursorProcesses: 0, portReadyAfter: Number.MAX_SAFE_INTEGER })
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'darwin',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('未就绪')
  })

  it('open 调用失败 → 透出错误', async () => {
    const harness = createHarness({ cursorProcesses: 0, failOpen: true })
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'darwin',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('重启 Cursor 失败')
  })

  it('工作区路径不存在时：不退出 Cursor，避免落到错误窗口', async () => {
    const harness = createHarness({ cursorProcesses: 2 })
    const result = await restartCursorWithCdp({
      port: 9333,
      workspacePath: '/path/that/does/not/exist/qingtian',
      platform: 'darwin',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('团队工作区路径不可用')
    expect(harness.exec.calls.some((call) => call.startsWith('osascript'))).toBe(false)
    expect(harness.exec.calls.some((call) => call.startsWith('open -a Cursor'))).toBe(false)
  })
})
