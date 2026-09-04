/**
 * 设计走查用的静态假数据。仅被 preview.html 入口引用，
 * 不进入生产构建（electron-vite 只打包 index.html 入口）。
 */
import type { AgentSession, ContextUsage } from '../../../domain/agent-session'
import type { ConversationEntry } from '../../../domain/conversation-entry'
import type { TaskPoolSnapshot } from '../../../domain/task-pool'
import type { TeamControlSnapshot, TeamMemberView } from '../../../domain/team-control'
import { createConfiguredTeamBundle } from '../../../domain/team-control'
import type { TeamCollaborationSnapshot, TeamMessage } from '../../../domain/team-collaboration'
import type { TeamContinuitySnapshot } from '../../../domain/team-continuity'
import type { TeamMemorySnapshot } from '../../../domain/team-memory'
import type { DesktopSnapshot } from '../../../shared/desktop-api'

const NOW = Date.now()
const MIN = 60_000

const bundle = createConfiguredTeamBundle({
  workspaceId: 'wedge-demo',
  workspaceName: 'wedge-demo',
  workspacePath: '/Users/demo/projects/wedge-demo',
  members: [
    { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
    { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] },
    { channelId: '3', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }
  ],
  now: NOW - 26 * 60 * MIN
})

function usage(ratio: number, limit = 1_000_000): ContextUsage {
  return { used: Math.round(limit * ratio), limit, ratio }
}

export const sessions: AgentSession[] = [
  {
    id: 'wedge-demo:ch-1:gen7',
    channelId: '1',
    composerId: 'composer-01',
    composerTitle: '协调团队目标拆解',
    generation: 7,
    displayName: '主控协调 · CH-1',
    roleName: '主控席',
    modelName: undefined,
    executionProfile: {
      scope: 'cursor-composer-current',
      modelId: 'fable-5',
      displayName: 'Fable 5',
      options: ['Think', '1M'],
      maxMode: true,
      contextTokenLimit: 1_000_000
    },
    status: 'waiting',
    currentTask: '拆解发布前验收清单',
    startedAt: NOW - 74 * MIN,
    lastSeenAt: NOW - 20_000,
    queueDepth: 0,
    connectionPhase: 'waiting',
    online: true,
    connected: true,
    waiting: true,
    contextUsage: usage(0.37),
    changes: { additions: 128, deletions: 9, files: 6 },
    workingFiles: ['docs/plan.md'],
    healthEvidence: ['mcp-heartbeat', 'composer-presence'],
    telemetry: { state: 'bound', detail: 'Cursor 遥测已绑定（launch marker）', source: 'cursor-local' }
  },
  {
    id: 'wedge-demo:ch-2:gen7',
    channelId: '2',
    composerId: 'composer-02',
    composerTitle: '实现会话时间线气泡',
    generation: 7,
    displayName: '架构实现 · CH-2',
    roleName: '实现席',
    modelName: undefined,
    executionProfile: {
      scope: 'cursor-composer-current',
      modelId: 'fable-5',
      displayName: 'Fable 5',
      options: ['Think'],
      maxMode: false,
      contextTokenLimit: 1_000_000
    },
    status: 'running',
    currentTask: '重构消息工作台气泡体系',
    startedAt: NOW - 26 * MIN,
    lastSeenAt: NOW - 5_000,
    queueDepth: 1,
    connectionPhase: 'processing',
    online: true,
    connected: true,
    waiting: false,
    contextUsage: usage(0.72),
    changes: { additions: 275, deletions: 17, files: 10 },
    workingFiles: ['src/renderer/src/SessionWorkspace.tsx'],
    healthEvidence: ['mcp-heartbeat', 'cursor-run'],
    telemetry: { state: 'bound', detail: 'Cursor 遥测已绑定（channel marker）', source: 'cursor-local' }
  },
  {
    id: 'wedge-demo:ch-3:gen7',
    channelId: '3',
    composerId: undefined,
    composerTitle: undefined,
    generation: 7,
    displayName: '质量验证 · CH-3',
    roleName: '验收席',
    status: 'offline',
    currentTask: '',
    startedAt: NOW - 8 * MIN,
    disconnectedAt: NOW - 2 * MIN,
    lastSeenAt: NOW - 42 * MIN,
    queueDepth: 2,
    connectionPhase: 'disconnected',
    online: false,
    connected: false,
    waiting: false,
    deliveryMode: 'queued',
    roleTemplateKey: 'solo',
    contextUsage: usage(0.91),
    changes: undefined,
    workingFiles: [],
    healthEvidence: ['连接中断，等待重新取得心跳'],
    telemetry: { state: 'stale', detail: '遥测数据超过 30 分钟未更新' }
  }
]

