import { describe, expect, it } from 'vitest'
import { AgentSessionLauncher, type AgentLaunchCreateReceipt } from '../src/application/agent-session-launcher'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import type { AgentLaunchPlan } from '../src/domain/agent-launch'
import type { CursorModelSelection } from '../src/domain/cursor-model'

interface FakeSession {
  channelId: string
  online: boolean
  waiting: boolean
  composerId?: string
  lastAgentActivityAt?: number
}

interface HarnessOptions {
  prompts?: Record<string, string>
  promptErrors?: Record<string, string>
  createResults?: Record<string, AgentLaunchCreateReceipt>
  bindingKeys?: Record<string, string>
  relaunchBindingKeys?: Record<string, string>
  modelSelections?: Record<string, CursorModelSelection>
  workspacePath?: string
  onAllTriggered?: (plan: AgentLaunchPlan) => void
  onFinished?: (plan: AgentLaunchPlan) => void
}

function snapshotWith(sessions: FakeSession[]): DesktopSnapshot {
  return { sessions } as unknown as DesktopSnapshot
}

function createHarness(initial: FakeSession[], options: HarnessOptions = {}) {
  const state = { sessions: new Map(initial.map((session) => [session.channelId, { ...session }])) }
  const promptCalls: string[] = []
  const createCalls: Array<{
    channelId: string
    name: string
    prompt: string
    workspacePath?: string
    modelSelection?: CursorModelSelection
  }> = []
  const launcher = new AgentSessionLauncher(
    {
      fetchStartPrompt: async (channelId) => {
        promptCalls.push(channelId)
        const error = options.promptErrors?.[channelId]
        if (error) throw new Error(error)
        return options.prompts?.[channelId] ?? `PROMPT-CH-${channelId}`
      }
    },
    {
      createAgentSession: async (input) => {
        createCalls.push(input)
        return options.createResults?.[input.channelId]
          ?? { ok: true, message: '会话已创建并提交开场提示词', composerId: `composer-${input.channelId}` }
      }
    },
    {
      activeWorkspacePath: () => options.workspacePath,
      bindingKeyForChannel: (channelId) => options.bindingKeys?.[channelId],
      prepareComposerRelaunch: (channelId) => options.relaunchBindingKeys?.[channelId],
      modelSelectionForChannel: (channelId) => options.modelSelections?.[channelId]
    },
    { getSnapshot: () => snapshotWith([...state.sessions.values()]) },
    { sleep: async () => {}, pollIntervalMs: 1, triggerTimeoutMs: 50, composerTimeoutMs: 50, waitingTimeoutMs: 50, onAllTriggered: options.onAllTriggered, onFinished: options.onFinished }
  )
  return { launcher, promptCalls, createCalls, state }
}

function readyComposer(state: { sessions: Map<string, FakeSession> }, channelId: string, composerId: string): void {
  state.sessions.set(channelId, { channelId, online: true, waiting: false, composerId })
}

function readyWaiting(state: { sessions: Map<string, FakeSession> }, channelId: string, composerId: string): void {
  state.sessions.set(channelId, { channelId, online: true, waiting: true, composerId })
}

