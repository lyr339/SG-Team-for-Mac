import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import { SessionRailCard } from '../src/renderer/src/SessionRailCard'

const session: AgentSession = {
  id: 'session-1',
  channelId: '1',
  generation: 1,
  displayName: '主控协调 · CH-1',
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

const NOW = Date.parse('2026-09-07T10:00:00+08:00')

describe('SessionRailCard（名册行）', () => {
  it('离线行：灰色空心状态点、「已离线」、最近活性时间、排队徽记；上下文未知时只画光环轨道', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={{ ...session, lastSeenAt: NOW - 42 * 60_000 }}
        selected={false}
        onOpen={() => {}}
        now={NOW}
      />
    )

    expect(html).toContain('session-row is-offline')
    expect(html).toContain('已离线')
    expect(html).toContain('排队 2')
    expect(html).toContain('42 分钟前')
    expect(html).toContain('session-row__ring-track')
    expect(html).not.toContain('session-row__ring-arc')
    expect(html).toContain('session-row__context is-unknown')
    expect(html).toContain('上下文用量待读取')
    // 角色名与通道号拆成两段：名可截断、号用等宽数字。
    expect(html).toMatch(/<strong class="session-row__name">主控协调<\/strong><small class="session-row__channel">CH-1<\/small>/)
    expect(html).not.toContain('主控席 · CH-1')
  })

  it('上下文光环弧长即百分比，天色档位同时落在光环与数字上；实时增删紧随其后', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={{
          ...session,
          status: 'running',
          online: true,
          connected: true,
          connectionPhase: 'processing',
          contextUsage: { ratio: 0.72 },
          changes: { additions: 75, deletions: 17, files: 4 }
        }}
        selected={false}
        onOpen={() => {}}
      />
    )
    expect(html).toContain('session-row is-active')
    expect(html).toContain('运行中')
    expect(html).toContain('session-row__ring is-afternoon')
    expect(html).toContain('stroke-dasharray="72 100"')
    expect(html).toContain('session-row__context is-afternoon')
    expect(html).toContain('>72%<')
    expect(html).toContain('session-row__changes')
    expect(html).toContain('+75')
    expect(html).toContain('−17')
    expect(html.indexOf('session-row__context')).toBeLessThan(html.indexOf('session-row__changes'))
    // 在线行不显示「N 分钟前」。
    expect(html).not.toContain('session-row__seen')
  })

  it('模型只做身份：厂商色块 + 中性文字，选中态用 aria-current 表达', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={{ ...session, modelName: 'Kimi K3', status: 'waiting', online: true, connected: true, waiting: true }}
        selected
        onOpen={() => {}}
      />
    )
    expect(html).toContain('session-row is-waiting is-selected')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('待命中')
    expect(html).toContain('session-row__model provider-moonshot')
    expect(html).toContain('Kimi K3')
    expect(html).toContain('Moonshot AI')
  })

  it('主控王冠来自有效主控状态而非静态角色模板；aria-label 汇总名 / 状态 / 上下文 / 排队', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={{
          ...session,
          channelId: '2',
          displayName: '后端实现（临时主控） · CH-2',
          roleName: '后端席 · 临时主控',
          roleTemplateKey: 'backend',
          isEffectiveLead: true,
          online: true,
          connected: true,
          status: 'blocked',
          connectionPhase: 'approval',
          contextUsage: { ratio: 0.58 },
          queueDepth: 1
        }}
        selected={false}
        onOpen={() => {}}
      />
    )
    expect(html).toContain('后端实现（临时主控）')
    expect(html).toContain('aria-label="主控"')
    expect(html).toContain('session-row is-attention')
    expect(html).toContain('等待拍板')
    expect(html).toContain('aria-label="后端实现（临时主控） CH-2，等待拍板，上下文 58%，排队 1"')
  })

  it('侧栏行不重复渲染 token / 费用；用量只放在工作台顶部', () => {
    const html = renderToStaticMarkup(
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
    expect(html).not.toContain('session-usage')
    expect(html).not.toContain('12.2K')
  })

  it('可拖拽时在提示里说明；单独一行的组不可拖拽', () => {
    const draggable = renderToStaticMarkup(<SessionRailCard session={session} selected={false} onOpen={() => {}} draggable />)
    expect(draggable).toContain('draggable="true"')
    expect(draggable).toContain('拖动可调整同组内的顺序')
    const fixed = renderToStaticMarkup(<SessionRailCard session={session} selected={false} onOpen={() => {}} />)
    expect(fixed).toContain('draggable="false"')
    expect(fixed).not.toContain('拖动可调整')
  })
})
