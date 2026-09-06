import { useEffect, useMemo, useState } from 'react'
import { workspaceRunMode, type TeamControlSnapshot } from '../../../domain/team-control'
import { isAgentOnDuty } from '../../../domain/channel-message'
import type { TeamCollaborationSnapshot } from '../../../domain/team-collaboration'
import type { AgentLaunchPlan, AgentLaunchRequest } from '../../../domain/agent-launch'
import type { CursorModelOption, CursorModelSelection } from '../../../domain/cursor-model'
import type { CdpAutoHealEvent } from '../../../domain/cursor-cdp'
import type { CreateIndependentSessionsInput, IndependentWorkspaceSelection } from '../../../shared/desktop-api'
import type { DetectedCursorWorkspace } from '../../../domain/cursor-workspace'
import { BrandMark } from '../BrandMark'
import { cursorModelSelectionFromOption, normalizeCursorModelSelection } from '../cursor-model-selection'
import { teamDashboardPhase, teamRuntimePresence, unresolvedDashboardGates } from '../team/team-dashboard-view'
import { LobbyHero } from './LobbyHero'
import { LobbySessionLaunchTile } from './LobbySessionLaunchTile'
import { LobbySummaryTile } from './LobbySummaryTile'
import { LobbyAccountTile, type LobbyAccountTileProps } from './LobbyAccountTile'
import { lobbyFlowStepsFor } from './lobby-flow'
import { IndependentSessionPage } from './IndependentSessionPage'
import { RunModePanel } from './RunModePanel'

export type ConfigurationSection = 'team' | 'independent' | 'account'

interface LobbyPageProps {
  section: ConfigurationSection
  onSectionChange: (section: ConfigurationSection) => void
  team: TeamControlSnapshot
  detectedWorkspace?: DetectedCursorWorkspace
  collaboration: TeamCollaborationSnapshot
  onChooseWorkspace: () => Promise<void>
  onReconfigure: () => Promise<void>
  onUpdateGoal: (goal: string) => Promise<TeamControlSnapshot>
  /** 接入团队 MCP（登记 Agent 注册身份），返回接入后的团队快照；失败抛错。 */
  onInstallMcp: () => Promise<TeamControlSnapshot>
  onLaunch: () => Promise<TeamControlSnapshot>
  onCreateNextRun: () => Promise<{ snapshot: TeamControlSnapshot; issue?: string }>
  externalNotice?: string
  agentLaunchPlan?: AgentLaunchPlan
  cursorModels: CursorModelOption[]
  onLaunchAgentSessions: (requests: AgentLaunchRequest[]) => Promise<AgentLaunchPlan>
  onCreateIndependentSessions: (input: CreateIndependentSessionsInput) => Promise<AgentLaunchPlan>
  onChooseIndependentWorkspace: () => Promise<IndependentWorkspaceSelection | undefined>
  /** 显式结束当前运行（团队或独立批次）；旧会话经会话围栏在下一次轮询自行退出。 */
  onEndActiveRun: () => Promise<void>
  onOpenSessions: () => void
  onPersistModelSelection?: (channelId: string, selection: CursorModelSelection) => Promise<TeamControlSnapshot>
  onEnableCursorCdp?: () => Promise<{ ok: boolean; message: string; suggestAutoHeal?: boolean }>
  cdpAutoHealEnabled?: boolean
  cdpAutoHealEvent?: CdpAutoHealEvent
  onToggleCdpAutoHeal?: (enabled: boolean) => Promise<void>
  onCancelCdpAutoHealCountdown?: () => Promise<void>
  account: LobbyAccountTileProps
}