export const conversations: Record<string, ConversationEntry[]> = {
  // 独立席位（离线）：两条仍在队列的用户消息，其中一条带会话交接的「等待新会话」保持位。
  '3': [
    {
      id: 'outbox:solo-1',
      channelId: '3',
      role: 'user',
      text: '把 docs/OPTIMIZATION-BACKLOG.md 里 2.1 的硬编码 hex 收敛进设计令牌。',
      timestamp: NOW - 40 * MIN,
      deliveredAt: NOW - 40 * MIN + 2_000,
      status: 'complete',
      source: 'desktop'
    },
    {
      id: 'reply:solo-1',
      channelId: '3',
      role: 'assistant',
      text: '已收敛 styles.css 中过程徽章区的 38 处 hex 到 --color-* 令牌，`npm test` 全绿。',
      timestamp: NOW - 34 * MIN,
      status: 'complete',
      source: 'cursor',
      replyToEntryId: 'outbox:solo-1'
    },
    {
      id: 'outbox:solo-2',
      channelId: '3',
      role: 'user',
      text: '继续处理 3.1：把 fs-10 的关键状态文本提到 11px 基线，并抽测浅色主题对比度。',
      timestamp: NOW - 6 * MIN,
      status: 'complete',
      source: 'desktop'
    },
    {
      id: 'outbox:solo-3',
      channelId: '3',
      role: 'user',
      text: '【会话交接】CH-3（质量验证 · CH-3） 上一段会话的上下文 · 2026-09-04 20:05\n\n你是该席位重建后的新会话。请先阅读并接续下面的上下文，再处理后续消息：\n\n1. Cursor 会话转录（JSONL）：\n   /Users/lyr/.cursor/projects/Users-lyr-Downloads-20260904/agent-transcripts/6cb64c14-e08d-4b31-860d-a598595fc601/6cb64c14-e08d-4b31-860d-a598595fc601.jsonl',
      timestamp: NOW - 2 * MIN,
      status: 'complete',
      source: 'desktop',
      heldForNextSession: true
    }
  ],
  '2': [
    {
      id: 'e1',
      channelId: '2',
      role: 'user',
      text: '进入持续对话模式，反复调用 SG Team 的 check_messages 接收消息。每轮回复结束后先 record_reply 同步全文，再继续 check_messages。',
      timestamp: NOW - 26 * 60 * MIN,
      status: 'complete',
      source: 'desktop'
    },
    {
      id: 'e2',
      channelId: '2',
      role: 'assistant',
      text: '收到，本窗口已绑定 SG Team CH-2。我先按工作区约定读取 AGENTLOG.md 了解现状，然后进入持续对话循环等待插件侧消息。',
      timestamp: NOW - 26 * 60 * MIN + 40_000,
      status: 'complete',
      source: 'cursor',
      processBlocks: [
        { kind: 'thinking', id: 'pb-t1', text: '用户要求先读取 AGENTLOG.md 再进入循环。需要确认工作区约定与通道编号，避免读到其他通道的日志。'.repeat(3), status: 'done' },
        { kind: 'tool', id: 'pb-1', toolName: 'Read', toolKind: 'read', summary: 'AGENTLOG.md', input: { path: 'AGENTLOG.md' }, output: '# AGENTLOG\n\n## 通道约定\n...', status: 'done' },
        { kind: 'command', id: 'pb-2', command: 'npm test', output: 'Test Files  49 passed (49)\nTests  349 passed (349)', exitCode: 0, status: 'done' },
        { kind: 'tool', id: 'pb-3', toolName: 'Shell', toolKind: 'command', summary: 'npm run lint', status: 'failed', error: 'ESLint 配置缺失：.eslintrc 不存在' }
      ]
    },
    {
      id: 'e3',
      channelId: '2',
      role: 'user',
      text: '如图去找到这个项目，然后先来深度了解，记住不要使用 subagent。',
      timestamp: NOW - 55 * MIN,
      status: 'complete',
      source: 'desktop',
      attachments: [
        {
          id: 'att-1',
          name: 'dashboard-screenshot.png',
          mimeType: 'image/svg+xml',
          size: 8_192,
          previewUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" rx="8" fill="%23e9eef5"/><text x="80" y="55" font-size="12" text-anchor="middle" fill="%235a7a9e">截图预览</text></svg>'
        },
        { id: 'att-2', name: '架构说明.md', mimeType: 'text/markdown', size: 4_096, path: '/Users/demo/projects/wedge-demo/docs/架构说明.md' }
      ]
    },
    {
      id: 'e4',
      channelId: '2',
      role: 'user',
      text: '补充：了解完之后给我一份完整的架构报告。',
      timestamp: NOW - 54 * MIN,
      status: 'complete',
      source: 'desktop'
    },
    {
      id: 'e5',
      channelId: '2',
      role: 'assistant',
      text: '收到 **CH-2** 更新：「工作区结构与 MCP 配置审计」已提交验收。\n\n## 当前结论\n\n- 配置审计已经完成\n- CH-3 可以开始独立验收\n\n## 下一步\n\n等待 CH-3 给出验收结果。\n\n| 项目 | 状态 |\n| --- | --- |\n| MCP 通道 | 4 个正常 |\n| 任务 | review |',
      timestamp: NOW - 52 * MIN,
      status: 'complete',
      source: 'cursor'
    },
    {
      id: 'e6',
      channelId: '2',
      role: 'user',
      text: '很好，现在开始美化整个软件面板。',
      timestamp: NOW - 6 * MIN,
      status: 'complete',
      source: 'desktop'
    },
    {
      id: 'e7',
      channelId: '2',
      role: 'error',
      text: '通道投递超时：Cursor Agent 未在 30 秒内确认接收。',
      timestamp: NOW - 5 * MIN,
      status: 'failed',
      source: 'desktop',
      error: '投递超时'
    },
    {
      id: 'e8',
      channelId: '2',
      role: 'user',
      text: '重发：开始美化整个软件面板，先从设计令牌开始。',
      timestamp: NOW - 4 * MIN,
      status: 'complete',
      source: 'desktop'
    },
    {
      id: 'e9',
      channelId: '2',
      role: 'assistant',
      text: '正在统一设计令牌：合并双 CSS 变量体系、建立字号阶梯（最小 10px）、圆角与阴影三档、tabular-nums 数字…',
      timestamp: NOW - 40_000,
      status: 'streaming',
      source: 'cursor',
      streamId: 'stream-demo'
    },
    {
      id: 'e10',
      channelId: '2',
      role: 'assistant',
      text: [
        '架构报告已整理完毕，核心结论如下。',
        '',
        '## 一、分层总览',
        '',
        '项目采用 domain / application / infrastructure / main / preload / renderer / mcp 七层划分，依赖方向严格单向。领域层零依赖，承载全部协议常量与状态机；应用层组合仓储与服务；基础设施层落地 SQLite 与 Cursor 本机遥测。',
        '',
        '## 二、关键链路',
        '',
        '1. 消息链路：renderer → IPC → relay → outbox → MCP 长轮询 → Agent；回复反向经 record_reply 落库后由 relay 轮询消费进时间线。',
        '2. 过程链路：Cursor 内存模型写入后通过 CDP binding 直推，拾光按原生顺序渲染 thinking、工具状态与输出。',
        '3. 活性链路：presence 分相阈值（processing 30 分钟 / waiting 120 秒），遥测侧按 transcript 与 composer 索引水合。',
        '',
        '## 三、风险与建议',
        '',
        '- 数据库 WAL 持续增长需要定期 checkpoint；',
        '- Cursor 更新后需要验证原生字段锚点是否漂移；',
        '- 长回复在会话气泡中折叠展示，展开全文需用户主动点击；',
        '- 附件同名落盘已做去重，批量上传同名截图不再互相覆盖。',
        '',
        '以上为完整结论，后续按优先级推进即可。',
        '',
        '接下来可以：',
        '1. 补齐过程视图的浏览器回归测试',
        '2. 提交当前界面重构',
        '3. 观察实时消息链路',
        '4. 更新实现状态文档'
      ].join('\n'),
      timestamp: NOW - 20_000,
      status: 'complete',
      source: 'cursor'
    },
    {
      id: 'e11',
      channelId: '2',
      role: 'assistant',
      text: [
        '返工完成，核心改动如下。',
        '',
        '```typescript',
        'const pendingConfirmation = await this.repository.waitForDeliveryConfirmation(channelId, message.id, { timeoutMs: 30_000, pollIntervalMs: 250, requireAcknowledgement: true })',
        "const upsert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')",
        'await Promise.all(channels.map(async (channel) => this.dispatchWithRetry(channel, payload, { maxAttempts: 3, backoff: exponentialBackoff({ base: 500, factor: 2 }) })))',
        '```',
        '',
        '验证：typecheck ✓；vitest 59 文件 444/444 ✓。'
      ].join('\n'),
      timestamp: NOW - 10_000,
      status: 'complete',
      source: 'cursor'
    }
  ],
  '1': [
    {
      id: 'a1',
      channelId: '1',
      role: 'assistant',
      text: '主控席就位，团队目标已拆解为 5 条可验收任务。',
      timestamp: NOW - 30 * MIN,
      status: 'complete',
      source: 'cursor'
    }
  ]
}

