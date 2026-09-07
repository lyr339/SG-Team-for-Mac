// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchRequest } from '../src/domain/agent-launch'
import { emptyTeamControlSnapshot, type TeamControlSnapshot } from '../src/domain/team-control'
import type { CreateIndependentSessionsInput } from '../src/shared/desktop-api'
import { RunPage, type RunPageProps } from '../src/renderer/src/run/RunPage'
import { desktopSnapshot } from '../src/renderer/src/preview/mock-data'
import { independentTeam, teamRun } from './run-fixtures'

const donePlan = { id: 'plan:test', state: 'done' as const, items: [], startedAt: Date.now(), finishedAt: Date.now() + 1 }
const detected = { id: 'wedge-demo', name: 'wedge-demo', path: '/Users/demo/projects/wedge-demo' }

describe('RunPage（一个工程一个活跃运行：团队 / 独立两种模式）', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>('button')]
  const buttonNamed = (label: string): HTMLButtonElement => {
    const button = buttons().find((candidate) => candidate.textContent?.trim() === label)
    if (!button) throw new Error(`button "${label}" not found in: ${buttons().map((b) => b.textContent?.trim()).join(' | ')}`)
    return button
  }
  const modeButton = (label: '团队' | '独立'): HTMLButtonElement => {
    const button = [...container.querySelectorAll<HTMLButtonElement>('.run-mode-switch button')]
      .find((candidate) => candidate.querySelector('b')?.textContent === label)
    if (!button) throw new Error(`mode "${label}" not found`)
    return button
  }
  // 确认面与提示条住在可折叠插槽里；收起后内容会为过渡再停留一会（inert），只有展开的插槽算"显示中"。
  const sheet = (): HTMLElement | null => container.querySelector('.run-slot.is-open [role="alertdialog"]')
  const status = (): HTMLElement | null => container.querySelector('.run-slot.is-open .run-feedback')
  const click = async (button: HTMLButtonElement): Promise<void> => { await act(async () => button.click()) }

  const render = async (team: TeamControlSnapshot, overrides: Partial<RunPageProps> = {}) => {
    const handlers = {
      onChooseWorkspace: vi.fn(async () => {}),
      onReconfigure: vi.fn(async () => {}),
      onUpdateGoal: vi.fn(async () => team),
      onInstallMcp: vi.fn(async () => team),
      onLaunch: vi.fn(async () => team),
      onCreateNextRun: vi.fn(async () => ({ snapshot: team })),
      onLaunchAgentSessions: vi.fn(async (_requests: AgentLaunchRequest[]) => donePlan),
      onCreateIndependentSessions: vi.fn(async (_input: CreateIndependentSessionsInput) => donePlan),
      onChooseIndependentWorkspace: vi.fn(async () => undefined),
      onEndActiveRun: vi.fn(async () => {}),
      onOpenSessions: vi.fn()
    }
    await act(async () => root.render(
      <RunPage
        team={team}
        detectedWorkspace={detected}
        cursorModels={desktopSnapshot.cursorModels ?? []}
        cdpAutoHealEnabled={false}
        {...handlers}
        {...overrides}
      />
    ))
    return handlers
  }

  describe('头部与席位', () => {
    it('renders the team run with its mode, state chip and only the team seats', async () => {
      await render(teamRun('waiting', 'running'))
      expect(container.querySelector('.run-header__eyebrow')?.textContent).toBe('团队运行')
      expect(container.querySelector('.run-state-chip')?.textContent).toBe('协作执行中')
      expect(modeButton('团队').getAttribute('aria-checked')).toBe('true')
      const seats = [...container.querySelectorAll('.run-seat__who strong')].map((node) => node.textContent)
      expect(seats.length).toBeGreaterThan(0)
      expect(container.querySelector('.run-seats .run-section-head span')?.textContent).toBe('全部在岗')
      expect(container.textContent).toContain('所有席位已在岗，无需创建会话')
      expect(container.textContent).not.toContain('独立席')
      expect(buttonNamed('结束运行').disabled).toBe(false)
    })

    it('renders an independent batch with per-seat state labels and a batch summary', async () => {
      await render(independentTeam(['waiting', 'working', 'offline', 'unconfirmed']))
      expect(container.querySelector('.run-header__eyebrow')?.textContent).toBe('独立批次')
      expect(modeButton('独立').getAttribute('aria-checked')).toBe('true')
      const badges = [...container.querySelectorAll('.run-seat__badge')].map((node) => node.className.replace('run-seat__badge ', ''))
      expect(badges).toEqual(['is-waiting', 'is-working', 'is-offline', 'is-unconfirmed'])
      expect(container.textContent).toContain('尚无工具调用证据')
      expect(container.querySelector('.run-batch__count')?.textContent).toBe('2/ 4 在岗')
      // 有席位尚无运行证据：先确认再开放重建。
      expect(buttonNamed('补齐会话（2）').disabled).toBe(true)
      expect(container.textContent).toContain('正在确认离线会话的运行状态')
    })
  })

  describe('结束运行（软守卫）', () => {
    it('confirms before ending a batch with live sessions, then reports the fence consequence', async () => {
      const { onEndActiveRun } = await render(independentTeam(['waiting', 'waiting']))
      await click(buttonNamed('结束批次'))
      expect(onEndActiveRun).not.toHaveBeenCalled()
      expect(sheet()?.textContent).toContain('结束当前独立批次')
      expect(sheet()?.textContent).toContain('2 个会话仍在线或待确认')
      expect(sheet()?.textContent).toContain('下一次轮询（最长 60 秒）收到结束指令并自行退出')
      await click(buttonNamed('确认结束'))
      expect(onEndActiveRun).toHaveBeenCalledTimes(1)
      expect(sheet()).toBeNull()
      expect(status()?.textContent).toContain('独立批次已结束；旧会话会在下一次轮询自行退出。')
    })

    it('ends an all-offline batch immediately and surfaces failures inline', async () => {
      const onEndActiveRun = vi.fn(async () => { throw new Error('运行状态已变化，请刷新后重试') })
      await render(independentTeam(['offline', 'offline']), { onEndActiveRun })
      await click(buttonNamed('结束批次'))
      expect(sheet()).toBeNull()
      expect(onEndActiveRun).toHaveBeenCalledTimes(1)
      expect(status()?.className).toContain('is-error')
      expect(status()?.textContent).toContain('运行状态已变化')
    })

    it('disables ending an already ended run', async () => {
      await render(independentTeam(['waiting'], 'completed'))
      expect(buttonNamed('结束批次').disabled).toBe(true)
      expect(container.querySelector('.run-state-chip')?.textContent).toBe('批次已结束')
    })
  })

  describe('模式切换（唯一入口：头部分段控件）', () => {
    it('asks once before switching a live batch to team mode; cancel keeps everything running', async () => {
      const { onChooseWorkspace } = await render(independentTeam(['waiting', 'working', 'unconfirmed', 'offline']))
      await click(modeButton('团队'))
      expect(onChooseWorkspace).not.toHaveBeenCalled()
      expect(sheet()?.textContent).toContain('切换到团队模式')
      expect(sheet()?.textContent).toContain('3 个会话仍在线或待确认')
      expect(sheet()?.textContent).toContain('随后进入组队流程')
      await click(buttonNamed('取消'))
      expect(sheet()).toBeNull()
      expect(onChooseWorkspace).not.toHaveBeenCalled()
      await click(modeButton('团队'))
      await click(buttonNamed('确认切换'))
      expect(onChooseWorkspace).toHaveBeenCalledTimes(1)
    })

    it('switches an ended or all-offline batch to team mode without asking', async () => {
      const ended = await render(independentTeam(['waiting'], 'completed'))
      await click(modeButton('团队'))
      expect(sheet()).toBeNull()
      expect(ended.onChooseWorkspace).toHaveBeenCalledTimes(1)

      const offline = await render(independentTeam(['offline']))
      await click(modeButton('团队'))
      expect(sheet()).toBeNull()
      expect(offline.onChooseWorkspace).toHaveBeenCalledTimes(1)
    })

    it('switching a live team run to independent opens the batch configurator after one confirmation, and creating does not ask again', async () => {
      const { onCreateIndependentSessions } = await render(teamRun('waiting', 'running'))
      await click(modeButton('独立'))
      expect(sheet()?.textContent).toContain('切换到独立模式')
      expect(sheet()?.textContent).toContain('切换会结束当前团队运行')
      await click(buttonNamed('确认切换'))
      expect(sheet()).toBeNull()
      expect(container.textContent).toContain('会话数量')
      expect(container.querySelector('.run-slot.is-open .run-banner')?.textContent).toContain('正在配置独立批次：创建后当前团队运行结束')
      expect(modeButton('独立').getAttribute('aria-checked')).toBe('true')
      // 头部本身不变：状态芯片仍是当前运行的，只有分段控件指向目标模式。
      expect(container.querySelector('.run-header .run-state-chip')?.textContent).toBe('协作执行中')
      expect(container.querySelector('.run-header__eyebrow')?.textContent).toBe('团队运行')

      await click(buttonNamed('创建 3 个独立会话'))
      expect(sheet()).toBeNull()
      expect(onCreateIndependentSessions).toHaveBeenCalledTimes(1)
      expect(onCreateIndependentSessions.mock.calls[0]?.[0]).toMatchObject({ workspacePath: detected.path })
      expect(onCreateIndependentSessions.mock.calls[0]?.[0].sessions).toHaveLength(3)
    })

    it('creates an independent batch directly over a team run whose agents are all offline', async () => {
      const { onCreateIndependentSessions } = await render(teamRun('offline', 'running'))
      await click(modeButton('独立'))
      expect(sheet()).toBeNull()
      expect(container.textContent).toContain('会话数量')
      await click(buttonNamed('创建 3 个独立会话'))
      expect(onCreateIndependentSessions).toHaveBeenCalledTimes(1)
    })

    it('"放弃" returns from the configurator to the current run', async () => {
      await render(teamRun('offline', 'running'))
      await click(modeButton('独立'))
      expect(container.textContent).toContain('会话数量')
      await click(buttonNamed('放弃'))
      expect(container.textContent).not.toContain('会话数量')
      expect(modeButton('团队').getAttribute('aria-checked')).toBe('true')
    })
  })

  describe('独立批次：补齐 / 新建 / 换工程', () => {
    it('tops up the existing batch on the same workspace instead of creating a new run', async () => {
      const { onCreateIndependentSessions, onLaunchAgentSessions } = await render(independentTeam(['offline', 'offline']))
      await click(buttonNamed('补齐会话（2）'))
      expect(onLaunchAgentSessions).toHaveBeenCalledTimes(1)
      expect(onLaunchAgentSessions.mock.calls[0]?.[0].map((request) => request.channelId)).toEqual(['1', '2'])
      expect(onCreateIndependentSessions).not.toHaveBeenCalled()
    })

    it('guards "结束并新建批次" once while sessions are live; confirm opens the configurator and creating does not ask again', async () => {
      const { onCreateIndependentSessions } = await render(independentTeam(['waiting', 'waiting']))
      expect(container.textContent).not.toContain('会话数量')
      await click(buttonNamed('结束并新建批次'))
      expect(sheet()?.textContent).toContain('新建独立批次')
      expect(sheet()?.textContent).toContain('2 个会话仍在线或待确认')
      await click(buttonNamed('取消'))
      expect(container.textContent).not.toContain('会话数量')

      await click(buttonNamed('结束并新建批次'))
      await click(buttonNamed('确认新建'))
      expect(container.textContent).toContain('会话数量')
      await click(buttonNamed('创建 3 个独立会话'))
      expect(sheet()).toBeNull()
      expect(onCreateIndependentSessions).toHaveBeenCalledTimes(1)
    })

    it('an ended batch starts a new run (never reuses retired session tokens)', async () => {
      const { onCreateIndependentSessions, onLaunchAgentSessions } = await render(independentTeam(['offline'], 'completed'))
      await click(buttonNamed('新建批次'))
      expect(sheet()).toBeNull()
      await click(buttonNamed('创建 3 个独立会话'))
      expect(onCreateIndependentSessions).toHaveBeenCalledTimes(1)
      expect(onLaunchAgentSessions).not.toHaveBeenCalled()
    })

    it('Cursor switched project: the new batch targets the detected workspace and is guarded once', async () => {
      const next = { id: 'project-b', name: '新工程 B', path: '/projects/b' }
      const { onCreateIndependentSessions } = await render(independentTeam(['waiting']), { detectedWorkspace: next })
      expect(container.textContent).toContain('Cursor 当前打开的不是本批次的工程')
      await click(buttonNamed('结束并新建批次'))
      expect(sheet()?.textContent).toContain('在「新工程 B」新建批次')
      await click(buttonNamed('确认新建'))
      expect(container.querySelector('.run-field__value code')?.textContent).toBe('/projects/b')
      expect(container.textContent).toContain('Cursor 已切换工程：新批次将创建到「新工程 B」')
      await click(buttonNamed('创建 3 个独立会话'))
      expect(onCreateIndependentSessions).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: '/projects/b' }))
    })

    it('adjusts the session count within 1–16', async () => {
      await render(independentTeam(['offline'], 'completed'))
      await click(buttonNamed('新建批次'))
      const output = (): string => container.querySelector('output')?.textContent ?? ''
      expect(output()).toBe('3')
      await click(container.querySelector<HTMLButtonElement>('.run-stepper button[aria-label="减少"]')!)
      await click(container.querySelector<HTMLButtonElement>('.run-stepper button[aria-label="减少"]')!)
      expect(output()).toBe('1')
      expect(container.querySelector<HTMLButtonElement>('.run-stepper button[aria-label="减少"]')?.disabled).toBe(true)
      expect(buttonNamed('创建 1 个独立会话')).toBeTruthy()
      expect(container.querySelectorAll('.run-seat')).toHaveLength(1)
    })
  })

  describe('团队：主按钮由 preflight 决定', () => {
    it('opens the goal editor from the primary action and auto-launches when the saved goal completes preflight', async () => {
      const draft = teamRun('waiting', 'ready')
      draft.activeRun!.goal = ''
      const launched = { ...draft, activeRun: { ...draft.activeRun!, goal: '做一个登录页' }, preflight: { ...draft.preflight, canLaunch: true } }
      const onUpdateGoal = vi.fn(async () => launched)
      const { onLaunch } = await render(draft, { onUpdateGoal })
      await click(buttonNamed('填写团队目标'))
      const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="团队目标"]')!
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
        setter.call(textarea, '做一个登录页')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await click(buttonNamed('保存目标'))
      expect(onUpdateGoal).toHaveBeenCalledWith('做一个登录页')
      expect(onLaunch).toHaveBeenCalledTimes(1)
      expect(status()?.textContent).toContain('目标已保存，团队启动指令已自动投递')
    })

    it('starts the next round directly once the run has completed', async () => {
      const { onCreateNextRun } = await render(teamRun('offline', 'completed'))
      expect(container.querySelector('.run-state-chip')?.textContent).toBe('本轮已结束')
      // 已结束的运行不再提供会话创建。
      expect(container.querySelector('.run-seats .run-section-head span')?.textContent).toContain('运行已结束')
      expect(buttons().some((button) => button.textContent?.includes('一键创建会话'))).toBe(false)
      await click(buttonNamed('开始新一轮'))
      expect(sheet()).toBeNull()
      expect(onCreateNextRun).toHaveBeenCalledTimes(1)
    })

    it('offers "结束本轮并新建" only when an active run has every agent offline', async () => {
      const { onCreateNextRun } = await render(teamRun('offline', 'running'))
      expect(container.querySelector('.run-state-chip')?.textContent).toBe('全部 Agent 离线')
      await click(buttonNamed('结束本轮并新建'))
      expect(sheet()).toBeNull()
      expect(onCreateNextRun).toHaveBeenCalledTimes(1)
    })

    it('runs the launch pipeline from the primary action when preflight is green', async () => {
      const ready = teamRun('waiting', 'ready')
      ready.preflight = { ...ready.preflight, canLaunch: true, mcpInstalled: true }
      const { onLaunch } = await render(ready)
      await click(buttonNamed('启动团队'))
      expect(onLaunch).toHaveBeenCalledTimes(1)
      expect(status()?.textContent).toContain('启动指令已投递')
    })
  })

  describe('无活跃运行', () => {
    it('offers both modes; team goes straight to the workspace picker', async () => {
      const { onChooseWorkspace } = await render(emptyTeamControlSnapshot())
      expect(container.textContent).toContain('开始一次运行')
      expect(container.textContent).toContain('Cursor 当前打开的工程')
      await click(buttonNamed('选择工程并组建团队'))
      expect(onChooseWorkspace).toHaveBeenCalledTimes(1)
    })

    it('independent start mode shows the batch configurator and creates without any confirmation', async () => {
      const onStartModeChange = vi.fn()
      const { onCreateIndependentSessions } = await render(emptyTeamControlSnapshot(), { startMode: 'independent', onStartModeChange })
      expect(container.textContent).toContain('会话数量')
      expect(container.querySelectorAll('.run-seat')).toHaveLength(3)
      await click(buttonNamed('创建 3 个独立会话'))
      expect(sheet()).toBeNull()
      expect(onCreateIndependentSessions).toHaveBeenCalledTimes(1)
      await click(modeButton('团队'))
      expect(onStartModeChange).toHaveBeenCalledWith('team')
    })
  })
})
