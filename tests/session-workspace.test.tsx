import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import { SessionWorkspace } from '../src/renderer/src/SessionWorkspace'

const baseSession: AgentSession = {
  id: 'session-5',
  channelId: '5',
  generation: 1,
  displayName: '前端开发 · CH-5',
  roleName: '前端席',
  status: 'waiting',
  currentTask: '',
  queueDepth: 0,
  connectionPhase: 'waiting',
  online: true,
  connected: true,
  waiting: true,
  workingFiles: [],
  healthEvidence: []
}

function entry(partial: Partial<ConversationEntry>): ConversationEntry {
  return {
    id: partial.id ?? 'e1',
    channelId: '5',
    role: partial.role ?? 'assistant',
    text: partial.text ?? '',
    timestamp: partial.timestamp ?? 1_000_000,
    status: partial.status ?? 'complete',
    source: partial.source ?? 'cursor',
    ...partial
  }
}

function renderWorkspace(overrides: {
  session?: Partial<AgentSession>
  entries?: ConversationEntry[]
  currentProjectName?: string
  liveProcess?: { turn: string; startedAt: number; updatedAt: number; blocks: import('../src/domain/conversation-entry').ProcessBlock[] }
  liveAgentResponse?: import('../src/shared/desktop-api').LiveAgentResponseState
} = {}): string {
  return renderToStaticMarkup(
    <SessionWorkspace
      session={{ ...baseSession, ...overrides.session }}
      entries={overrides.entries ?? [entry({ text: '你好' })]}
      currentProjectName={overrides.currentProjectName}
      onSend={async () => {}}
      onBack={() => {}}
      draft=""
      onDraftChange={() => {}}
      attachments={[]}
      onAttachmentsChange={() => {}}
      liveProcess={overrides.liveProcess}
      liveAgentResponse={overrides.liveAgentResponse}
    />
  )
}