export const desktopSnapshot: DesktopSnapshot = {
  connection: {
    state: 'connected',
    endpoint: 'shiguang://local-channel-runtime',
    attempt: 0,
    lastError: ''
  },
  sessions,
  conversations,
  liveProcess: {
    '2': {
      turn: 'turn-demo-1',
      startedAt: NOW - 24_000,
      updatedAt: NOW - 8_000,
      blocks: [
        { kind: 'thinking', id: 'live-1', text: '正在比对渲染层挂接点与数据契约，确认原生事件顺序与状态翻转……', status: 'done', durationMs: 3_200 },
        { kind: 'message', id: 'live-message', text: '先检查过程卡的实时渲染，再运行浏览器验证。', status: 'done' },
        { kind: 'tool', id: 'live-2', toolName: 'Search', toolKind: 'search', summary: 'process 展示', status: 'done', output: '命中 3 个文件' },
        { kind: 'tool', id: 'live-3', toolName: 'browser_navigate', toolKind: 'browser', summary: 'http://127.0.0.1:5173', status: 'done', output: '页面已加载' },
        { kind: 'tool', id: 'live-4', toolName: 'run_terminal_cmd', toolKind: 'command', summary: 'npx vitest run tests/relay', status: 'running', input: { command: 'npx vitest run tests/relay' } },
        {
          kind: 'tool', id: 'live-todos', toolName: 'todos', toolKind: 'todo', summary: '任务清单 1/3', status: 'running',
          todos: [
            { content: '核对右侧工作区信息架构', status: 'completed' },
            { content: '实现 Review 与 Cursor Todos 标签', status: 'in_progress' },
            { content: '完成响应式和透明模式走查', status: 'pending' }
          ]
        },
        // 进行中的思考：头部显示「Thinking」+ 脉冲点；结束后变「Thought for Ns」（上面 live-1）。
        { kind: 'thinking', id: 'live-5', text: '测试全绿，接下来核对右侧工作区在窄栏下的折叠行为，再决定是否需要补一条回归用例……', status: 'running' }
      ]
    }
  },
  liveAgentResponses: {
    '2': {
      id: 'preview-live-response',
      channelId: '2',
      text: '正在统一过程视图：实时步骤已经归一到同一回合，接下来会完成类型检查并整理最终结论。',
      status: 'streaming',
      startedAt: NOW - 5_000,
      updatedAt: NOW - 500
    }
  },
  cursorModels: [
    {
      modelId: 'composer-2.5',
      displayName: 'Composer 2.5',
      parameters: [{ id: 'fast', value: 'true' }],
      selected: true,
      supportsMaxMode: true,
      supportsNonMaxMode: true,
      optionLabels: ['Fast'],
      parameterDefinitions: [{
        id: 'fast',
        displayName: 'Fast',
        kind: 'boolean',
        values: [
          { value: 'false', displayName: 'Off', increasesCost: false },
          { value: 'true', displayName: 'Fast', increasesCost: true }
        ]
      }],
      contextTokenLimit: 200_000,
      contextTokenLimitForMaxMode: 200_000
    },
    {
      modelId: 'claude-fable-5',
      displayName: 'Claude Fable 5',
      parameters: [
        { id: 'thinking', value: 'true' },
        { id: 'context', value: '1m' },
        { id: 'effort', value: 'max' }
      ],
      selected: false,
      supportsMaxMode: true,
      supportsNonMaxMode: true,
      optionLabels: [],
      parameterDefinitions: [
        {
          id: 'thinking', displayName: 'Thinking', kind: 'boolean',
          values: [
            { value: 'false', displayName: 'Off', increasesCost: false },
            { value: 'true', displayName: 'On', increasesCost: false }
          ]
        },
        {
          id: 'context', displayName: 'Context', kind: 'enum',
          values: [
            { value: '300k', displayName: '300K', increasesCost: false },
            { value: '1m', displayName: '1M', increasesCost: true }
          ]
        },
        {
          id: 'effort', displayName: 'Effort', kind: 'enum',
          values: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
            value,
            displayName: value === 'xhigh' ? 'Extra High' : value[0]!.toUpperCase() + value.slice(1),
            increasesCost: false
          }))
        }
      ],
      contextTokenLimit: 300_000,
      contextTokenLimitForMaxMode: 1_000_000
    },
    {
      modelId: 'gpt-5.2',
      displayName: 'GPT-5.2',
      parameters: [{ id: 'reasoning', value: 'medium' }],
      selected: false,
      supportsMaxMode: true,
      supportsNonMaxMode: true,
      optionLabels: [],
      parameterDefinitions: [{
        id: 'reasoning', displayName: 'Reasoning', kind: 'enum',
        values: ['low', 'medium', 'high', 'extra-high'].map((value) => ({
          value,
          displayName: value === 'extra-high' ? 'Extra High' : value[0]!.toUpperCase() + value.slice(1),
          increasesCost: false
        }))
      }],
      contextTokenLimit: 272_000,
      contextTokenLimitForMaxMode: 272_000
    }
  ],
  protocolIssues: ['CH-3 收到无法关联的 submitResult'],
  updatedAt: NOW
}

