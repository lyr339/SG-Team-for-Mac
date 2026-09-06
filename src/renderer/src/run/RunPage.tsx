import { useEffect, useMemo, useState } from 'react'
import type { AgentLaunchPlan, AgentLaunchRequest } from '../../../domain/agent-launch'
import type { CdpAutoHealEvent } from '../../../domain/cursor-cdp'
import type { CursorModelOption, CursorModelSelection } from '../../../domain/cursor-model'
import type { DetectedCursorWorkspace } from '../../../domain/cursor-workspace'
import type { TeamControlSnapshot, WorkspaceRunMode } from '../../../domain/team-control'
import type { CreateIndependentSessionsInput, IndependentWorkspaceSelection } from '../../../shared/desktop-api'
import { BrandMark } from '../BrandMark'
import { cursorModelSelectionFromOption, normalizeCursorModelSelection } from '../cursor-model-selection'
import { TeamIcon } from '../UiIcons'
import { ReplaceRunSheet } from './ReplaceRunSheet'
import { RunHeader } from './RunHeader'
import { RunIndependentPanel } from './RunIndependentPanel'
import { RunModeSwitch } from './RunModeSwitch'
import { RunSeats, type RunSeatRow } from './RunSeats'
import { RunSlot } from './RunSlot'
import { RunTeamPanel } from './RunTeamPanel'
import {
  buildRunView,
  replaceRunConsequence,
  teamFlowSteps,
  teamPrimaryAction,
  type ReplaceRunAction,
  type ReplaceRunConsequence
} from './run-view'

export interface RunPageProps {
  team: TeamControlSnapshot
  detectedWorkspace?: DetectedCursorWorkspace
  cursorModels: CursorModelOption[]
  agentLaunchPlan?: AgentLaunchPlan
  externalNotice?: string
  cdpAutoHealEnabled: boolean
  cdpAutoHealEvent?: CdpAutoHealEvent
  /** 无活跃运行时预选的模式；由 App 持有，会话总览可直达独立配置。 */
  startMode?: WorkspaceRunMode
  onStartModeChange?: (mode: WorkspaceRunMode) => void
  /** 组建团队 / 切换为团队模式：进入工程选择与组队流程。 */
  onChooseWorkspace: () => Promise<void>
  onReconfigure: () => Promise<void>
  onUpdateGoal: (goal: string) => Promise<TeamControlSnapshot>
  onInstallMcp: () => Promise<TeamControlSnapshot>
  onLaunch: () => Promise<TeamControlSnapshot>
  onCreateNextRun: () => Promise<{ snapshot: TeamControlSnapshot; issue?: string }>
  onLaunchAgentSessions: (requests: AgentLaunchRequest[]) => Promise<AgentLaunchPlan>
  onCreateIndependentSessions: (input: CreateIndependentSessionsInput) => Promise<AgentLaunchPlan>
  onChooseIndependentWorkspace: () => Promise<IndependentWorkspaceSelection | undefined>
  onEndActiveRun: () => Promise<void>
  onOpenSessions: () => void
  onPersistModelSelection?: (channelId: string, selection: CursorModelSelection) => Promise<TeamControlSnapshot>
  onEnableCursorCdp?: () => Promise<{ ok: boolean; message: string; suggestAutoHeal?: boolean }>
  onToggleCdpAutoHeal?: (enabled: boolean) => Promise<void>
  onCancelCdpAutoHealCountdown?: () => Promise<void>
}

interface PendingSheet {
  consequence: ReplaceRunConsequence
  perform: () => void
}

/** 正在配置的新独立批次；`confirmed` = 进入配置前已经确认过替换当前运行，创建时不再二次守卫。 */
interface ComposeState {
  confirmed: boolean
}

const DEFAULT_INDEPENDENT_COUNT = 3

/**
 * 「运行」页：一个工程一个活跃运行，团队或独立两种模式。
 * 头部（工程 / 模式 / 状态 / 结束）→ 模式专属区 → 共用席位区；
 * 所有破坏性动作走同一个 ReplaceRunSheet。
 */