describe('SessionWorkspace', () => {
  it('renders a distinct Cursor-native live response row without writing a fake history entry', () => {
    const html = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing' },
      entries: [entry({ id: 'u-live', role: 'user', source: 'desktop', text: '实时回答这个问题' })],
      liveAgentResponse: {
        id: 'bubble-live', channelId: '5', text: 'Cursor 正在逐字生成回答',
        status: 'streaming', startedAt: 1_000_100, updatedAt: 1_000_200
      }
    })
    expect(html).toContain('live-agent-response')
    expect(html).toContain('Cursor 实时生成中')
    expect(html).not.toContain('live-process-idle')
  })

  it('Agent 运行中且无过程块时显示「正在处理」占位气泡', () => {
    const html = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing' },
      entries: [entry({ id: 'u1', role: 'user', source: 'desktop', text: '继续处理' })]
    })
    expect(html).toContain('正在处理')
    expect(html).toContain('live-process-idle')
    expect(html).not.toContain('实时过程中 ·')
  })

  it('后台运行但没有用户可见待回复消息时不显示处理中占位', () => {
    const html = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing' },
      entries: []
    })
    expect(html).toContain('本轮尚无消息')
    expect(html).not.toContain('正在处理')
    expect(html).not.toContain('live-process-idle')
  })

  it('有 live 过程块时渲染实时过程气泡而非占位', () => {
    const html = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing' },
      liveProcess: {
        turn: 'turn-x',
        startedAt: 0,
        updatedAt: 1,
        blocks: [
          { kind: 'tool', id: 'b1', toolName: 'Read', toolKind: 'read', summary: 'App.tsx', status: 'done' },
          { kind: 'thinking', id: 'b2', text: '分析中', status: 'running' }
        ]
      }
    })
    expect(html).toContain('过程记录')
    expect(html).toContain('cursor-native-process__live')
    expect(html).toContain('Cursor 实时过程')
    expect(html).toContain('cursor-native-process__flow')
    expect(html).toContain('App.tsx')
    expect(html).not.toContain('live-process-idle')
  })

  it('live 过程时间早于用户消息时仍锚在当前待回复消息之后', () => {
    const html = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing' },
      entries: [entry({ id: 'u1', role: 'user', source: 'desktop', text: '请继续实现', timestamp: 1_000_000 })],
      liveProcess: {
        turn: 'turn-live',
        startedAt: 998_500,
        updatedAt: 999_000,
        blocks: [
          { kind: 'thinking', id: 'b1', text: '正在分析', status: 'running' }
        ]
      }
    })

    expect(html.indexOf('请继续实现')).toBeLessThan(html.indexOf('过程记录'))
  })


  it('Agent 待命时不显示过程占位', () => {
    const html = renderWorkspace()
    expect(html).not.toContain('正在处理')
    expect(html).not.toContain('实时过程中 ·')
  })

  it('离线但可排队时仍显示 Agent 离线，而不是把传输方式当状态', () => {
    const html = renderWorkspace({
      session: {
        online: false,
        connected: false,
        waiting: false,
        status: 'offline',
        deliveryMode: 'queued'
      }
    })

    expect(html).toContain('Agent 当前离线')
    expect(html).toContain('Cursor Agent 已离线，消息会先进入队列')
    expect(html).not.toContain('待轮询')
  })

  it('只在工作台顶部渲染一次用量与费用；页头和底栏不重复', () => {
    const html = renderWorkspace({
      session: {
        usage: {
          composerId: 'comp-1',
          turns: 4,
          inputTokens: 12_168,
          outputTokens: 42,
          cacheReadTokens: 3_968,
          cacheWriteTokens: 0,
          estimatedCostUsd: 0.0421,
          pricedModel: 'Claude Sonnet',
          lastTurnAt: 1_000
        }
      }
    })

    expect(html).toContain('16.2K')
    expect(html).toContain('≈$0.042')
    expect(html.match(/class="session-usage-stat"/g)).toHaveLength(1)
    expect(html.indexOf('session-usage-stat')).toBeLessThan(html.indexOf('composer-duration'))
    expect(html).toContain('title="本运行期真实计费 token（Claude Sonnet，4 回合）')

    const idle = renderWorkspace({
      session: {
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
      }
    })
    expect(idle).not.toContain('session-usage-stat')
  })

  it('长文本消息包裹折叠结构（clamped-message）', () => {
    const html = renderWorkspace({ entries: [entry({ text: '长文' })] })
    expect(html).toContain('clamped-message')
    expect(html).toContain('长文')
  })

  it('渲染用户与 Agent 会话条目：角色标签与已发送时间', () => {
    const html = renderWorkspace({
      entries: [
        entry({ id: 'u1', role: 'user', source: 'desktop', text: '请 review', timestamp: 1_000_000 }),
        entry({ id: 'a1', role: 'assistant', source: 'cursor', text: '收到，开始检查', timestamp: 1_030_000 })
      ]
    })
    expect(html).toContain('请 review')
    expect(html).toContain('收到，开始检查')
    expect(html).toContain('<strong>你</strong>')
    expect(html).toContain('<strong>Agent</strong>')
    expect(html).toContain('已发送')
    expect(html).toContain('chat-row--mine')
  })

  it('错误条目渲染失败原因与错误样式', () => {
    const html = renderWorkspace({
      entries: [entry({ role: 'error', text: '通道写入失败', status: 'failed', error: 'MCP 连接中断' })]
    })
    expect(html).toContain('<strong>错误</strong>')
    expect(html).toContain('chat-row--error')
    expect(html).toContain('发送失败：MCP 连接中断')
  })

  it('同角色短间隔连续消息合并分组（is-grouped），跨 10 分钟插入时间分隔线', () => {
    const grouped = renderWorkspace({
      entries: [
        entry({ id: 'g1', text: '第一段', timestamp: 1_000_000 }),
        entry({ id: 'g2', text: '第二段', timestamp: 1_060_000 })
      ]
    })
    expect(grouped).toContain('is-grouped')

    const divided = renderWorkspace({
      entries: [
        entry({ id: 'd1', text: '较早', timestamp: 1_000_000 }),
        entry({ id: 'd2', text: '较晚', timestamp: 1_000_000 + 11 * 60_000 })
      ]
    })
    const dividerCount = divided.match(/chat-divider/g)?.length ?? 0
    expect(dividerCount).toBeGreaterThanOrEqual(2)
    expect(divided).not.toContain('is-grouped')
  })

  it('条目携带 processBlocks 时渲染过程块（工具名 / 摘要 / 状态）', () => {
    const html = renderWorkspace({
      entries: [entry({
        text: '已完成读取',
        processBlocks: [
          { kind: 'tool', id: 'p1', toolName: 'Read', toolKind: 'read', summary: 'src/App.tsx', status: 'done' },
          { kind: 'command', id: 'p2', command: 'npm test', output: 'ok', exitCode: 0, status: 'done' }
        ]
      })]
    })
    expect(html).toContain('process-turn')
    expect(html).toContain('读取文件')
    expect(html).toContain('src/App.tsx')
    expect(html).toContain('chat-row--process')
    expect(html).not.toContain('process-turn__live-label')
  })



  it('不渲染 silent 内部协作条目', () => {
    const html = renderWorkspace({
      entries: [
        entry({ id: 's1', role: 'user', source: 'desktop', text: '【拾光内部协作通知】消息 ID：x', silent: true }),
        entry({ id: 'u1', role: 'user', source: 'desktop', text: '用户真实消息' })
      ]
    })

    expect(html).not.toContain('拾光内部协作通知')
    expect(html).toContain('用户真实消息')
  })

  it('渲染消息附件：图片走预览图，文件显示名称与大小', () => {
    const html = renderWorkspace({
      entries: [entry({
        role: 'user',
        source: 'desktop',
        text: '请看附件',
        attachments: [
          { id: 'att-img', name: 'design.png', mimeType: 'image/png', size: 2048, previewUrl: 'blob:preview-1' },
          { id: 'att-doc', name: 'notes.md', mimeType: 'text/markdown', size: 512 }
        ]
      })]
    })
    expect(html).toContain('chat-attachments')
    expect(html).toContain('chat-attachment-image')
    expect(html).toContain('blob:preview-1')
    expect(html).toContain('notes.md')
    expect(html).toContain('512 B')
  })

  it('streaming 条目显示「正在生成…」与打字指示器', () => {
    const html = renderWorkspace({
      entries: [entry({ text: '', status: 'streaming' })]
    })
    expect(html).toContain('正在生成…')
    expect(html).toContain('typing-indicator')
    expect(html).toContain('实时生成中')
  })

  it('空会话显示「本轮尚无消息」空态', () => {
    const html = renderWorkspace({ entries: [] })
    expect(html).toContain('本轮尚无消息')
    expect(html).toContain('timeline-empty')
  })

  it('完整消息暴露复制与引用操作入口', () => {
    const html = renderWorkspace({
      entries: [entry({ text: '可以引用的内容' })]
    })
    expect(html).toContain('复制')
    expect(html).toContain('引用')
    expect(html).toContain('chat-action')
  })
})