const members: TeamMemberView[] = bundle.slots.map((slot, index) => {
  const role = bundle.roles.find((candidate) => candidate.id === slot.roleId)!
  const session = sessions[index]!
  return {
    slot,
    role,
    binding: {
      id: `binding-${index + 1}`,
      workspaceId: bundle.workspace.id,
      runId: bundle.run.id,
      slotId: slot.id,
      channelId: slot.channelId!,
      agentSessionId: session.id,
      generation: 'a1b2c3d4e5f6',
      installedAt: NOW - 30 * 60 * MIN,
      launchStatus: index === 2 ? 'uncertain' : 'acknowledged',
      launchDetail: index === 2 ? '通道离线，启动确认超时' : '已确认',
      acknowledgedAt: NOW - 25 * 60 * MIN,
      lastCheckInAt: NOW - 10 * MIN,
      lastCheckInNote: '已读取团队目标',
      composerBindingKey: `bind-${index + 1}`
    },
    runtime: {
      channelId: slot.channelId!,
      status: session.status,
      online: session.online,
      waiting: session.waiting,
      queueDepth: session.queueDepth,
      lastSeenAt: session.lastSeenAt,
      healthEvidence: session.healthEvidence,
      workingFiles: session.workingFiles
    },
    readiness: index === 0 ? 'ready' : index === 1 ? 'active' : 'offline'
  }
})

