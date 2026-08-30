import { describe, expect, it } from 'vitest'
import type { CursorRuntimeAccountMatch } from '../src/domain/cursor-account'
import {
  resolveRuntimeLaunchGate
} from '../src/renderer/src/lobby/runtime-account-gate'

function gate(verify: CursorRuntimeAccountMatch | undefined, options: {
  automationEnabled?: boolean
  hasActiveAccount?: boolean
} = {}) {
  return resolveRuntimeLaunchGate({
    verify,
    automationEnabled: options.automationEnabled ?? true,
    hasActiveAccount: options.hasActiveAccount ?? true
  })
}

describe('resolveRuntimeLaunchGate', () => {
  it('核对失败拉取失败（undefined）→ 放行（不因核对自身故障阻塞发起）', () => {
    expect(gate(undefined).action).toBe('proceed')
  })

  it('matched / vault_empty → 放行', () => {
    expect(gate({ status: 'matched', cursorLabel: 'a@x.com' }).action).toBe('proceed')
    expect(gate({ status: 'vault_empty' }).action).toBe('proceed')
  })

  it('mismatch + 自动化开启 → 弹窗且不给「仍要发起」（继续 = 删错官网账号）', () => {
    const decision = gate({ status: 'mismatch', cursorLabel: 'b@x.com', activeLabel: 'a@x.com' })
    expect(decision.action).toBe('dialog')
    expect(decision.allowProceed).toBe(false)
    expect(decision.message).toContain('b@x.com')
    expect(decision.message).toContain('a@x.com')
  })

  it('mismatch + 自动化关闭 → 静默放行（无删号链，劈叉无害）', () => {
    const decision = gate(
      { status: 'mismatch', cursorLabel: 'b@x.com', activeLabel: 'a@x.com' },
      { automationEnabled: false }
    )
    expect(decision.action).toBe('proceed')
  })

  it('cursor_unavailable → 弹窗并保留「仍要发起」逃生门（无删错号风险，只是浪费）', () => {
    const decision = gate({ status: 'cursor_unavailable', detail: '未登录' })
    expect(decision.action).toBe('dialog')
    expect(decision.allowProceed).toBe(true)
    expect(decision.message).toContain('未登录')
  })

  it('cursor_unavailable + 无活跃账号 → 文案不引导切换（无号可切）', () => {
    const decision = gate({ status: 'cursor_unavailable' }, { hasActiveAccount: false })
    expect(decision.message).not.toContain('切换到活跃账号')
  })
})
