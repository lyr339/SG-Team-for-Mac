import { describe, expect, it } from 'vitest'
import {
  contextRingDash,
  sessionRailGroupOf,
  sessionRailStateLabel,
  sessionRailSummary,
  sessionRailTitle
} from '../src/renderer/src/session-rail-view'

const facts = (patch: Partial<Parameters<typeof sessionRailGroupOf>[0]> = {}) => ({
  online: true,
  status: 'waiting' as const,
  waiting: true,
  connectionPhase: 'waiting',
  runtimeEvidence: 'active' as const,
  ...patch
})

describe('session-rail-view 分组与色调', () => {
  it('离线证据优先级最高：不在线 / 停止相位 / 运行时正面终止都归离线', () => {
    expect(sessionRailGroupOf(facts({ online: false }))).toBe('offline')
    expect(sessionRailGroupOf(facts({ status: 'stopped' }))).toBe('offline')
    expect(sessionRailGroupOf(facts({ status: 'running', runtimeEvidence: 'stopped' }))).toBe('offline')
  })

  it('阻塞 / 待验收归需关注；处理中相位即执行中；在岗待命归待命；未待命的空闲落回需关注', () => {
    expect(sessionRailGroupOf(facts({ status: 'blocked', waiting: false, connectionPhase: 'approval' }))).toBe('attention')
    expect(sessionRailGroupOf(facts({ status: 'review', waiting: false }))).toBe('attention')
    expect(sessionRailGroupOf(facts({ status: 'idle', waiting: false, connectionPhase: 'processing' }))).toBe('active')
    expect(sessionRailGroupOf(facts({ status: 'reviving', waiting: false, connectionPhase: 'reviving' }))).toBe('active')
    expect(sessionRailGroupOf(facts({ status: 'idle', waiting: false, connectionPhase: 'keepalive' }))).toBe('waiting')
    expect(sessionRailGroupOf(facts({ status: 'idle', waiting: false, connectionPhase: '' }))).toBe('attention')
  })

  it('状态词：离线统一「已离线」，其余沿用全局状态文案', () => {
    expect(sessionRailStateLabel(facts({ online: false, status: 'reviving' }))).toBe('已离线')
    expect(sessionRailStateLabel(facts({ status: 'blocked' }))).toBe('等待拍板')
    expect(sessionRailStateLabel(facts())).toBe('待命中')
  })
})

describe('session-rail-view 标题与摘要', () => {
  it('把「角色 · CH-N」拆成角色名与通道号；未绑定通道只留 SG Team', () => {
    expect(sessionRailTitle({ displayName: '架构实现 · CH-2', channelId: '2' })).toEqual({ name: '架构实现', channel: 'CH-2' })
    expect(sessionRailTitle({ displayName: '后端实现（临时主控） · CH-4', channelId: '4' })).toEqual({ name: '后端实现（临时主控）', channel: 'CH-4' })
    expect(sessionRailTitle({ displayName: 'SG Team CH-8', channelId: '8' })).toEqual({ name: 'SG Team', channel: 'CH-8' })
    expect(sessionRailTitle({ displayName: '', channelId: '9' })).toEqual({ name: 'SG Team', channel: 'CH-9' })
  })

  it('摘要按固定顺序列出非空状态组，并汇总排队数；空名册返回空串', () => {
    expect(sessionRailSummary([])).toBe('')
    expect(sessionRailSummary([
      { ...facts(), queueDepth: 0 },
      { ...facts({ status: 'running', waiting: false, connectionPhase: 'processing' }), queueDepth: 1 },
      { ...facts({ online: false, status: 'offline' }), queueDepth: 2 },
      { ...facts({ online: false, status: 'offline' }), queueDepth: 0 }
    ])).toBe('1 执行中 · 1 待命 · 2 离线 · 排队 3')
    expect(sessionRailSummary([{ ...facts(), queueDepth: 0 }])).toBe('1 待命')
  })

  it('上下文光环：百分比直接映射为 pathLength=100 的 dasharray；极小值保底可见；空值不画', () => {
    expect(contextRingDash(undefined)).toBeUndefined()
    expect(contextRingDash(Number.NaN)).toBeUndefined()
    expect(contextRingDash(0)).toBe('0 100')
    expect(contextRingDash(0.4)).toBe('1.5 100')
    expect(contextRingDash(72.46)).toBe('72.5 100')
    expect(contextRingDash(140)).toBe('100 100')
  })
})