const previewStandbyChannels = [
  {
    channelId: '4',
    displayName: 'SG Team CH-4',
    status: 'waiting' as const,
    online: true,
    waiting: true,
    queueDepth: 0,
    registered: true,
    agentSessionId: 'wedge-demo:ch-4:gen7',
    generation: 'gen7'
  },
  {
    channelId: '5',
    displayName: 'SG Team CH-5',
    status: 'offline' as const,
    online: false,
    waiting: false,
    queueDepth: 0,
    registered: true,
    agentSessionId: 'wedge-demo:ch-5:gen7',
    generation: 'gen7'
  }
]

export const teamControlSnapshot: TeamControlSnapshot = {
  schemaVersion: 7,
  revision: 42,
  activeWorkspaceId: bundle.workspace.id,
  workspaces: [bundle.workspace],
  runs: [{ ...bundle.run, goal: '完成拾光桌面端视觉与交互升级，并保证全部测试通过。', status: 'running' }],
  roles: bundle.roles,
  slots: bundle.slots,
  bindings: members.map((member) => member.binding!),
  updatedAt: NOW - 3 * MIN,
  activeRun: { ...bundle.run, goal: '完成拾光桌面端视觉与交互升级，并保证全部测试通过。', status: 'running' },
  members,
  runtimeChannels: [...sessions.map((session) => ({
    channelId: session.channelId,
    displayName: session.displayName,
    status: session.status,
    online: session.online,
    waiting: session.waiting,
    queueDepth: session.queueDepth,
    registered: true,
    assignedSlotId: members.find((member) => member.binding?.channelId === session.channelId)?.slot.id,
    agentSessionId: members.find((member) => member.binding?.channelId === session.channelId)?.binding?.agentSessionId,
    generation: 'gen7'
  })), ...previewStandbyChannels],
  standbyChannels: previewStandbyChannels,
  failovers: [{
    id: 'team-failover:preview-1',
    workspaceId: bundle.workspace.id,
    runId: bundle.run.id,
    slotId: bundle.slots[1]!.id,
    roleName: '架构实现',
    fromChannelId: '6',
    fromAgentSessionId: 'wedge-demo:ch-6:old',
    toChannelId: '2',
    toAgentSessionId: members[1]!.binding!.agentSessionId,
    status: 'completed',
    reason: '旧 Cursor Agent 停止监听，已由备用运行时接替',
    checkpointId: 'checkpoint-preview',
    messageId: 'message-preview',
    taskIds: ['t2'],
    detectedAt: NOW - 32 * MIN,
    updatedAt: NOW - 31 * MIN,
    completedAt: NOW - 31 * MIN
  }],
  preflight: {
    bridgeConnected: true,
    workspaceBound: true,
    goalDefined: true,
    mcpInstalled: true,
    agentsWaiting: true,
    canLaunch: true,
    blockers: []
  }
}

