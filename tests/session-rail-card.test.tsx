import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import { SessionRailCard } from '../src/renderer/src/SessionRailCard'

const session: AgentSession = {
  id: 'session-1',
  channelId: '1',
  generation: 1,
  displayName: '主控协调',
  roleName: '主控席',
  status: 'offline',
  currentTask: '',
  queueDepth: 2,
  connectionPhase: 'waiting',
  online: false,
  connected: false,
  waiting: false,
  deliveryMode: 'queued',
  workingFiles: [],
  healthEvidence: []
}

describe('SessionRailCard', () => {
  it('renders offline state for queue-sendable embedded sessions', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={session}
        selected={false}
        onOpen={() => {}}
      />
    )

    expect(html).toContain('已离线')
    expect(html).toContain('排队 2')
    expect(html).not.toContain('待轮询')
    expect(html).toContain('rail-session-card__state is-offline')
    expect(html).toContain('rail-metric--context')
    expect(html).toContain('is-unknown')
    expect(html).toContain('上下文用量待读取')
    expect(html).not.toContain('主控席 · CH-1')
  })

  it('shows Cursor live additions/deletions immediately after the context metric', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={{
          ...session,
          contextUsage: { ratio: 0.12 },
          changes: { additions: 75, deletions: 17, files: 4 }
        }}
        selected={false}
        onOpen={() => {}}
      />
    )
    expect(html).toContain('rail-metric--changes')
    expect(html).toContain('+75')
    expect(html).toContain('-17')
    expect(html.indexOf('rail-metric--context')).toBeLessThan(html.indexOf('rail-metric--changes'))
    expect(html).toContain('Cursor 当前 Composer 实时代码变更')
  })

  it('renders the only retained compact card without losing model or state semantics', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={{ ...session, modelName: 'Kimi K3', status: 'running', online: true, connected: true }}
        selected
        onOpen={() => {}}
      />
    )
    expect(html).toContain('Kimi K3')
    expect(html).toContain('provider-moonshot')
    expect(html).toContain('运行中')
    expect(html).toContain('rail-session-card__model')
    expect(html).not.toContain('rail-session-card__digest')
  })

  it('renders the crown from effective lead state instead of the static role template', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={{
          ...session,
          channelId: '2',
          displayName: '后端实现（临时主控） · CH-2',
          roleName: '后端席 · 临时主控',
          roleTemplateKey: 'backend',
          isEffectiveLead: true,
          contextUsage: { ratio: 0.58 }
        }}
        selected={false}
        onOpen={() => {}}
      />
    )
    expect(html).toContain('临时主控')
    expect(html).toContain('aria-label="主控"')
    expect(html).toContain('58%')
    expect(html).toContain('width:58%')
  })

  it('侧栏卡片不重复渲染 token/费用；用量只放在工作台顶部', () => {
    const withUsage = renderToStaticMarkup(
      <SessionRailCard
        session={{
          ...session,
          usage: {
            composerId: 'comp-1',
            turns: 3,
            inputTokens: 12_168,
            outputTokens: 42,
            cacheReadTokens: 3_968,
            cacheWriteTokens: 0,
            estimatedCostUsd: 0.0421,
            pricedModel: 'Claude Sonnet',
            lastTurnAt: 1_000
          }
        }}
        selected={false}
        onOpen={() => {}}
      />
    )
    expect(withUsage).not.toContain('session-usage')

    const noUsage = renderToStaticMarkup(
      <SessionRailCard
        session={{
          ...session,
          usage: {
            composerId: 'comp-1',
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCostUsd: 0,
            pricedModel: '默认（Sonnet 档）',
            lastTurnAt: 0
          }
        }}
        selected={false}
        onOpen={() => {}}
      />
    )
    expect(noUsage).not.toContain('session-usage')
  })
})
