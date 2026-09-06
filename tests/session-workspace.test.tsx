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
  liveProcess?: { turn: string; startedAt: number; updatedAt: number; truncatedItemCount?: number; generating?: boolean; blocks: import('../src/domain/conversation-entry').ProcessBlock[] }
  liveAgentResponse?: import('../src/shared/desktop-api').LiveAgentResponseState
  nativeProcessStream?: import('../src/shared/desktop-api').NativeProcessStreamStatus
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
      nativeProcessStream={overrides.nativeProcessStream}
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

  it('discloses when the native Cursor process stream is disconnected', () => {
    const html = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing' },
      entries: [entry({ id: 'u-stream', role: 'user', source: 'desktop', text: '继续处理' })],
      nativeProcessStream: { state: 'reconnecting', detail: '调试端口尚未连接', updatedAt: 1 }
    })
    expect(html).toContain('原生过程流正在重连')
    expect(html).toContain('调试端口尚未连接')
  })

  it('combines live process and final streaming text into one native-style Agent turn', () => {
    const html = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing' },
      liveProcess: {
        turn: 'cursor:user-1', startedAt: 1_000, updatedAt: 1_100,
        blocks: [{ kind: 'tool', id: 'read-1', toolName: 'read_file', toolKind: 'read', summary: 'a.ts', status: 'done' }]
      },
      liveAgentResponse: {
        id: 'answer-1', channelId: '5', text: '统一回合中的最终回答', status: 'streaming',
        startedAt: 1_050, updatedAt: 1_200
      }
    })
    expect(html.match(/chat-row chat-row--agent live-process-row[" ]/g)).toHaveLength(1)
    expect(html).toContain('cursor-native-process__flow')
    expect(html).toContain('live-agent-response')
    expect(html).not.toContain('live-response-row')
  })

  it('keeps a long-running turn process beside its final response without a timestamp guess', () => {
    const html = renderWorkspace({
      liveProcess: {
        turn: 'cursor:user-long-running', startedAt: 1_000, updatedAt: 5_000,
        blocks: [{ kind: 'thinking', id: 'thought-long', text: '长任务完整过程', status: 'done' }]
      },
      liveAgentResponse: {
        id: 'answer-after-long-work', channelId: '5', text: '长任务最终回答', status: 'complete',
        startedAt: 180_000, updatedAt: 180_100
      }
    })
    expect(html).toContain('长任务完整过程')
    expect(html).toContain('长任务最终回答')
    expect(html.match(/chat-row chat-row--agent live-process-row[" ]/g)).toHaveLength(1)
  })
  it('queues offline solo seats without framing them as team collaboration', () => {
    const solo = renderWorkspace({
      session: {
        roleTemplateKey: 'solo',
        online: false,
        connected: false,
        waiting: false,
        status: 'offline',
        deliveryMode: 'queued'
      }
    })
    expect(solo).toContain('消息会先进入队列')
    expect(solo).toContain('只要该 Cursor 会话继续调用 check_messages 轮询')
    expect(solo).not.toContain('SG Team 的 check_messages')
    // 团队席保留原措辞（工具经 SG Team 服务器）。
    const team = renderWorkspace({
      session: {
        roleTemplateKey: 'frontend',
        online: false,
        connected: false,
        waiting: false,
        status: 'offline',
        deliveryMode: 'queued'
      }
    })
    expect(team).toContain('SG Team 的 check_messages')
  })

  it('completed live responses carry no trailing status text', () => {
    const html = renderWorkspace({
      liveAgentResponse: {
        id: 'transcript:composer-5:1234', channelId: '5', text: '恢复的历史回复',
        status: 'complete', startedAt: 1, updatedAt: 2
      }
    })
    expect(html).toContain('恢复的历史回复')
    expect(html).not.toContain('正在归档')
    expect(html).not.toContain('chat-state">')
    // CDP 来源的完成态回复同样不宣称「正在归档」——实时过程流已承载过程叙事。
    const cdp = renderWorkspace({
      liveAgentResponse: {
        id: 'cursor-bubble-9', channelId: '5', text: 'CDP 完整回复',
        status: 'complete', startedAt: 1, updatedAt: 2
      }
    })
    expect(cdp).toContain('CDP 完整回复')
    expect(cdp).not.toContain('正在归档')
    expect(cdp).not.toContain('chat-state">')
  })

  it('never renders the raw channel runtime id as a user-facing session label', () => {
    const html = renderWorkspace({ session: { id: 'sg-channel:5', composerTitle: undefined } })
    expect(html).toContain('SG Team · CH-5')
    expect(html).not.toContain('sg-channel:5')
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
    expect(html).not.toContain('live-process-idle')
    expect(html).not.toContain('running-placeholder')
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

  it('新消息仍在队列时保持既有过程在消息之前', () => {
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

    expect(html.indexOf('过程记录')).toBeLessThan(html.indexOf('请继续实现'))
  })

  it('消息被 Agent 取走后把新增过程锚在该消息之后', () => {
    const html = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing' },
      entries: [entry({
        id: 'u1', role: 'user', source: 'desktop', text: '请继续实现',
        timestamp: 1_000_000, deliveredAt: 1_000_100
      })],
      liveProcess: {
        turn: 'native-long-turn', startedAt: 998_500, updatedAt: 1_000_300,
        blocks: [{ kind: 'thinking', id: 'b1', text: '正在分析', status: 'running', startedAt: 1_000_200 }]
      }
    })

    expect(html.indexOf('请继续实现')).toBeLessThan(html.indexOf('过程记录'))
  })

  it('用户新消息排队时，进行中的过程流留在上一回合原地（不消失、不迁移）', () => {
    const html = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing', deliveryMode: 'queued' },
      entries: [
        entry({ id: 'u1', role: 'user', source: 'desktop', text: '第一条', timestamp: 1_000, deliveredAt: 1_050 }),
        entry({ id: 'u2', role: 'user', source: 'desktop', text: '第二条（排队中）', timestamp: 5_000 })
      ],
      liveProcess: {
        turn: 'cursor:native-turn', startedAt: 1_100, updatedAt: 5_200, generating: true,
        blocks: [
          { kind: 'thinking', id: 'th-1', text: '正在处理第一条', status: 'done', startedAt: 1_100 },
          { kind: 'tool', id: 'tool-1', toolName: 'read_file', toolKind: 'read', summary: 'a.ts', status: 'running', startedAt: 5_100 }
        ]
      }
    })
    // 过程卡仍在，且位于第一条与第二条之间（锚定第一条回合）；第二条尚未投递，无占位。
    expect(html).toContain('cursor-native-process')
    expect(html.indexOf('第一条')).toBeLessThan(html.indexOf('cursor-native-process'))
    expect(html.indexOf('cursor-native-process')).toBeLessThan(html.indexOf('第二条（排队中）'))
    expect(html).not.toContain('live-process-idle')
  })

  it('occupies the same Agent row for the idle placeholder and the first process frame', () => {
    const base = {
      session: { status: 'running' as const, waiting: false, connectionPhase: 'processing' },
      entries: [entry({ id: 'u1', role: 'user', source: 'desktop', text: '开始', timestamp: 1_000, deliveredAt: 1_050 })]
    }
    const idle = renderWorkspace(base)
    expect(idle).toContain('live-process-idle')
    expect(idle).toContain('正在处理')
    // 占位与首帧过程共用同一 Agent 行（同一 chat-row 结构与宽列），不是独立的占位行。
    expect(idle.match(/chat-row chat-row--agent live-process-row chat-row--process/g)).toHaveLength(1)
    const streaming = renderWorkspace({
      ...base,
      liveProcess: {
        turn: 'cursor:t1', startedAt: 1_100, updatedAt: 1_200, generating: true,
        blocks: [{ kind: 'thinking', id: 'th-1', text: '思考中', status: 'running', startedAt: 1_100 }]
      }
    })
    expect(streaming).not.toContain('live-process-idle')
    expect(streaming.match(/chat-row chat-row--agent live-process-row chat-row--process/g)).toHaveLength(1)
  })

  it('旧过程存在时仍为已投递的新消息显示独立处理占位', () => {
    const html = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing', deliveryMode: 'queued' },
      entries: [entry({
        id: 'u-new', role: 'user', source: 'desktop', text: '新消息',
        timestamp: 2_000, deliveredAt: 2_100
      })],
      liveProcess: {
        turn: 'native-long-turn', startedAt: 1_000, updatedAt: 2_150,
        blocks: [{ kind: 'thinking', id: 'old', text: '旧过程', status: 'done', startedAt: 1_500 }]
      }
    })
    expect(html.indexOf('旧过程')).toBeLessThan(html.indexOf('新消息'))
    expect(html.indexOf('新消息')).toBeLessThan(html.indexOf('正在处理'))
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

    expect(html).toContain('Agent 离线：消息保留在本地队列')
    expect(html).toContain('Cursor Agent 已离线，消息会先进入队列')
    expect(html).not.toContain('待轮询')
  })

  it('精简独立会话页头：状态胶囊已经表达离线，副标题只保留席位身份', () => {
    const html = renderWorkspace({
      session: {
        roleTemplateKey: 'solo', roleName: '独立席 1', composerTitle: 'Independent agent mode',
        online: false, connected: false, waiting: false, status: 'offline'
      }
    })
    expect(html).toContain('<p>独立席 1</p>')
    expect(html).not.toContain('Independent agent mode')
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

    expect(html).toContain('12.2K')
    expect(html).toContain('$0.042')
    expect(html).toContain('Tokens')
    expect(html).not.toContain('≈$')
    expect(html.match(/class="session-usage"/g)).toHaveLength(1)
    expect(html.indexOf('session-usage')).toBeGreaterThan(html.indexOf('workspace-header'))
    expect(html.indexOf('session-usage')).toBeLessThan(html.indexOf('</header>'))
    expect(html).toMatch(/session-usage__label">Tokens<\/span><b class="session-usage__value">12\.2K<\/b>/)
    expect(html).toMatch(/session-usage__label">Cost<\/span><b class="session-usage__value">\$0\.042<\/b>/)
    expect(html).toContain('session-usage__sep')
    expect(html).toContain('Input 8.2K')
    expect(html).toContain('Output 42')
    expect(html).not.toContain('4 次请求')

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
    // 空对话：占位态常驻（不隐藏组件），但绝不显示数字——ghost「—」等待首个计费回合
    expect(idle).toContain('session-usage is-pending')
    expect(idle).not.toMatch(/session-usage__value">\d/)
    expect(idle).toContain('aria-label="Waiting for usage"')
  })

  it('Composer 已绑定但尚无计费帧时保留明确占位，不再整块消失', () => {
    const html = renderWorkspace({
      session: { telemetry: { state: 'bound', detail: '已绑定', source: 'cursor-local' } }
    })
    expect(html).toContain('session-usage is-pending')
    expect(html).toMatch(/Tokens<\/span><b class="session-usage__value">—<\/b>/)
    expect(html).toMatch(/Cost<\/span><b class="session-usage__value">—<\/b>/)
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

describe('统一回合时间线（阶段 F：RC-8 turn identity）', () => {
  it('renders one turn container across queued → delivered → responding → sealed (§8.5-1)', () => {
    const userEntry = entry({
      id: 'u1', role: 'user', source: 'desktop', text: '统一身份验证',
      timestamp: 1_000, deliveredAt: undefined
    })
    // queued（队列传输、未投递）：仅用户气泡，无占位（尚未到达 Agent）
    const queued = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing', deliveryMode: 'queued' },
      entries: [userEntry]
    })
    expect(queued).toContain('统一身份验证')
    expect(queued).not.toContain('live-process-idle')

    // delivered：占位出现（running + 已投递 + 无产物）
    const delivered = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing' },
      entries: [entry({ ...userEntry, deliveredAt: 1_100 })]
    })
    expect(delivered).toContain('统一身份验证')
    expect(delivered).toContain('live-process-idle')

    // responding：live 过程接管（占位消失）
    const responding = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing' },
      entries: [entry({ ...userEntry, deliveredAt: 1_100 })],
      liveProcess: {
        turn: 'cursor:user-turn-1', startedAt: 1_200, updatedAt: 1_300,
        blocks: [{ kind: 'thinking', id: 'thought-1', text: '思考中', status: 'running', startedAt: 1_200 }]
      }
    })
    expect(responding).toContain('统一身份验证')
    // 思考正文经共享播放器呈现（阶段 G）：静态渲染首帧为空容器，
    // 打字机行为由 use-streaming-text.test.tsx 锁定；此处断言思考卡挂载。
    expect(responding).toContain('cursor-native-thought')
    expect(responding).not.toContain('live-process-idle')

    // sealed：回复落库，过程随回复持久化（live 已被 committed 过滤）
    const sealed = renderWorkspace({
      session: { status: 'waiting', waiting: true, connectionPhase: 'waiting' },
      entries: [
        entry({ ...userEntry, deliveredAt: 1_100 }),
        entry({
          id: 'a1', role: 'assistant', source: 'cursor', text: '最终回答',
          timestamp: 2_000, replyToEntryId: 'u1',
          processBlocks: [{ kind: 'thinking', id: 'thought-1', text: '思考完成', status: 'done', startedAt: 1_200 }]
        })
      ]
    })
    expect(sealed).toContain('统一身份验证')
    expect(sealed).toContain('最终回答')
    expect(sealed).toContain('思考完成')
    expect(sealed.match(/chat-row chat-row--agent live-process-row[" ]/g)).toBe(null)
  })

  it('user text → agent live turn → user image keeps the image row un-grouped (RC-12/§8.5-7)', () => {
    const html = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing' },
      entries: [
        entry({ id: 'u1', role: 'user', source: 'desktop', text: '你是谁', timestamp: 1_000_000, deliveredAt: 1_000_050 }),
        entry({ id: 'u2', role: 'user', source: 'desktop', text: '', timestamp: 1_093_000, deliveredAt: 1_093_050,
          attachments: [{ id: 'img1', name: 'screen.png', mimeType: 'image/png', size: 2_048, previewUrl: 'blob:img' }] })
      ],
      liveProcess: {
        turn: 'cursor:turn-1', startedAt: 1_000_100, updatedAt: 1_092_000,
        blocks: [{ kind: 'thinking', id: 'th1', text: '回答生成中', status: 'done', startedAt: 1_000_200 }]
      }
    })
    // 图片消息不被误分组：身份头（你 + 头像）必须显示；live 过程行夹在
    // 两条用户消息之间，不参与用户分组链。
    expect(html).toContain('<strong>你</strong>')
    expect(html).toContain('chat-attachment-image')
    expect(html.match(/is-grouped/g) ?? []).toHaveLength(0)
  })

  it('groups consecutive queued user messages but breaks the group on agent activity (RC-12)', () => {
    const session = {
      status: 'running' as const,
      waiting: false,
      connectionPhase: 'processing',
      deliveryMode: 'queued' as const
    }
    const first = entry({
      id: 'u1', role: 'user', source: 'desktop', text: '第一条',
      timestamp: 1_000_000, deliveredAt: 1_000_050
    })
    const second = entry({
      id: 'u2', role: 'user', source: 'desktop', text: '第二条',
      timestamp: 1_060_000
    })

    // 连续排队（u1 之后无任何 Agent 产物）：u2 与 u1 合并分组。
    const grouped = renderWorkspace({ session, entries: [first, second] })
    expect(grouped.match(/is-grouped/g)).toHaveLength(1)

    // u1 回合内出现 Agent 实时过程：分组被打断，u2 独立显示身份头。
    const broken = renderWorkspace({
      session,
      entries: [first, second],
      liveProcess: {
        turn: 'cursor:t1', startedAt: 1_000_100, updatedAt: 1_000_200,
        blocks: [{ kind: 'thinking', id: 'th1', text: '处理第一条', status: 'running', startedAt: 1_000_100 }]
      }
    })
    expect(broken.match(/is-grouped/g)).toBe(null)
    expect(broken.match(/<strong>你<\/strong>/g)).toHaveLength(2)
  })

  it('breaks the user group when a persisted agent reply sits between two user messages', () => {
    const html = renderWorkspace({
      entries: [
        entry({ id: 'u1', role: 'user', source: 'desktop', text: '第一问', timestamp: 1_000_000, deliveredAt: 1_000_050 }),
        entry({ id: 'a1', role: 'assistant', source: 'cursor', text: '第一答', timestamp: 1_030_000, replyToEntryId: 'u1' }),
        entry({ id: 'u2', role: 'user', source: 'desktop', text: '第二问', timestamp: 1_060_000, deliveredAt: 1_060_050 })
      ]
    })
    // Agent 回复打断用户组：两条用户消息各自显示身份头。
    expect(html.match(/<strong>你<\/strong>/g)).toHaveLength(2)
    expect(html.match(/is-grouped/g)).toBe(null)
  })

  it('treats a generating process with all-done blocks as live so the typewriter engages (RC-9)', () => {
    // Cursor 常见形态：回合仍在生成，但 Thinking 块已被标记 done。服务端
    // generating=true 是权威直播信号——直播徽标必须出现（打字机播放的前提；
    // 旧实现靠「某块 running」猜测，此处会误判为历史而整段瞬现）。
    const html = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing' },
      entries: [entry({
        id: 'u1', role: 'user', source: 'desktop', text: '继续',
        timestamp: 1_000_000, deliveredAt: 1_000_050
      })],
      liveProcess: {
        turn: 'cursor:user-t1', startedAt: 1_000_100, updatedAt: 1_000_200,
        generating: true,
        blocks: [{ kind: 'thinking', id: 'cursor:th-1', text: '生成中的思考内容', status: 'done', startedAt: 1_000_120 }]
      }
    })
    expect(html).toContain('Cursor 实时过程')
    expect(html).toContain('cursor-native-thought')
    expect(html).toContain('is-live')

    // generating=false（历史快照）：无直播徽标，整段直接显示。
    const history = renderWorkspace({
      session: { status: 'running', waiting: false, connectionPhase: 'processing' },
      entries: [entry({
        id: 'u1', role: 'user', source: 'desktop', text: '继续',
        timestamp: 1_000_000, deliveredAt: 1_000_050
      })],
      liveProcess: {
        turn: 'cursor:user-t1', startedAt: 1_000_100, updatedAt: 1_000_200,
        generating: false,
        blocks: [{ kind: 'thinking', id: 'cursor:th-1', text: '历史思考内容', status: 'done', startedAt: 1_000_120 }]
      }
    })
    expect(history).not.toContain('Cursor 实时过程')
    // 历史上下文（immediate）：正文完整直接渲染（静态渲染可见全文）。
    expect(history).toContain('历史思考内容')
  })
})