const taskDefs = [
  { id: 't1', key: 'design-tokens', title: '统一设计令牌与字号体系', status: 'done' as const, priority: 1, progress: 100, attempts: 1 },
  { id: 't2', key: 'chat-bubbles', title: '重构会话时间线为气泡体系', status: 'running' as const, priority: 0, progress: 62, attempts: 1 },
  { id: 't3', key: 'memory-ui', title: '团队共识审核界面', status: 'review' as const, priority: 1, progress: 100, attempts: 1 },
  { id: 't4', key: 'brand-team', title: '统一拾光品牌标识', status: 'queued' as const, priority: 2, progress: 0, attempts: 0 },
  { id: 't5', key: 'a11y-pass', title: '可访问性走查与修复', status: 'failed' as const, priority: 3, progress: 0, attempts: 3 }
]

export const taskPoolSnapshot: TaskPoolSnapshot = {
  schemaVersion: 3,
  workspaceId: bundle.workspace.id,
  runId: bundle.run.id,
  scopeRevision: 6,
  revision: 18,
  seq: 40,
  tasks: Object.fromEntries(taskDefs.map((def, index) => [def.id, {
    id: def.id,
    runId: bundle.run.id,
    key: def.key,
    title: def.title,
    description: index === 1 ? '微信式气泡、连续消息分组、时间分隔线、复制与引用操作。' : '按验收标准执行并留下证据。',
    acceptance: '构建通过、测试全绿、截图走查确认。',
    priority: def.priority,
    status: def.status,
    dependsOn: index === 3 ? ['t1'] : [],
    requiredCapabilities: index === 1 ? ['code', 'architecture'] : [],
    targetSlotId: undefined,
    maxAttempts: 3,
    attemptCount: def.attempts,
    progress: def.progress,
    assigneeSessionId: def.status === 'running' ? sessions[1]!.id : undefined,
    currentAttemptId: def.status === 'running' ? 'attempt-2' : def.status === 'review' ? 'attempt-3' : undefined,
    currentReviewId: def.status === 'review' ? 'review-3' : undefined,
    result: def.status === 'done' ? '设计令牌已统一，双变量体系合并。' : undefined,
    failureReason: def.status === 'failed' ? '3 次尝试后仍有对比度不达标项，需人工定夺。' : undefined,
    createdAt: NOW - (30 - index * 3) * MIN,
    updatedAt: NOW - (10 - index) * MIN
  }])),
  taskOrder: taskDefs.map((def) => def.id),
  attempts: {
    'attempt-2': {
      id: 'attempt-2', taskId: 't2', number: 1, agentSessionId: sessions[1]!.id,
      status: 'running', progress: 62, summary: '气泡体系完成 62%', createdAt: NOW - 20 * MIN,
      startedAt: NOW - 19 * MIN, updatedAt: NOW - 4 * MIN
    },
    'attempt-3': {
      id: 'attempt-3', taskId: 't3', number: 1, agentSessionId: sessions[1]!.id,
      status: 'review', progress: 100, summary: '等待独立验收', output: '团队共识审核界面已完成',
      createdAt: NOW - 25 * MIN, startedAt: NOW - 24 * MIN, updatedAt: NOW - 12 * MIN
    }
  },
  reviews: {
    'review-3': {
      id: 'review-3', taskId: 't3', attemptId: 'attempt-3', status: 'queued', leaseCount: 0, evidence: '',
      createdAt: NOW - 12 * MIN, updatedAt: NOW - 12 * MIN
    }
  },
  reviewOrder: ['review-3'],
  events: [
    { seq: 38, type: 'task.progress', taskId: 't2', attemptId: 'attempt-2', agentSessionId: sessions[1]!.id, detail: '气泡体系完成 62%', at: NOW - 4 * MIN },
    { seq: 39, type: 'task.submitted', taskId: 't3', attemptId: 'attempt-3', agentSessionId: sessions[1]!.id, at: NOW - 12 * MIN },
    { seq: 40, type: 'task.approved', taskId: 't1', attemptId: 'attempt-1', agentSessionId: sessions[0]!.id, at: NOW - 18 * MIN }
  ]
}

