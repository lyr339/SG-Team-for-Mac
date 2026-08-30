import { describe, expect, it } from 'vitest'
import type { CursorMembershipStatus } from '../src/domain/cursor-membership'
import {
  resolveMembershipLaunchGate
} from '../src/renderer/src/lobby/membership-gate'

function okOf(tier: string, extra: Record<string, unknown> = {}): CursorMembershipStatus {
  return {
    state: 'ok',
    profile: { tier: tier as never, raw: tier, fetchedAt: 0, ...extra }
  }
}

describe('resolveMembershipLaunchGate', () => {
  it('ok + free → 硬阻断（无逃生门），消息含处理引导', () => {
    const decision = resolveMembershipLaunchGate(okOf('free'))
    expect(decision.action).toBe('dialog')
    expect(decision.message).toContain('Free')
    expect(decision.message).toContain('处理')
  })

  it('ok + 付费/试用/未知档位 → 放行（unknown = 新档位绝非 free）', () => {
    for (const tier of ['free_trial', 'pro', 'pro_plus', 'ultra', 'enterprise', 'unknown']) {
      expect(resolveMembershipLaunchGate(okOf(tier)).action).toBe('proceed')
    }
  })

  it('not_logged_in / auth_expired / error → 全部阻断（fail-closed）', () => {
    expect(resolveMembershipLaunchGate({ state: 'not_logged_in' }).action).toBe('dialog')
    const expired = resolveMembershipLaunchGate({ state: 'auth_expired' })
    expect(expired.action).toBe('dialog')
    expect(expired.message).toContain('401')
    const errored = resolveMembershipLaunchGate({ state: 'error', detail: '网络超时（8s）' })
    expect(errored.action).toBe('dialog')
    expect(errored.message).toContain('网络超时')
    expect(errored.message).toContain('刷新档位并继续')
  })

  it('未拉取（undefined）→ 放行（防御分支，发起路径恒先抓取）', () => {
    expect(resolveMembershipLaunchGate(undefined).action).toBe('proceed')
  })
})