describe('历史脏数据兜底：回复正文不得随过程卡重复渲染（2026-09-03 事故）', () => {
  const finalText = '这是微信（WeChat）的应用图标：绿色圆角方块，中间两个白色对话气泡叠在一起。'

  it('renders the reply body exactly once even if a legacy process block duplicates it', () => {
    // 正式库 r2 行的原始形状：processBlocks 只含一个与 content 一字不差的
    // cursor-msg——旧版封口固化的污染。渲染层滤除后正文只出现一次。
    const html = renderWorkspace({
      entries: [
        entry({ id: 'u1', role: 'user', source: 'desktop', text: '如图这是什么', timestamp: 1_000_000, deliveredAt: 1_000_050 }),
        entry({
          id: 'a1', role: 'assistant', source: 'cursor', text: finalText,
          timestamp: 1_012_000, replyToEntryId: 'u1',
          processBlocks: [
            { kind: 'message', id: 'cursor-msg:142abf84', text: finalText, status: 'done' }
          ]
        })
      ]
    })
    expect(html.match(/这是微信（WeChat）的应用图标/g)).toHaveLength(1)
  })

  it('keeps legitimate interim messages whose text differs from the final reply', () => {
    const html = renderWorkspace({
      entries: [
        entry({ id: 'u1', role: 'user', source: 'desktop', text: '请继续', timestamp: 1_000_000, deliveredAt: 1_000_050 }),
        entry({
          id: 'a1', role: 'assistant', source: 'cursor', text: finalText,
          timestamp: 1_012_000, replyToEntryId: 'u1',
          processBlocks: [
            { kind: 'tool', id: 'cursor:tool-1', toolName: 'read_file', toolKind: 'read', summary: 'a.ts', status: 'done' },
            { kind: 'message', id: 'cursor-msg:interim', text: '我先读取目标文件。', status: 'done' }
          ]
        })
      ]
    })
    // 中间过程消息（文本 ≠ 最终回复）保留；最终正文只出现一次。
    expect(html).toContain('我先读取目标文件。')
    expect(html.match(/这是微信（WeChat）的应用图标/g)).toHaveLength(1)
  })
})