const messages: TeamMessage[] = [
  {
    id: 'm1',
    runId: bundle.run.id,
    threadId: 'thread-1',
    sender: { type: 'operator' },
    recipient: { type: 'agent', slotId: bundle.slots[1]!.id },
    kind: 'directive',
    content: '把会话面板升级为微信式气泡，注意保留天色三档语义。',
    clientMessageId: 'op-msg-01',
    createdAt: NOW - 40 * MIN,
    receipt: {
      notificationState: 'notified',
      notificationDetail: '已通过通道投递',
      notifiedAt: NOW - 39 * MIN,
      readAt: NOW - 38 * MIN,
      respondedAt: NOW - 30 * MIN,
      responseMessageId: 'm2',
      updatedAt: NOW - 30 * MIN
    }
  },
  {
    id: 'm2',
    runId: bundle.run.id,
    threadId: 'thread-1',
    sender: { type: 'agent', slotId: bundle.slots[1]!.id },
    recipient: { type: 'operator' },
    kind: 'response',
    content: '收到。方案：气泡方向区分角色、连续消息分组、超过 10 分钟插入时间分隔线；复制与引用做成真实操作。',
    replyToMessageId: 'm1',
    clientMessageId: 'agent-msg-02',
    createdAt: NOW - 30 * MIN,
    receipt: {
      notificationState: 'not_required',
      notificationDetail: '',
      readAt: NOW - 29 * MIN,
      updatedAt: NOW - 29 * MIN
    }
  },
  {
    id: 'm3',
    runId: bundle.run.id,
    threadId: 'thread-2',
    sender: { type: 'agent', slotId: bundle.slots[0]!.id },
    recipient: { type: 'agent', slotId: bundle.slots[2]!.id },
    kind: 'question',
    content: '验收席：气泡对比度是否达到 AA？请给出检查结论。',
    clientMessageId: 'lead-msg-03',
    createdAt: NOW - 15 * MIN,
    receipt: {
      notificationState: 'uncertain',
      notificationDetail: 'CH-3 离线，投递结果不确定',
      updatedAt: NOW - 14 * MIN
    }
  }
]

export const collaborationSnapshot: TeamCollaborationSnapshot = {
  schemaVersion: 1,
  revision: 9,
  seq: 12,
  runId: bundle.run.id,
  threads: [
    { id: 'thread-1', runId: bundle.run.id, subject: '会话面板升级', createdAt: NOW - 40 * MIN, updatedAt: NOW - 30 * MIN },
    { id: 'thread-2', runId: bundle.run.id, subject: '气泡对比度验收', createdAt: NOW - 15 * MIN, updatedAt: NOW - 14 * MIN }
  ],
  messages: Object.fromEntries(messages.map((message) => [message.id, message])),
  messageOrder: messages.map((message) => message.id),
  events: [
    { seq: 11, type: 'message.responded', runId: bundle.run.id, threadId: 'thread-1', messageId: 'm2', actor: { type: 'agent', slotId: bundle.slots[1]!.id }, at: NOW - 30 * MIN },
    { seq: 12, type: 'message.created', runId: bundle.run.id, threadId: 'thread-2', messageId: 'm3', actor: { type: 'agent', slotId: bundle.slots[0]!.id }, at: NOW - 15 * MIN }
  ],
  updatedAt: NOW - 14 * MIN
}