export function LobbyPage({
  section,
  onSectionChange,
  team,
  detectedWorkspace,
  collaboration,
  onChooseWorkspace,
  onReconfigure,
  onUpdateGoal,
  onInstallMcp,
  onLaunch,
  onCreateNextRun,
  externalNotice = '',
  agentLaunchPlan,
  cursorModels,
  onLaunchAgentSessions,
  onCreateIndependentSessions,
  onChooseIndependentWorkspace,
  onEndActiveRun,
  onOpenSessions,
  onPersistModelSelection,
  onEnableCursorCdp,
  cdpAutoHealEnabled = false,
  cdpAutoHealEvent,
  onToggleCdpAutoHeal,
  onCancelCdpAutoHealCountdown,
  account
}: LobbyPageProps): React.JSX.Element {
  const activeRun = team.activeRun
  const workspace = team.workspaces.find((candidate) => candidate.id === team.activeWorkspaceId)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [guideSessionLaunch, setGuideSessionLaunch] = useState(false)
  const [launchModels, setLaunchModels] = useState<{ runId?: string; byChannel: Record<string, CursorModelSelection> }>({
    byChannel: {}
  })

  useEffect(() => {
    if (externalNotice) setNotice(externalNotice)
  }, [externalNotice])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 6_000)
    return () => clearTimeout(timer)
  }, [notice])

  const pendingSessionChannels = team.members
    .filter((member) => member.binding?.channelId && !isAgentOnDuty(member.runtime))
    .map((member) => member.binding!.channelId)
  const defaultCursorModel = cursorModels.find((model) => model.selected) ?? cursorModels[0]
  const launchSelectionByChannel = useMemo(() => {
    const persisted = new Map(team.members.flatMap((member) => {
      const channelId = member.binding?.channelId ?? member.slot.channelId
      return channelId && member.slot.modelSelection
        ? [[channelId, member.slot.modelSelection] as const]
        : []
    }))
    const fallback = cursorModelSelectionFromOption(defaultCursorModel)
    return Object.fromEntries(pendingSessionChannels.flatMap((channelId) => {
      const candidate = launchModels.runId === activeRun?.id
        ? launchModels.byChannel[channelId] ?? persisted.get(channelId) ?? fallback
        : persisted.get(channelId) ?? fallback
      const candidateOption = candidate
        ? cursorModels.find((model) => model.modelId === candidate.modelId)
        : undefined
      const selection = candidate && candidateOption
        ? normalizeCursorModelSelection(candidate, candidateOption)
        : fallback
      return selection ? [[channelId, selection] as const] : []
    }))
  }, [activeRun?.id, cursorModels, defaultCursorModel, launchModels, pendingSessionChannels, team.members])
  const launchRequests: AgentLaunchRequest[] = pendingSessionChannels.map((channelId) => ({
    channelId,
    modelSelection: launchSelectionByChannel[channelId]
  }))

  useEffect(() => {
    if (!activeRun?.id || launchModels.runId === activeRun.id) return
    setLaunchModels({ runId: activeRun.id, byChannel: {} })
  }, [activeRun?.id, launchModels.runId])

  useEffect(() => {
    if (!pendingSessionChannels.length || activeRun?.status === 'completed' || activeRun?.status === 'paused') {
      setGuideSessionLaunch(false)
    }
  }, [activeRun?.status, pendingSessionChannels.length])

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

  const sectionNavigation = (
    <nav className="configuration-tabs" aria-label="配置分类">
      <button
        className={section === 'team' ? 'is-active' : ''}
        aria-current={section === 'team' ? 'page' : undefined}
        onClick={() => onSectionChange('team')}
      >
        <span>团队</span><small>目标、成员与会话</small>
      </button>
      <button
        className={section === 'independent' ? 'is-active' : ''}
        aria-current={section === 'independent' ? 'page' : undefined}
        onClick={() => onSectionChange('independent')}
      >
        <span>独立会话</span><small>批量创建与常驻待命</small>
      </button>
      <button
        className={section === 'account' ? 'is-active' : ''}
        aria-current={section === 'account' ? 'page' : undefined}
        onClick={() => onSectionChange('account')}
      >
        <span>账号与 Cursor</span><small>账号管线与本机维护</small>
      </button>
    </nav>
  )

  if (section === 'independent') {
    return (
      <div className="lobby-page configuration-page">
        <div className="configuration-frame">
          {sectionNavigation}
          <IndependentSessionPage
            team={team}
            detectedWorkspace={detectedWorkspace}
            cursorModels={cursorModels}
            plan={agentLaunchPlan}
            cdpAutoHealEnabled={cdpAutoHealEnabled}
            cdpAutoHealEvent={cdpAutoHealEvent}
            onCreate={onCreateIndependentSessions}
            onChooseWorkspace={onChooseIndependentWorkspace}
            onEndRun={onEndActiveRun}
            onLaunch={onLaunchAgentSessions}
            onPersistModelSelection={onPersistModelSelection}
            onEnableCursorCdp={onEnableCursorCdp}
            onToggleCdpAutoHeal={onToggleCdpAutoHeal}
            onCancelCdpAutoHealCountdown={onCancelCdpAutoHealCountdown}
            onOpenSessions={onOpenSessions}
          />
        </div>
      </div>
    )
  }

  if (section === 'account') {
    return (
      <div className="lobby-page configuration-page">
        <div className="configuration-frame">
          {sectionNavigation}
          <main className="configuration-panel" aria-label="账号与 Cursor 配置">
            <LobbyAccountTile {...account} />
          </main>
        </div>
      </div>
    )
  }

  if (!activeRun || !workspace) {
    return (
      <div className="lobby-page configuration-page">
        <div className="configuration-frame">
          {sectionNavigation}
          <div className="v2-empty-team">
            <span><BrandMark /></span><h1>选择一个 Cursor 工程</h1>
            <p>创建稳定 AgentSlot，并把本机通道作为可替换运行时接入。</p>
            {error ? <em>{error}</em> : null}
            <button disabled={Boolean(busy)} onClick={() => void run('workspace', onChooseWorkspace)}>
              {busy ? '正在选择…' : '选择 Cursor 工程'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (workspaceRunMode(activeRun) === 'independent') {
    // 独立模式：显式的模式面板，而不是整页拦截。切换/结束不再等旧会话心跳过期——
    // 会话围栏让它们在下一次轮询自行退出；面板负责讲清后果并要一次确认。
    return (
      <div className="lobby-page configuration-page">
        <div className="configuration-frame">
          {sectionNavigation}
          <RunModePanel
            team={team}
            busy={Boolean(busy)}
            error={error}
            onViewSessions={() => onSectionChange('independent')}
            onSwitchToTeam={() => run('workspace', onChooseWorkspace)}
            onEndRun={() => run('end-run', async () => {
              await onEndActiveRun()
              setNotice('独立批次已结束；旧会话会在下一次轮询自行退出。')
            })}
          />
          {notice ? <div className="v2-inline-notice" role="status" aria-live="polite">{notice}</div> : null}
        </div>
      </div>
    )
  }

  const phase = teamDashboardPhase(activeRun.status)
  const runIsPrelaunch = phase === 'prelaunch'
  const runIsLaunching = phase === 'launching'
  const runIsActive = phase === 'active'
  const unresolvedGates = unresolvedDashboardGates(team)
  const goalLocked = ['launching', 'running', 'attention', 'paused', 'completed'].includes(activeRun.status)
  // 一键化：启动后自动为未待命通道创建会话；CDP 缺失时引导一次确认。
  const autoCreateSessions = async (): Promise<void> => {
    if (!launchRequests.length) return
    const plan = await onLaunchAgentSessions(launchRequests)
    if (plan.state === 'done') {
      setNotice('Agent 会话已自动创建并待命，团队进入执行。')
    } else if (plan.items.some((item) => item.code === 'runtime_account_mismatch')) {
      setNotice('会话发起已暂停：请在弹窗中处理 Cursor 登录账号问题后自动继续。')
    } else if (plan.items.some((item) => item.code === 'membership_blocked')) {
      setNotice('会话发起已暂停：当前账号为 Free 档位，请先在账号管线执行「处理」，再于弹窗刷新档位继续。')
    } else if (plan.items.some((item) => item.code === 'cdp_unavailable')) {
      setNotice('会话创建需要 Cursor 调试端口：点击「重启 Cursor 并启用会话创建」（一次性），完成后重试一键创建。')
    } else {
      setNotice('部分会话未能自动创建；可在会话卡片重试，或在 Cursor 手动发起。')
    }
  }
  const prepareAndLaunch = async (): Promise<void> => {
    if (team.preflight.canLaunch) {
      await onLaunch()
      setNotice('启动指令已投递；正在为未待命通道自动创建 Agent 会话。')
      void autoCreateSessions()
      return
    }
    if (team.preflight.mcpInstalled) {
      setNotice(team.preflight.blockers[0]
        || '请在 Cursor 手动发起对应 Agent 会话；拾光检测到待命后会自动接管。')
      return
    }
    const prepared = await onInstallMcp()
    if (prepared.preflight.canLaunch) {
      await onLaunch()
      setNotice('通道已接入，团队启动指令已自动投递；正在自动创建 Agent 会话。')
      void autoCreateSessions()
      return
    }
    setNotice(prepared.preflight.blockers[0]
      || '请在 Cursor 手动发起对应 Agent 会话；拾光检测到待命后会自动接管。')
  }
  const primaryLabel = team.preflight.canLaunch
    ? '启动团队'
    : !team.preflight.mcpInstalled
      ? '接入团队 MCP'
      : '检查待命状态'
  const primaryHint = team.preflight.canLaunch
    ? '全部就绪，一键开跑'
    : !team.preflight.mcpInstalled
      ? '为本轮席位登记 SG Team 通道身份，无需重载 Cursor'
      : '检测各通道待命状态，自动接管手动发起的会话'
  const runtimePresence = teamRuntimePresence(team)
  const activeRunDisconnected = runIsActive && runtimePresence !== 'online'
  const runStateLabel = runIsLaunching
    ? '启动确认中'
    : activeRunDisconnected
      ? runtimePresence === 'in_flight_unverified' ? '长任务中 · 连接待确认' : '全部 Agent 离线'
    : runIsActive
      ? activeRun.status === 'attention' ? '团队需处理' : '协作执行中'
      : activeRun.status === 'paused'
        ? '团队已暂停'
        : undefined
  const runStateKind = runIsLaunching ? 'launching' as const
    : activeRunDisconnected ? 'offline' as const
    : runIsActive ? 'active' as const
    : activeRun.status === 'paused' ? 'paused' as const
    : undefined
  const runStateHint = activeRunDisconnected
    ? runtimePresence === 'in_flight_unverified'
      ? 'Agent 上次处于执行阶段；等待 Cursor 恢复连接或提供明确停止证据'
      : '当前没有在线 Agent；可在下方重新创建会话，恢复后自动接管'
    : undefined

  const teamMembers = team.members.filter((member) => member.slot.solo !== true)
  const allMembersWaiting = teamMembers.length > 0 && teamMembers.every((member) => (
    isAgentOnDuty(member.runtime)
  ))
  const goalSaveWillAutoStart = team.preflight.bridgeConnected
    && team.preflight.workspaceBound
    && team.preflight.mcpInstalled
    && team.preflight.agentsWaiting
  const flowSteps = lobbyFlowStepsFor({ goal: activeRun.goal, status: activeRun.status, allMembersWaiting })

  const showSessionLaunch = pendingSessionChannels.length > 0
    && activeRun.status !== 'completed'
    && activeRun.status !== 'paused'
    && !(runIsActive && runtimePresence !== 'online')

  return (
    <div className="lobby-page configuration-page">
      <div className="configuration-frame">
        {sectionNavigation}
        <div className="lobby-stage">
        <LobbyHero
          workspaceName={workspace.name}
          runName={activeRun.name}
          goal={activeRun.goal}
          status={activeRun.status}
          steps={flowSteps}
          goalLocked={goalLocked}
          busy={Boolean(busy)}
          autoStartOnGoalSave={goalSaveWillAutoStart}
          primaryLabel={primaryLabel}
          primaryTitle={team.preflight.blockers.join('；')}
          primaryHint={primaryHint}
          runStateLabel={runStateLabel}
          runStateKind={runStateKind}
          runStateHint={runStateHint}
          allowCreateNextRun={activeRunDisconnected && runtimePresence === 'offline'}
          onSaveGoal={async (goal) => {
            await run('goal', async () => {
              const updated = await onUpdateGoal(goal)
              if (updated.preflight.canLaunch) {
                await onLaunch()
                setNotice('目标已保存，团队启动指令已自动投递；正在自动创建 Agent 会话。')
                void autoCreateSessions()
              } else {
                if (pendingSessionChannels.length > 0) {
                  setGuideSessionLaunch(true)
                  setNotice(`团队目标已保存。下一步：确认模型配置，然后点击「一键创建会话（${pendingSessionChannels.length}）」。`)
                } else {
                  setNotice('团队目标已保存；现有 Agent 会话已全部待命。')
                }
              }
            })
          }}
          onReconfigure={() => void run('reconfigure', onReconfigure)}
          onPrimary={() => void run('launch', prepareAndLaunch)}
          onCreateNextRun={() => void run('next-run', onCreateNextRun)}
        />

        {error || notice ? (
          <div className={`v2-inline-notice ${error ? 'is-error' : ''}`} role="status" aria-live="polite">{error || notice}</div>
        ) : null}

        <div className={`lobby-workbench lobby-workbench--team ${showSessionLaunch ? 'has-session-launch' : 'is-stable'}`}>
          <aside className="lobby-workbench__rail" aria-label="运行控制">
            <LobbySummaryTile team={team} collaboration={collaboration} gates={unresolvedGates} />

            {showSessionLaunch ? (
              <LobbySessionLaunchTile
                pendingChannels={pendingSessionChannels}
                cursorModels={cursorModels}
                selections={launchSelectionByChannel}
                isPrelaunch={runIsPrelaunch}
                plan={agentLaunchPlan}
                busy={Boolean(busy)}
                guided={guideSessionLaunch}
                cdpAutoHealEnabled={cdpAutoHealEnabled}
                cdpAutoHealEvent={cdpAutoHealEvent}
                onLaunch={() => void run('agent-launch', async () => {
                  setGuideSessionLaunch(false)
                  const plan = await onLaunchAgentSessions(launchRequests)
                  if (plan.state === 'done') {
                    setNotice('会话已全部就绪，可以启动团队。')
                  } else {
                    setError(plan.items.find((item) => item.stage === 'failed')?.message || '部分会话创建失败')
                  }
                })}
                onModelSave={async (channelId, selection) => {
                  // 保存成功后才提交本地状态；失败时弹层保持打开并显示错误，
                  // 避免 UI 看似已保存、实际启动仍读取旧配置。
                  if (onPersistModelSelection) await onPersistModelSelection(channelId, selection)
                  setLaunchModels((current) => {
                    if (current.runId && current.runId !== activeRun.id) return current
                    return {
                      runId: activeRun.id,
                      byChannel: { ...current.byChannel, [channelId]: structuredClone(selection) }
                    }
                  })
                }}
                onEnableCdp={onEnableCursorCdp ? () => void run('enable-cdp', async () => {
                  const result = await onEnableCursorCdp()
                  if (result.ok) {
                    setNotice(result.suggestAutoHeal
                      ? `${result.message}。建议打开「自动保持」开关，此后 Cursor 重启不再丢失该设置。`
                      : `${result.message}，Cursor 完全启动后再点「一键创建会话」。`)
                  } else {
                    setError(result.message)
                  }
                }) : undefined}
                onToggleAutoHeal={onToggleCdpAutoHeal ? (enabled) => void run('cdp-autoheal', async () => {
                  await onToggleCdpAutoHeal(enabled)
                  setNotice(enabled
                    ? '自动保持已开启：此后检测到端口缺失会提示并自动处理。'
                    : '自动保持已关闭。')
                }) : undefined}
                onCancelCountdown={onCancelCdpAutoHealCountdown ? () => void onCancelCdpAutoHealCountdown() : undefined}
              />
            ) : null}
          </aside>
        </div>
      </div>
      </div>
    </div>
  )
}