describe('AgentSessionLauncher', () => {
  it('完整三级证据：CDP 硬回执→遥测绑定该 composer→waiting，判定成功', async () => {
    const { launcher, state } = createHarness([{ channelId: '2', online: true, waiting: false }])
    const progress: AgentLaunchPlan[] = []
    const pending = launcher.launch(['2'], (plan) => progress.push(plan))
    await Promise.resolve()
    readyComposer(state, '2', 'composer-2')
    await Promise.resolve()
    await Promise.resolve()
    readyWaiting(state, '2', 'composer-2')
    const plan = await pending
    expect(plan.state).toBe('done')
    expect(plan.items[0]).toMatchObject({ channelId: '2', stage: 'done', composerId: 'composer-2' })
    expect(progress.some((item) => item.items[0]?.stage === 'composer')).toBe(true)
  })

  it('trigger 级即拿到真实 composerId（硬回执），不再依赖猜测', async () => {
    const { launcher, state, createCalls } = createHarness([{ channelId: '2', online: true, waiting: false }])
    const progress: AgentLaunchPlan[] = []
    const pending = launcher.launch(['2'], (plan) => progress.push(plan))
    // CDP 回执一到，计划项立刻携带 composerId（此时遥测尚未绑定）
    const seen = () => progress.some((item) => item.items[0]?.stage === 'composer' && item.items[0]?.composerId === 'composer-2')
    for (let i = 0; i < 50 && !seen(); i += 1) await Promise.resolve()
    expect(seen()).toBe(true)
    readyComposer(state, '2', 'composer-2')
    await Promise.resolve()
    readyWaiting(state, '2', 'composer-2')
    const plan = await pending
    expect(plan.state).toBe('done')
    expect(createCalls[0]).toMatchObject({ channelId: '2', name: 'CH-2 · 拾光会话' })
    expect(createCalls[0]?.prompt).toBe('PROMPT-CH-2')
  })

  it('存在未绑定 bindingKey 时，开场白追加精确绑定标记', async () => {
    const { launcher, state, createCalls } = createHarness(
      [{ channelId: '3', online: true, waiting: false }],
      { bindingKeys: { '3': 'bind-abc' } }
    )
    const pending = launcher.launch(['3'])
    await Promise.resolve()
    readyComposer(state, '3', 'composer-3')
    await Promise.resolve()
    readyWaiting(state, '3', 'composer-3')
    const plan = await pending
    expect(plan.state).toBe('done')
    expect(createCalls[0]?.prompt).toContain('[[SG_TEAM_BIND:bind-abc:CH-3]]')
  })

  it('新绑定存在时不复用上一轮仍显示待命的旧 Composer', async () => {
    const { launcher, state, createCalls } = createHarness(
      [{ channelId: '3', online: true, waiting: true, composerId: 'composer-old' }],
      { bindingKeys: { '3': 'bind-new' } }
    )
    const pending = launcher.launch(['3'])
    await Promise.resolve()
    readyComposer(state, '3', 'composer-3')
    await Promise.resolve()
    readyWaiting(state, '3', 'composer-3')
    const plan = await pending
    expect(plan.state).toBe('done')
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.prompt).toContain('[[SG_TEAM_BIND:bind-new:CH-3]]')
  })

  it('离线旧 Composer 先轮换绑定键再创建并绑定新会话', async () => {
    const { launcher, state, createCalls } = createHarness(
      [{ channelId: '3', online: false, waiting: false, composerId: 'composer-old' }],
      { relaunchBindingKeys: { '3': 'bind-relaunch' } }
    )
    const pending = launcher.launch(['3'])
    await Promise.resolve()
    readyComposer(state, '3', 'composer-3')
    await Promise.resolve()
    readyWaiting(state, '3', 'composer-3')
    expect((await pending).state).toBe('done')
    expect(createCalls[0]?.prompt).toContain('[[SG_TEAM_BIND:bind-relaunch:CH-3]]')
  })

  it('取开场提示词失败 → trigger 层失败', async () => {
    const { launcher } = createHarness(
      [{ channelId: '1', online: false, waiting: false }],
      { promptErrors: { '1': '晴天尚未连接' } }
    )
    const plan = await launcher.launch(['1'])
    expect(plan.state).toBe('failed')
    expect(plan.items[0]?.stage).toBe('failed')
    expect(plan.items[0]?.message).toContain('晴天尚未连接')
  })

  it('CDP 拒绝创建 → trigger 层失败并透出原因', async () => {
    const { launcher } = createHarness(
      [{ channelId: '1', online: false, waiting: false }],
      { createResults: { '1': { ok: false, message: 'Cursor 窗口内晴天网关联接未就绪' } } }
    )
    const plan = await launcher.launch(['1'])
    expect(plan.state).toBe('failed')
    expect(plan.items[0]?.message).toContain('晴天网关联接未就绪')
  })

  it('调试端口缺失 → trigger 层失败且标记 cdp_unavailable', async () => {
    const { launcher } = createHarness(
      [{ channelId: '1', online: true, waiting: false }],
      { createResults: { '1': { ok: false, message: '未检测到 Cursor 调试端口（127.0.0.1:9333）' } } }
    )
    const plan = await launcher.launch(['1'])
    expect(plan.state).toBe('failed')
    expect(plan.items[0]?.code).toBe('cdp_unavailable')
  })

  it('工作区路径透传给创建器（用于多窗口定位）', async () => {
    const { launcher, state, createCalls } = createHarness(
      [{ channelId: '2', online: true, waiting: false }],
      { workspacePath: '/Users/test/team-workspace' }
    )
    const pending = launcher.launch(['2'])
    await Promise.resolve()
    readyComposer(state, '2', 'composer-2')
    await Promise.resolve()
    readyWaiting(state, '2', 'composer-2')
    await pending
    expect(createCalls[0]?.workspacePath).toBe('/Users/test/team-workspace')
  })

  it('uses the persisted per-channel model and allows a launch-time override', async () => {
    const persisted: CursorModelSelection = {
      modelId: 'kimi-k3', displayName: 'Kimi K3', parameters: [{ id: 'reasoning', value: 'high' }]
    }
    const override: CursorModelSelection = {
      modelId: 'claude-fable-5', displayName: 'Claude Fable 5', parameters: [
        { id: 'thinking', value: 'true' },
        { id: 'context', value: '1m' },
        { id: 'effort', value: 'max' }
      ]
    }
    const { launcher, state, createCalls } = createHarness(
      [{ channelId: '2', online: true, waiting: false }],
      { modelSelections: { '2': persisted } }
    )
    const pending = launcher.launch([{ channelId: '2', modelSelection: override }])
    await Promise.resolve()
    readyWaiting(state, '2', 'composer-2')
    const plan = await pending
    expect(createCalls[0]?.modelSelection).toEqual(override)
    expect(plan.items[0]?.modelSelection).toEqual(override)
  })

  it('遥测绑定到别的 composerId（非本次回执）→ composer 层失败', async () => {
    const { launcher, state } = createHarness([{ channelId: '3', online: true, waiting: false }])
    const pending = launcher.launch(['3'])
    await Promise.resolve()
    // 遥测绑定了一个陌生 composerId，不等于 CDP 回执的 composer-3
    readyComposer(state, '3', 'composer-stranger')
    const plan = await pending
    expect(plan.state).toBe('failed')
    expect(plan.items[0]?.message).toContain('超时未被遥测确认绑定')
  })

  it('composer 复用旧绑定不算数（必须是全新 composerId）', async () => {
    const { launcher } = createHarness(
      [{ channelId: '4', online: true, waiting: false, composerId: 'composer-old' }],
      { createResults: { '4': { ok: true, message: '', composerId: 'composer-old' } } }
    )
    const plan = await launcher.launch(['4'])
    expect(plan.state).toBe('failed')
  })

  it('waiting 超时 → waiting 层失败并保留 composerId', async () => {
    const { launcher, state } = createHarness([{ channelId: '5', online: true, waiting: false }])
    const pending = launcher.launch(['5'])
    await Promise.resolve()
    readyComposer(state, '5', 'composer-5')
    const plan = await pending
    expect(plan.state).toBe('failed')
    expect(plan.items[0]).toMatchObject({ stage: 'failed', composerId: 'composer-5' })
    expect(plan.items[0]?.message).toContain('未进入待命')
  })

  it('等待阶段有心跳进度，不停留在固定文案（UX 防卡死感）', async () => {
    const { launcher, state } = createHarness([{ channelId: '5', online: true, waiting: false }])
    const progress: AgentLaunchPlan[] = []
    const pending = launcher.launch(['5'], (plan) => progress.push(plan))
    await Promise.resolve()
    readyComposer(state, '5', 'composer-5')
    const plan = await pending
    expect(plan.state).toBe('failed')
    expect(progress.some((entry) => /已等 \d+s/.test(entry.items[0]?.message ?? ''))).toBe(true)
  })

  it('waiting 阶段感知到 Agent 活动时提示「Agent 执行中」', async () => {
    const { launcher, state } = createHarness([{ channelId: '5', online: true, waiting: false }])
    const progress: AgentLaunchPlan[] = []
    const pending = launcher.launch(['5'], (plan) => progress.push(plan))
    await Promise.resolve()
    state.sessions.set('5', { channelId: '5', online: true, waiting: false, composerId: 'composer-5', lastAgentActivityAt: Date.now() })
    const plan = await pending
    expect(plan.state).toBe('failed')
    expect(progress.some((entry) => (entry.items[0]?.message ?? '').includes('Agent 执行中'))).toBe(true)
  })

  it('已待命的通道直接判成功，不重复创建', async () => {
    const { launcher, promptCalls, createCalls } = createHarness([{ channelId: '6', online: true, waiting: true, composerId: 'composer-live' }])
    const plan = await launcher.launch(['6'])
    expect(plan.state).toBe('done')
    expect(plan.items[0]?.message).toContain('已有待命会话')
    expect(promptCalls).toHaveLength(0)
    expect(createCalls).toHaveLength(0)
  })

  it('多通道并发创建：全部触发先于任何验证完成，总耗时取决于最慢通道', async () => {
    const { launcher, state, createCalls } = createHarness([
      { channelId: '1', online: true, waiting: false },
      { channelId: '2', online: true, waiting: false }
    ])
    const pending = launcher.launch(['1', '2'])
    // 并发：两个通道的创建调用都应在任何 composer/waiting 证据出现前完成
    for (let i = 0; i < 50 && createCalls.length < 2; i += 1) await Promise.resolve()
    expect(createCalls.map((call) => call.channelId)).toEqual(['1', '2'])
    expect(state.sessions.get('1')?.composerId).toBeUndefined()
    // CH-1 先就绪不影响 CH-2 独立推进
    readyWaiting(state, '1', 'composer-1')
    readyWaiting(state, '2', 'composer-2')
    const plan = await pending
    expect(plan.state).toBe('done')
    expect(plan.items.map((item) => item.stage)).toEqual(['done', 'done'])
  })

  it('批量创建时每个通道严格携带各自选择的模型与完整参数', async () => {
    const selections: Record<string, CursorModelSelection> = {
      '1': {
        modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', maxMode: true,
        parameters: [
          { id: 'context', value: '1m' },
          { id: 'reasoning', value: 'max' },
          { id: 'fast', value: 'false' }
        ]
      },
      '2': {
        modelId: 'claude-opus-5', displayName: 'Claude Opus 5', maxMode: true,
        parameters: [
          { id: 'thinking', value: 'true' },
          { id: 'context', value: '1m' },
          { id: 'effort', value: 'high' },
          { id: 'fast', value: 'true' }
        ]
      }
    }
    const { launcher, state, createCalls } = createHarness([
      { channelId: '1', online: true, waiting: false },
      { channelId: '2', online: true, waiting: false }
    ])
    const pending = launcher.launch([
      { channelId: '1', modelSelection: selections['1'] },
      { channelId: '2', modelSelection: selections['2'] }
    ])
    for (let i = 0; i < 50 && createCalls.length < 2; i += 1) await Promise.resolve()
    expect(Object.fromEntries(createCalls.map((call) => [call.channelId, call.modelSelection])))
      .toEqual(selections)
    readyWaiting(state, '1', 'composer-1')
    readyWaiting(state, '2', 'composer-2')
    expect((await pending).state).toBe('done')
  })

  it('单通道失败不阻塞其他通道完成', async () => {
    const { launcher, state } = createHarness(
      [
        { channelId: '1', online: true, waiting: false },
        { channelId: '2', online: true, waiting: false }
      ],
      { createResults: { '1': { ok: false, message: 'Cursor 窗口内晴天网关联接未就绪' } } }
    )
    const pending = launcher.launch(['1', '2'])
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    readyWaiting(state, '2', 'composer-2')
    const plan = await pending
    expect(plan.state).toBe('failed')
    expect(plan.items.find((item) => item.channelId === '1')?.stage).toBe('failed')
    expect(plan.items.find((item) => item.channelId === '2')?.stage).toBe('done')
  })

  it('全部提交成功即触发 onAllTriggered（不等 waiting 完成），且只触发一次', async () => {
    const fired: AgentLaunchPlan[] = []
    const { launcher, state } = createHarness(
      [
        { channelId: '1', online: true, waiting: false },
        { channelId: '2', online: true, waiting: true, composerId: 'composer-live' }
      ],
      { onAllTriggered: (plan) => fired.push(plan) }
    )
    const pending = launcher.launch(['1', '2'])
    // CH-1 尚未进入 waiting 时钩子就应已触发（CH-2 本已待命直接算成功）
    for (let i = 0; i < 50 && !fired.length; i += 1) await Promise.resolve()
    expect(fired).toHaveLength(1)
    expect(state.sessions.get('1')?.waiting).toBe(false)
    readyWaiting(state, '1', 'composer-1')
    const plan = await pending
    expect(plan.state).toBe('done')
    expect(fired).toHaveLength(1)
  })

  it('有通道在 trigger 级失败时不触发 onAllTriggered', async () => {
    const fired: AgentLaunchPlan[] = []
    const { launcher, state } = createHarness(
      [
        { channelId: '1', online: true, waiting: false },
        { channelId: '2', online: true, waiting: false }
      ],
      {
        createResults: { '1': { ok: false, message: '网关联接未就绪' } },
        onAllTriggered: (plan) => fired.push(plan)
      }
    )
    const pending = launcher.launch(['1', '2'])
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    readyWaiting(state, '2', 'composer-2')
    const plan = await pending
    expect(plan.state).toBe('failed')
    expect(fired).toHaveLength(0)
  })

  it('失败终态通过 onFinished 精确回传一次', async () => {
    const finished: AgentLaunchPlan[] = []
    const { launcher } = createHarness(
      [{ channelId: '1', online: true, waiting: false }],
      {
        createResults: { '1': { ok: false, message: '启动失败' } },
        onFinished: (plan) => finished.push(plan)
      }
    )
    await launcher.launch(['1'])
    expect(finished).toHaveLength(1)
    expect(finished[0]?.state).toBe('failed')
    expect(finished[0]?.items[0]?.message).toBe('启动失败')
  })

  it('全部通道本已待命（未发生创建）时不触发 onAllTriggered', async () => {
    const fired: AgentLaunchPlan[] = []
    const { launcher } = createHarness(
      [{ channelId: '1', online: true, waiting: true, composerId: 'composer-live' }],
      { onAllTriggered: (plan) => fired.push(plan) }
    )
    const plan = await launcher.launch(['1'])
    expect(plan.state).toBe('done')
    expect(fired).toHaveLength(0)
  })

  it('运行中拒绝并发启动', async () => {
    const { launcher, state } = createHarness([{ channelId: '1', online: true, waiting: false }])
    const first = launcher.launch(['1'])
    await expect(launcher.launch(['2'])).rejects.toThrowError(/进行中/)
    readyWaiting(state, '1', 'composer-1')
    await first
  })

  it('空通道列表直接报错', async () => {
    const { launcher } = createHarness([])
    await expect(launcher.launch([])).rejects.toThrowError(/请选择/)
  })
})