export const continuitySnapshot: TeamContinuitySnapshot = {
  schemaVersion: 1,
  revision: 6,
  workspaceId: bundle.workspace.id,
  runId: bundle.run.id,
  checkpoints: [
    {
      id: 'cp-2',
      workspaceId: bundle.workspace.id,
      runId: bundle.run.id,
      reason: 'automatic',
      digest: 'digest-2',
      capsule: {
        schemaVersion: 1,
        goal: '完成拾光桌面端视觉与交互升级。',
        runName: bundle.run.name,
        runStatus: 'running',
        members: bundle.slots.map((slot) => ({
          slotId: slot.id,
          roleKey: bundle.roles.find((role) => role.id === slot.roleId)!.key,
          roleName: bundle.roles.find((role) => role.id === slot.roleId)!.name,
          channelId: slot.channelId,
          workingFiles: sessions.find((session) => session.channelId === slot.channelId)?.workingFiles ?? []
        })),
        activeTasks: [
          { id: 't2', title: '重构会话时间线为气泡体系', status: 'running', progress: 62, summary: '气泡+分组已完成' },
          { id: 't3', title: '团队共识审核界面', status: 'review', progress: 100 }
        ],
        pendingMessages: [
          { id: 'm3', sender: { type: 'agent', slotId: bundle.slots[0]!.id }, recipient: { type: 'agent', slotId: bundle.slots[2]!.id }, kind: 'question', content: '气泡对比度是否达到 AA？', stage: 'uncertain' }
        ],
        sharedMemory: [
          { id: 'mem-2', kind: 'constraint', title: '正文字号不低于 12px', content: '中文正文最小 12px。', version: 1 }
        ],
        capturedAt: NOW - 8 * MIN
      },
      createdAt: NOW - 8 * MIN
    },
    {
      id: 'cp-1',
      workspaceId: bundle.workspace.id,
      runId: bundle.run.id,
      reason: 'automatic',
      digest: 'digest-1',
      capsule: {
        schemaVersion: 1,
        goal: '完成拾光桌面端视觉与交互升级。',
        runName: bundle.run.name,
        runStatus: 'running',
        members: [],
        activeTasks: [],
        pendingMessages: [],
        sharedMemory: [],
        capturedAt: NOW - 60 * MIN
      },
      createdAt: NOW - 60 * MIN
    }
  ],
  updatedAt: NOW - 8 * MIN
}

export const memorySnapshot: TeamMemorySnapshot = {
  schemaVersion: 1,
  revision: 11,
  seq: 15,
  workspaceId: bundle.workspace.id,
  runId: bundle.run.id,
  items: {
    'mem-p1': {
      id: 'mem-p1',
      workspaceId: bundle.workspace.id,
      runId: bundle.run.id,
      scope: 'run',
      kind: 'decision',
      title: '上下文压力使用天色三档语义',
      content: '上下文占用 <60% 晴（青绿）、60–85% 午后（琥珀）、≥85% 日暮（红），同时作用于进度条与圆环仪表。',
      status: 'proposed',
      version: 1,
      proposedBy: { type: 'agent', slotId: bundle.slots[1]!.id },
      sources: [{ type: 'file', ref: 'src/renderer/src/format.ts', label: 'contextTone 实现' }],
      createdAt: NOW - 20 * MIN,
      updatedAt: NOW - 20 * MIN
    },
    'mem-p2': {
      id: 'mem-p2',
      workspaceId: bundle.workspace.id,
      runId: bundle.run.id,
      scope: 'project',
      kind: 'risk',
      title: '改 productName 会导致 userData 漂移',
      content: '彻底改名需要数据迁移方案：appId/productName 决定 userData 目录，直接改会让任务池与记忆数据丢失。',
      status: 'proposed',
      version: 1,
      proposedBy: { type: 'agent', slotId: bundle.slots[0]!.id },
      sources: [{ type: 'file', ref: 'package.json', label: '打包配置' }],
      createdAt: NOW - 9 * MIN,
      updatedAt: NOW - 9 * MIN
    },
    'mem-a1': {
      id: 'mem-a1',
      workspaceId: bundle.workspace.id,
      runId: bundle.run.id,
      scope: 'run',
      kind: 'constraint',
      title: '正文字号不低于 12px',
      content: '中文正文最小 12px；10px 仅用于时间戳等辅助信息。',
      status: 'accepted',
      version: 1,
      proposedBy: { type: 'agent', slotId: bundle.slots[1]!.id },
      reviewedBy: { type: 'operator' },
      acceptedAt: NOW - 50 * MIN,
      sources: [{ type: 'file', ref: 'src/renderer/src/styles.css', label: '设计令牌' }],
      createdAt: NOW - 55 * MIN,
      updatedAt: NOW - 50 * MIN
    },
    'mem-a2': {
      id: 'mem-a2',
      workspaceId: bundle.workspace.id,
      runId: bundle.run.id,
      scope: 'project',
      kind: 'lesson',
      title: '禁用按钮必须可解释',
      content: '任何禁用控件都要有 title 说明原因；没有后端支撑的功能不放假按钮。',
      status: 'accepted',
      version: 2,
      proposedBy: { type: 'agent', slotId: bundle.slots[2]!.id },
      reviewedBy: { type: 'agent', slotId: bundle.slots[0]!.id },
      acceptedAt: NOW - 100 * MIN,
      sources: [{ type: 'file', ref: 'docs/DESIGN-SYSTEM.md', label: '设计体系' }],
      createdAt: NOW - 120 * MIN,
      updatedAt: NOW - 100 * MIN
    }
  },
  itemOrder: ['mem-p2', 'mem-p1', 'mem-a1', 'mem-a2'],
  events: [],
  updatedAt: NOW - 9 * MIN
}