export function RunPage({
  team,
  detectedWorkspace,
  cursorModels,
  agentLaunchPlan,
  externalNotice,
  cdpAutoHealEnabled,
  cdpAutoHealEvent,
  startMode: startModeProp,
  onStartModeChange,
  onChooseWorkspace,
  onReconfigure,
  onUpdateGoal,
  onInstallMcp,
  onLaunch,
  onCreateNextRun,
  onLaunchAgentSessions,
  onCreateIndependentSessions,
  onChooseIndependentWorkspace,
  onEndActiveRun,
  onOpenSessions,
  onPersistModelSelection,
  onEnableCursorCdp,
  onToggleCdpAutoHeal,
  onCancelCdpAutoHealCountdown
}: RunPageProps): React.JSX.Element {
  const view = useMemo(() => buildRunView(team, detectedWorkspace), [team, detectedWorkspace])
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [sheet, setSheet] = useState<PendingSheet | null>(null)
  const [compose, setCompose] = useState<ComposeState | null>(null)
  const [localStartMode, setLocalStartMode] = useState<WorkspaceRunMode>('team')
  const startMode = startModeProp ?? localStartMode
  const setStartMode = (mode: WorkspaceRunMode): void => {
    setLocalStartMode(mode)
    onStartModeChange?.(mode)
  }
  const [count, setCount] = useState(DEFAULT_INDEPENDENT_COUNT)
  const [draftSelections, setDraftSelections] = useState<{ runId?: string; byChannel: Record<string, CursorModelSelection> }>({ byChannel: {} })
  const [chosenWorkspace, setChosenWorkspace] = useState<{ selection: IndependentWorkspaceSelection; detectedId?: string }>()
  const [editingGoal, setEditingGoal] = useState(false)
  const [guideSeats, setGuideSeats] = useState(false)

  const runId = view.run?.id
  useEffect(() => {
    // 运行身份变化（创建 / 替换 / 新一轮）：丢弃针对旧运行的配置、确认与草稿。
    setCompose(null)
    setSheet(null)
    setEditingGoal(false)
    setDraftSelections({ runId, byChannel: {} })
  }, [runId])

  useEffect(() => {
    if (externalNotice) setNotice(externalNotice)
  }, [externalNotice])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 6_000)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!view.pendingSeats.length || view.phase === 'completed') setGuideSeats(false)
  }, [view.pendingSeats.length, view.phase])

  const run = async <Result,>(name: string, action: () => Promise<Result>): Promise<Result | undefined> => {
    setBusy(name)
    setError('')
    setNotice('')
    try {
      return await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return undefined
    } finally {
      setBusy('')
    }
  }

  /** 破坏性动作统一入口：仍有 live 席位才展开确认面，否则直接执行。 */
  const guard = (action: ReplaceRunAction, perform: () => void): void => {
    const consequence = replaceRunConsequence(view, action)
    if (!consequence.needsConfirm) {
      perform()
      return
    }
    setSheet({ consequence, perform })
  }

  // ---------- 独立批次配置 ----------
  const composingIndependent = compose !== null || (view.phase === 'none' && startMode === 'independent')
  const manualWorkspace = chosenWorkspace?.detectedId === detectedWorkspace?.id ? chosenWorkspace?.selection : undefined
  const targetWorkspace = manualWorkspace ?? detectedWorkspace ?? view.workspace
  const composeChannels = useMemo(() => Array.from({ length: count }, (_, index) => String(index + 1)), [count])

  const defaultSelection = cursorModelSelectionFromOption(cursorModels.find((model) => model.selected) ?? cursorModels[0])
  const selections = useMemo(() => {
    const drafts = draftSelections.runId === runId ? draftSelections.byChannel : {}
    const channels = composingIndependent ? composeChannels : view.seats.map((seat) => seat.channelId)
    return Object.fromEntries(channels.flatMap((channelId) => {
      const persisted = composingIndependent ? undefined : view.seats.find((seat) => seat.channelId === channelId)?.modelSelection
      const candidate = drafts[channelId] ?? persisted ?? defaultSelection
      const option = candidate ? cursorModels.find((model) => model.modelId === candidate.modelId) : undefined
      const normalized = candidate && option ? normalizeCursorModelSelection(candidate, option) : defaultSelection
      return normalized ? [[channelId, normalized] as const] : []
    }))
  }, [composeChannels, composingIndependent, cursorModels, defaultSelection, draftSelections, runId, view.seats])

  const seatRows: RunSeatRow[] = composingIndependent
    ? composeChannels.map((channelId) => ({ channelId, name: `会话 ${channelId}`, pending: true }))
    : view.seats.map((seat) => ({
        channelId: seat.channelId,
        name: seat.name,
        roleName: seat.solo ? undefined : seat.roleName,
        state: seat.state,
        lastSeenAt: seat.lastSeenAt,
        pending: view.phase !== 'completed' && seat.pending
      }))
  const pendingRequests: AgentLaunchRequest[] = view.pendingSeats.map((seat) => ({
    channelId: seat.channelId,
    modelSelection: selections[seat.channelId]
  }))

  const reportPlan = (plan: AgentLaunchPlan, doneNotice: string): void => {
    if (plan.state === 'done') {
      setNotice(doneNotice)
    } else if (plan.items.some((item) => item.code === 'runtime_account_mismatch')) {
      setNotice('会话发起已暂停：请在弹窗中处理 Cursor 登录账号问题后自动继续。')
    } else if (plan.items.some((item) => item.code === 'membership_blocked')) {
      setNotice('会话发起已暂停：当前账号为 Free 档位，请先在「账号与 Cursor」执行「处理」，再于弹窗刷新档位继续。')
    } else if (plan.items.some((item) => item.code === 'cdp_unavailable')) {
      setNotice('会话创建需要 Cursor 调试端口：点击「重启 Cursor 并启用会话创建」（一次性），完成后重试。')
    } else {
      setError(plan.items.find((item) => item.stage === 'failed')?.message || '部分会话未能创建；可重试，或在 Cursor 手动发起。')
    }
  }

  const createIndependentBatch = (): void => {
    if (!targetWorkspace) return
    const input: CreateIndependentSessionsInput = {
      workspacePath: targetWorkspace.path,
      sessions: composeChannels.map((channelId) => ({ modelSelection: selections[channelId] }))
    }
    const perform = (): void => {
      void run('create-independent', async () => {
        const plan = await onCreateIndependentSessions(input)
        reportPlan(plan, '独立会话已全部进入待命。')
        if (plan.state === 'done') onOpenSessions()
      })
    }
    const replacingLiveRun = Boolean(view.run) && view.phase !== 'completed' && !compose?.confirmed
    if (!replacingLiveRun) {
      perform()
      return
    }
    guard(view.mode === 'independent'
      ? { kind: 'new-batch', targetWorkspaceName: targetWorkspace.name }
      : { kind: 'switch', to: 'independent' }, perform)
  }

  const createPendingSessions = (): void => {
    void run('launch-sessions', async () => {
      setGuideSeats(false)
      const plan = await onLaunchAgentSessions(pendingRequests)
      reportPlan(plan, view.mode === 'independent' ? '独立会话已全部进入待命。' : '会话已全部就绪，可以启动团队。')
    })
  }

  // ---------- 团队 ----------
  const primary = teamPrimaryAction(team, view)
  const steps = teamFlowSteps(view)
  const autoCreateSessions = async (): Promise<void> => {
    if (!pendingRequests.length) return
    const plan = await onLaunchAgentSessions(pendingRequests)
    reportPlan(plan, 'Agent 会话已自动创建并待命，团队进入执行。')
  }
  const prepareAndLaunch = async (): Promise<void> => {
    if (team.preflight.canLaunch) {
      await onLaunch()
      setNotice('启动指令已投递；正在为未待命通道自动创建 Agent 会话。')
      void autoCreateSessions()
      return
    }
    if (team.preflight.mcpInstalled) {
      setNotice(team.preflight.blockers[0] || '请在 Cursor 手动发起对应 Agent 会话；拾光检测到待命后会自动接管。')
      if (pendingRequests.length) setGuideSeats(true)
      return
    }
    const prepared = await onInstallMcp()
    if (prepared.preflight.canLaunch) {
      await onLaunch()
      setNotice('通道已接入，团队启动指令已自动投递；正在自动创建 Agent 会话。')
      void autoCreateSessions()
      return
    }
    setNotice(prepared.preflight.blockers[0] || '请在 Cursor 手动发起对应 Agent 会话；拾光检测到待命后会自动接管。')
    if (pendingRequests.length) setGuideSeats(true)
  }
  const newRound = (): void => {
    guard({ kind: 'new-round' }, () => {
      void run('next-run', async () => {
        const { issue } = await onCreateNextRun()
        if (issue) setError(issue)
      })
    })
  }
  const teamPrimary = (): void => {
    switch (primary.kind) {
      case 'fill-goal':
        setEditingGoal(true)
        return
      case 'new-round':
        newRound()
        return
      case 'launch':
      case 'install-mcp':
      case 'check-standby':
        void run('launch', prepareAndLaunch)
        return
      case 'none':
        return
    }
  }
  const saveGoal = async (goal: string): Promise<void> => {
    await run('goal', async () => {
      const updated = await onUpdateGoal(goal)
      if (updated.preflight.canLaunch) {
        await onLaunch()
        setNotice('目标已保存，团队启动指令已自动投递；正在自动创建 Agent 会话。')
        void autoCreateSessions()
      } else if (pendingRequests.length > 0) {
        setGuideSeats(true)
        setNotice(`团队目标已保存。下一步：确认模型配置，然后点击「一键创建会话（${pendingRequests.length}）」。`)
      } else {
        setNotice('团队目标已保存；现有 Agent 会话已全部待命。')
      }
    })
  }

  // ---------- 模式切换 / 结束 ----------
  const switchMode = (to: WorkspaceRunMode): void => {
    if (compose && to === view.mode) {
      setCompose(null)
      return
    }
    if (to === 'independent') {
      guard({ kind: 'switch', to }, () => setCompose({ confirmed: true }))
      return
    }
    guard({ kind: 'switch', to: 'team' }, () => { void run('workspace', onChooseWorkspace) })
  }
  const endRun = (): void => {
    guard({ kind: 'end' }, () => {
      void run('end-run', async () => {
        await onEndActiveRun()
        setNotice(view.mode === 'independent'
          ? '独立批次已结束；旧会话会在下一次轮询自行退出。'
          : '团队运行已结束；旧会话会在下一次轮询自行退出。')
      })
    })
  }
  const newBatch = (): void => {
    guard({ kind: 'new-batch', targetWorkspaceName: view.cursorWorkspaceChanged ? targetWorkspace?.name : undefined }, () => setCompose({ confirmed: true }))
  }
  const chooseIndependentWorkspace = (): void => {
    void run('choose-workspace', async () => {
      const selection = await onChooseIndependentWorkspace()
      if (selection) setChosenWorkspace({ selection, detectedId: detectedWorkspace?.id })
    })
  }

  const saveModel = async (channelId: string, selection: CursorModelSelection): Promise<void> => {
    // 已存在的席位先持久化再提交本地状态；失败时弹层保持打开并显示错误。
    if (!composingIndependent && onPersistModelSelection) await onPersistModelSelection(channelId, selection)
    setDraftSelections((current) => ({
      runId,
      byChannel: { ...(current.runId === runId ? current.byChannel : {}), [channelId]: structuredClone(selection) }
    }))
  }

  const enableCdp = onEnableCursorCdp ? () => void run('enable-cdp', async () => {
    const result = await onEnableCursorCdp()
    if (result.ok) {
      setNotice(result.suggestAutoHeal
        ? `${result.message}。建议打开「自动保持」开关，此后 Cursor 重启不再丢失该设置。`
        : `${result.message}，Cursor 完全启动后再点创建。`)
    } else {
      setError(result.message)
    }
  }) : undefined
  const toggleAutoHeal = onToggleCdpAutoHeal ? (enabled: boolean) => void run('cdp-autoheal', async () => {
    await onToggleCdpAutoHeal(enabled)
    setNotice(enabled ? '自动保持已开启：此后检测到端口缺失会提示并自动处理。' : '自动保持已关闭。')
  }) : undefined

  const createLabel = composingIndependent
    ? `创建 ${count} 个独立会话`
    : view.mode === 'independent'
      ? `补齐会话（${view.pendingSeats.length}）`
      : `一键创建会话（${view.pendingSeats.length}）`
  const relevantPlan = agentLaunchPlan && (composingIndependent || !view.run || agentLaunchPlan.startedAt >= view.run.createdAt)
    ? agentLaunchPlan
    : undefined
  const isBusy = Boolean(busy)
  const feedback = error || notice
  const feedbackStrip = feedback ? (
    <p className={`run-feedback${error ? ' is-error' : ''}`} role="status" aria-live="polite">
      <i aria-hidden="true" />
      <span>{feedback}</span>
      <button type="button" aria-label="关闭提示" onClick={() => { setError(''); setNotice('') }}>×</button>
    </p>
  ) : null

  const seats = (seatRows.length > 0 || composingIndependent) && (composingIndependent ? Boolean(targetWorkspace) : true) ? (
    <RunSeats
      rows={seatRows}
      cursorModels={cursorModels}
      selections={selections}
      plan={relevantPlan}
      busy={isBusy}
      createLabel={createLabel}
      createBlockedReason={!composingIndependent && view.evidencePending ? '正在确认离线会话的运行状态，确认完成后开放安全重建' : undefined}
      ended={!composingIndependent && view.phase === 'completed'}
      guided={guideSeats}
      cdpAutoHealEnabled={cdpAutoHealEnabled}
      cdpAutoHealEvent={cdpAutoHealEvent}
      onCreate={composingIndependent ? createIndependentBatch : createPendingSessions}
      onModelSave={saveModel}
      onEnableCdp={enableCdp}
      onToggleAutoHeal={toggleAutoHeal}
      onCancelCountdown={onCancelCdpAutoHealCountdown ? () => void onCancelCdpAutoHealCountdown() : undefined}
    />
  ) : null

  if (view.phase === 'none') {
    return (
      <div className="run-page">
        <div className="run-page__inner">
          <section className="run-start" aria-label="开始运行">
            <div className="run-start__intro">
              <span className="run-start__mark"><BrandMark /></span>
              <h1>开始一次运行</h1>
              <p>
                {detectedWorkspace
                  ? <>Cursor 当前打开的工程：<strong title={detectedWorkspace.path}>{detectedWorkspace.name}</strong></>
                  : '先在 Cursor 中打开一个工程，或在下方手动选择。'}
              </p>
            </div>
            <RunModeSwitch value={startMode} disabled={isBusy} onChange={setStartMode} />
            <RunSlot>
              {startMode === 'team' ? (
                <div className="run-start__team">
                  <p>选择工程后为每个席位挑选角色、模型与技能；主控会按目标拆解任务并分派给成员。</p>
                  <button type="button" className="primary-button run-primary" disabled={isBusy} onClick={() => void run('workspace', onChooseWorkspace)}>
                    <TeamIcon />{busy === 'workspace' ? '正在选择…' : '选择工程并组建团队'}
                  </button>
                </div>
              ) : null}
            </RunSlot>
            <RunSlot>{feedbackStrip}</RunSlot>
          </section>
          {startMode === 'independent' ? (
            <div className="run-body">
              <RunIndependentPanel
                view={view}
                composing
                targetWorkspace={targetWorkspace}
                count={count}
                busy={isBusy}
                onCountChange={setCount}
                onChooseWorkspace={chooseIndependentWorkspace}
                onNewBatch={newBatch}
              />
              {seats ?? <div className="run-empty">Cursor 工程识别完成后即可配置独立会话。</div>}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="run-page">
      <div className="run-page__inner">
      <RunHeader
        view={view}
        busy={isBusy}
        busyAction={busy}
        composingMode={compose ? 'independent' : undefined}
        onSwitchMode={switchMode}
        onCancelCompose={compose ? () => setCompose(null) : undefined}
        onEnd={endRun}
        onOpenSessions={onOpenSessions}
      />

      <RunSlot>
        {sheet ? (
          <ReplaceRunSheet
            consequence={sheet.consequence}
            busy={isBusy}
            onCancel={() => setSheet(null)}
            onConfirm={() => { const { perform } = sheet; setSheet(null); perform() }}
          />
        ) : null}
      </RunSlot>

      <RunSlot>{feedbackStrip}</RunSlot>

      <div className="run-body" key={composingIndependent ? 'compose' : view.mode}>
        {composingIndependent ? (
          <RunIndependentPanel
            view={view}
            composing
            targetWorkspace={targetWorkspace}
            count={count}
            busy={isBusy}
            onCountChange={setCount}
            onChooseWorkspace={chooseIndependentWorkspace}
            onNewBatch={newBatch}
          />
        ) : view.mode === 'independent' ? (
          <RunIndependentPanel
            view={view}
            composing={false}
            count={count}
            busy={isBusy}
            onCountChange={setCount}
            onChooseWorkspace={chooseIndependentWorkspace}
            onNewBatch={newBatch}
          />
        ) : (
          <RunTeamPanel
            view={view}
            primary={primary}
            steps={steps}
            busy={isBusy}
            busyAction={busy}
            editingGoal={editingGoal}
            onEditingGoalChange={setEditingGoal}
            onSaveGoal={saveGoal}
            onPrimary={teamPrimary}
            onReconfigure={() => void run('reconfigure', onReconfigure)}
            allowNewRound={view.phase === 'active' && view.presence === 'offline'}
            onNewRound={newRound}
          />
        )}
        {seats}
      </div>
      </div>
    </div>
  )
}
