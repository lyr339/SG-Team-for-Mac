import { useEffect, useState } from 'react'
import type { TeamControlSnapshot, TeamRunStatus } from '../../../domain/team-control'
import type { TeamCollaborationSnapshot } from '../../../domain/team-collaboration'
import type { AgentLaunchPlan } from '../../../domain/agent-launch'
import type { CdpAutoHealEvent } from '../../../domain/cursor-cdp'
import type { McpInstallationResult } from '../../../shared/desktop-api'
import { BrandMark } from '../BrandMark'
import { TeamResiliencePanel } from '../team/TeamResiliencePanel'
import { teamDashboardPhase, unresolvedDashboardGates } from '../team/team-dashboard-view'
import { LobbyHero, type LobbyHeroStep } from './LobbyHero'
import { LobbySessionLaunchTile } from './LobbySessionLaunchTile'
import { LobbySummaryTile } from './LobbySummaryTile'
import { LobbyAccountTile, type LobbyAccountTileProps } from './LobbyAccountTile'

interface LobbyPageProps {
  team: TeamControlSnapshot
  collaboration: TeamCollaborationSnapshot
  onChooseWorkspace: () => Promise<void>
  onReconfigure: () => Promise<void>
  onUpdateGoal: (goal: string) => Promise<TeamControlSnapshot>
  onInstallMcp: () => Promise<{ installation: McpInstallationResult; snapshot: TeamControlSnapshot }>
  onLaunch: () => Promise<TeamControlSnapshot>
  onCreateNextRun: () => Promise<{
    snapshot: TeamControlSnapshot
    restartRequired: boolean
    issue?: string
  }>
  externalNotice?: string
  autoStartOnGoalSave?: boolean
  mcpReloadRequired?: boolean
  agentLaunchPlan?: AgentLaunchPlan
  onLaunchAgentSessions: (channelIds: string[]) => Promise<AgentLaunchPlan>
  onEnableCursorCdp?: () => Promise<{ ok: boolean; message: string; suggestAutoHeal?: boolean }>
  cdpAutoHealEnabled?: boolean
  cdpAutoHealEvent?: CdpAutoHealEvent
  onToggleCdpAutoHeal?: (enabled: boolean) => Promise<void>
  onCancelCdpAutoHealCountdown?: () => Promise<void>
  account: LobbyAccountTileProps
}

export function lobbyFlowStepsFor(input: {
  goal: string
  status: TeamRunStatus
  allMembersWaiting: boolean
}): readonly LobbyHeroStep[] {
  const launched = ['launching', 'running', 'attention', 'paused', 'completed'].includes(input.status)
  const completed = input.status === 'completed'
  const goalDefined = Boolean(input.goal.trim())
  return [
    { label: '团队目标', state: goalDefined ? 'done' : 'current' },
    { label: '启动团队', state: launched ? 'done' : goalDefined ? 'current' : 'todo' },
    { label: 'Agent 待命', state: completed || input.allMembersWaiting ? 'done' : launched ? 'current' : 'todo' },
    { label: '协作执行', state: completed ? 'done' : launched && input.allMembersWaiting ? 'current' : 'todo' }
  ]
}

export function LobbyPage({
  team,
  collaboration,
  onChooseWorkspace,
  onReconfigure,
  onUpdateGoal,
  onInstallMcp,
  onLaunch,
  onCreateNextRun,
  externalNotice = '',
  autoStartOnGoalSave = false,
  mcpReloadRequired = false,
  agentLaunchPlan,
  onLaunchAgentSessions,
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

  useEffect(() => {
    if (externalNotice) setNotice(externalNotice)
  }, [externalNotice])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 6_000)
    return () => clearTimeout(timer)
  }, [notice])

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

  if (!activeRun || !workspace) {
    return (
      <div className="lobby-page">
        <div className="v2-empty-team">
          <span><BrandMark /></span><h1>选择一个 Cursor 工程</h1>
          <p>创建稳定 AgentSlot，并把本机通道作为可替换运行时接入。</p>
          {error ? <em>{error}</em> : null}
          <button disabled={Boolean(busy)} onClick={() => void run('workspace', onChooseWorkspace)}>
            {busy ? '正在选择…' : '选择 Cursor 工程'}
          </button>
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
  const pendingSessionChannels = team.members
    .filter((member) => member.binding?.channelId && !(member.runtime?.online && member.runtime?.waiting))
    .map((member) => member.binding!.channelId)

  // 一键化：启动后自动为未待命通道创建会话；CDP 缺失时引导一次确认。
  const autoCreateSessions = async (): Promise<void> => {
    const channels = pendingSessionChannels
    if (!channels.length) return
    const plan = await onLaunchAgentSessions(channels)
    if (plan.state === 'done') {
      setNotice('Agent 会话已自动创建并待命，团队进入执行。')
    } else if (plan.items.some((item) => item.code === 'cdp_unavailable')) {
      setNotice('会话创建需要 Cursor 调试端口：点击「重启 Cursor 并启用会话创建」（一次性），完成后重试一键创建。')
    } else {
      setNotice('部分会话未能自动创建；可在会话卡片重试，或在 Cursor 手动发起。')
    }
  }
  const prepareAndLaunch = async (): Promise<void> => {
    if (team.preflight.canLaunch && !mcpReloadRequired) {
      await onLaunch()
      setNotice('启动指令已投递；正在为未待命通道自动创建 Agent 会话。')
      void autoCreateSessions()
      return
    }
    if (team.preflight.mcpInstalled && !mcpReloadRequired) {
      setNotice(team.preflight.blockers[0]
        || '请在 Cursor 手动发起对应 Agent 会话；群枢检测到待命后会自动接管。')
      return
    }
    const prepared = await onInstallMcp()
    if (prepared.installation.ok && prepared.installation.restartRequired) {
      setNotice('团队 MCP 已安装。请重载 Cursor 一次；重载后软件会继续检测。')
      return
    }
    if (prepared.snapshot.preflight.canLaunch) {
      await onLaunch()
      setNotice('通道已接入，团队启动指令已自动投递；正在自动创建 Agent 会话。')
      void autoCreateSessions()
      return
    }
    setNotice(prepared.snapshot.preflight.blockers[0]
      || '请在 Cursor 手动发起对应 Agent 会话；群枢检测到待命后会自动接管。')
  }
  const primaryLabel = mcpReloadRequired
    ? '重载 Cursor 后继续'
    : team.preflight.canLaunch
      ? '启动团队'
      : !team.preflight.mcpInstalled
        ? '安装团队 MCP'
        : '检查待命状态'
  const primaryHint = mcpReloadRequired
    ? 'MCP 已升级，重载 Cursor 后点我一次即可'
    : team.preflight.canLaunch
      ? '全部就绪，一键开跑'
      : !team.preflight.mcpInstalled
        ? '写入本工程 .cursor/mcp.json，约 10 秒'
        : '检测各通道待命状态，自动接管手动发起的会话'
  const runStateLabel = runIsLaunching
    ? '启动确认中'
    : runIsActive
      ? activeRun.status === 'attention' ? '团队需处理' : '协作执行中'
      : activeRun.status === 'paused'
        ? '团队已暂停'
        : undefined
  const runStateKind = runIsLaunching ? 'launching' as const
    : runIsActive ? 'active' as const
    : activeRun.status === 'paused' ? 'paused' as const
    : undefined

  const allMembersWaiting = team.members.length > 0 && team.members.every((member) => (
    member.runtime?.online && member.runtime?.waiting
  ))
  const flowSteps = lobbyFlowStepsFor({ goal: activeRun.goal, status: activeRun.status, allMembersWaiting })

  const showSessionLaunch = pendingSessionChannels.length > 0
    && activeRun.status !== 'completed'
    && activeRun.status !== 'paused'

  return (
    <div className="lobby-page">
      <div className="lobby-stage">
        <LobbyHero
          workspaceName={workspace.name}
          runName={activeRun.name}
          goal={activeRun.goal}
          status={activeRun.status}
          steps={flowSteps}
          goalLocked={goalLocked}
          busy={Boolean(busy)}
          autoStartOnGoalSave={autoStartOnGoalSave}
          primaryLabel={primaryLabel}
          primaryTitle={mcpReloadRequired ? '请先重载 Cursor，完成后点击继续检测并启动' : team.preflight.blockers.join('；')}
          primaryHint={primaryHint}
          runStateLabel={runStateLabel}
          runStateKind={runStateKind}
          onSaveGoal={async (goal) => {
            await run('goal', async () => {
              const updated = await onUpdateGoal(goal)
              if (autoStartOnGoalSave && updated.preflight.canLaunch) {
                await onLaunch()
                setNotice('目标已保存，团队启动指令已自动投递；正在自动创建 Agent 会话。')
                void autoCreateSessions()
              } else {
                setNotice('团队目标已保存。')
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

        <div className={`lobby-workbench ${showSessionLaunch ? 'has-session-launch' : 'is-stable'}`}>
          <aside className="lobby-workbench__rail" aria-label="运行控制">
            <LobbySummaryTile team={team} collaboration={collaboration} gates={unresolvedGates} />

            {showSessionLaunch ? (
              <LobbySessionLaunchTile
                pendingChannels={pendingSessionChannels}
                isPrelaunch={runIsPrelaunch}
                plan={agentLaunchPlan}
                busy={Boolean(busy)}
                cdpAutoHealEnabled={cdpAutoHealEnabled}
                cdpAutoHealEvent={cdpAutoHealEvent}
                onLaunch={() => void run('agent-launch', async () => {
                  const plan = await onLaunchAgentSessions(pendingSessionChannels)
                  if (plan.state === 'done') {
                    setNotice('会话已全部就绪，可以启动团队。')
                  } else {
                    setError(plan.items.find((item) => item.stage === 'failed')?.message || '部分会话创建失败')
                  }
                })}
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

            <TeamResiliencePanel team={team} />
          </aside>

          <main className="lobby-workbench__main" aria-label="账号与自动化">
            <LobbyAccountTile {...account} />
          </main>
        </div>
      </div>
    </div>
  )
}
