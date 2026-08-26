import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChooseTeamWorkspaceResult,
  DesktopSnapshot,
  TeamSetupDraft
} from '../../shared/desktop-api'
import { emptyTaskPoolSnapshot, newestTaskPoolSnapshot } from '../../domain/task-pool'
import { emptyTeamControlSnapshot, type TeamRunStatus } from '../../domain/team-control'
import { emptyTeamCollaborationSnapshot } from '../../domain/team-collaboration'
import { DesktopShell, type AppModule } from './DesktopShell'
import { SessionOverview } from './SessionOverview'
import { SessionWorkspace } from './SessionWorkspace'
import { SessionSidebar } from './SessionSidebar'
import { LobbyPage } from './lobby/LobbyPage'
import { TeamSetupPage } from './team/TeamSetupPage'
import { ManualHandoffDialog } from './team/ManualHandoffDialog'
import type { TeamHandoffOptions } from '../../domain/team-handoff'
import type { CursorAccountMetadata } from '../../domain/cursor-account'
import type { CursorUpdatePreferences } from '../../domain/cursor-update'
import type { AozaiCardStatus, AozaiProgressEvent } from '../../domain/aozai-service'
import type { AgentLaunchPlan } from '../../domain/agent-launch'
import type { AccountAutomationRun, AccountAutomationSettings } from '../../domain/account-automation'
import type { CdpAutoHealEvent } from '../../domain/cursor-cdp'
import type { MessageAttachment } from '../../domain/conversation-entry'
import { shareSnapshotStructure } from './snapshot-sharing'
import { userFacingErrorMessage } from './error-message'
import {
  shouldAutoFollowCursorWorkspace,
  type CursorWorkspaceDetection
} from '../../domain/cursor-workspace'
import {
  shouldShowCollaborationForRun,
  summarizeTeamCollaborationForRun,
  visibleTeamCollaborationSnapshot
} from './team/team-collaboration-view'

const EMPTY_SNAPSHOT: DesktopSnapshot = {
  connection: {
    state: 'connected',
    endpoint: 'qunshu://local-channel-runtime',
    attempt: 0,
    lastError: ''
  },
  sessions: [],
  conversations: {},
  protocolIssues: [],
  // 必须为 0：任何真实快照（含主进程启动早于渲染器的初始快照）都应通过 updatedAt 守卫。
  updatedAt: 0
}

function cursorWorkspaceFingerprint(detection?: CursorWorkspaceDetection): string {
  if (!detection) return ''
  return JSON.stringify({
    state: detection.state,
    source: detection.source,
    confidence: detection.confidence,
    workspace: detection.workspace && {
      id: detection.workspace.id,
      cursorWorkspaceId: detection.workspace.cursorWorkspaceId,
      channelIds: detection.workspace.channelIds
    },
    candidates: detection.candidates.map((candidate) => candidate.id),
    detail: detection.detail
  })
}

// 会话对象指纹与快照结构共享：见 snapshot-sharing.ts（独立模块，含单测）。
export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT)
  const [taskPool, setTaskPool] = useState(emptyTaskPoolSnapshot())
  const [teamControl, setTeamControl] = useState(emptyTeamControlSnapshot())
  const [collaboration, setCollaboration] = useState(emptyTeamCollaborationSnapshot())
  const [teamSetup, setTeamSetup] = useState<TeamSetupDraft>()
  // 初始模块支持 URL hash 深链接（如 #sessions:2 直达 CH-2 会话），生产无 hash 时默认大厅。
  const [activeModule, setActiveModule] = useState<AppModule>(() => {
    const [module] = window.location.hash.slice(1).split(':')
    return module === 'sessions' ? module : 'lobby'
  })
  const [selectedChannelId, setSelectedChannelId] = useState<string | undefined>(() => {
    const [module, channel] = window.location.hash.slice(1).split(':')
    return module === 'sessions' && channel ? channel : undefined
  })
  const [teamNotice, setTeamNotice] = useState('')
  const [teamMcpReloadRequired, setTeamMcpReloadRequired] = useState(false)
  const [handoffOptions, setHandoffOptions] = useState<TeamHandoffOptions>()
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [handoffError, setHandoffError] = useState('')
  const [cursorAccounts, setCursorAccounts] = useState<CursorAccountMetadata[]>([])
  const [cursorAccountBusy, setCursorAccountBusy] = useState(false)
  const [cursorAccountError, setCursorAccountError] = useState('')
  const [cursorUpdatePreferences, setCursorUpdatePreferences] = useState<CursorUpdatePreferences>()
  const [cursorUpdateBusy, setCursorUpdateBusy] = useState(false)
  const [cursorUpdateError, setCursorUpdateError] = useState('')
  const [aozaiStatus, setAozaiStatus] = useState<AozaiCardStatus>({ saved: false })
  const [aozaiBusy, setAozaiBusy] = useState(false)
  const [aozaiError, setAozaiError] = useState('')
  const [aozaiProgress, setAozaiProgress] = useState<AozaiProgressEvent | null>(null)
  const [aozaiFeedback, setAozaiFeedback] = useState<{ ok: boolean; message: string } | null>(null)
  const [agentLaunchPlan, setAgentLaunchPlan] = useState<AgentLaunchPlan | undefined>(undefined)
  const [accountAutomationSettings, setAccountAutomationSettings] = useState<AccountAutomationSettings>({ enabled: false, delaySec: 30 })
  const [accountAutomationRun, setAccountAutomationRun] = useState<AccountAutomationRun | undefined>(undefined)
  const [cursorWorkspace, setCursorWorkspace] = useState<CursorWorkspaceDetection>()
  const [teamControlLoaded, setTeamControlLoaded] = useState(false)
  // 输入框草稿与附件按通道保存：切换 Agent 不丢失，回来可直接继续编辑/发送。
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({})
  const [composerAttachments, setComposerAttachments] = useState<Record<string, MessageAttachment[]>>({})
  // CDP 自动保持（auto-heal）：开关状态 + 看门事件（倒计时提示）。
  const [cdpAutoHealEnabled, setCdpAutoHealEnabled] = useState(false)
  const [cdpAutoHealEvent, setCdpAutoHealEvent] = useState<CdpAutoHealEvent>()
  const autoFollowedWorkspaceRef = useRef('')
  const mcpReconcileRunRef = useRef<string | undefined>(undefined)
  const activeRunRef = useRef<{ id?: string; status?: TeamRunStatus }>({})
  const activeWorkspace = teamControl.workspaces.find((workspace) => workspace.id === teamControl.activeWorkspaceId)
  const activeProjectName = activeWorkspace?.name ?? cursorWorkspace?.workspace?.name
  const memberChannelIds = teamControl.members
    .map((member) => member.binding?.channelId ?? member.slot.channelId)
    .filter((channelId): channelId is string => Boolean(channelId))
  const memberChannelKey = memberChannelIds
    .sort()
    .join(',')
  const reconcileKeyOf = (snapshot: ReturnType<typeof emptyTeamControlSnapshot>): string | undefined => {
    if (!snapshot.activeRun) return undefined
    const channels = snapshot.members
      .map((member) => member.binding?.channelId ?? member.slot.channelId)
      .filter((channelId): channelId is string => Boolean(channelId))
      .sort()
      .join(',')
    return `${snapshot.activeRun.id}:${channels}`
  }

  // 快照来自两个来源（主进程推送 + 操作后的手动拉取），到达顺序不保证；
  // 用 revision 单调守卫丢弃迟到的旧快照，作用域（runId/workspace）切换时无条件接受。
  const acceptSnapshot = useCallback((incoming: DesktopSnapshot) => {
    setSnapshot((previous) => incoming.updatedAt >= previous.updatedAt ? shareSnapshotStructure(previous, incoming) : previous)
  }, [])
  const acceptTaskPool = useCallback((incoming: ReturnType<typeof emptyTaskPoolSnapshot>) => {
    setTaskPool((previous) => newestTaskPoolSnapshot(previous, incoming))
  }, [])
  const acceptTeamControl = useCallback((incoming: ReturnType<typeof emptyTeamControlSnapshot>) => {
    setTeamControl((previous) => {
      if (incoming.revision < previous.revision) return previous
      activeRunRef.current = {
        id: incoming.activeRun?.id,
        status: incoming.activeRun?.status
      }
      return incoming
    })
  }, [])
  const acceptCollaboration = useCallback((incoming: ReturnType<typeof emptyTeamCollaborationSnapshot>) => {
    setCollaboration((previous) => {
      const activeRun = activeRunRef.current
      if (!activeRun.id || !['launching', 'running', 'attention', 'paused'].includes(activeRun.status ?? '')) {
        return previous.runId === activeRun.id && previous.messageOrder.length === 0
          ? previous
          : emptyTeamCollaborationSnapshot(activeRun.id)
      }
      if (activeRun.id && incoming.runId !== activeRun.id) {
        return previous.runId === activeRun.id ? previous : emptyTeamCollaborationSnapshot(activeRun.id)
      }
      if (!activeRun.id && incoming.runId) {
        return previous.runId === undefined ? previous : emptyTeamCollaborationSnapshot()
      }
      return previous.runId !== incoming.runId || incoming.revision >= previous.revision ? incoming : previous
    })
  }, [])

  useEffect(() => {
    const unsubscribe = window.qingtianDesktop.onSnapshot(acceptSnapshot)
    const unsubscribeTasks = window.qingtianDesktop.onTaskPoolSnapshot(acceptTaskPool)
    const unsubscribeTeamControl = window.qingtianDesktop.onTeamControlSnapshot(acceptTeamControl)
    const unsubscribeCollaboration = window.qingtianDesktop.onTeamCollaborationSnapshot(acceptCollaboration)
    void window.qingtianDesktop.getSnapshot().then(acceptSnapshot)
    void window.qingtianDesktop.getTaskPoolSnapshot().then(acceptTaskPool)
    void window.qingtianDesktop.getTeamControlSnapshot().then((incoming) => {
      acceptTeamControl(incoming)
      setTeamControlLoaded(true)
    })
    void window.qingtianDesktop.getTeamCollaborationSnapshot().then(acceptCollaboration)
    return () => {
      unsubscribe()
      unsubscribeTasks()
      unsubscribeTeamControl()
      unsubscribeCollaboration()
    }
  }, [acceptCollaboration, acceptSnapshot, acceptTaskPool, acceptTeamControl])

  useEffect(() => {
    void window.qingtianDesktop.listCursorAccounts()
      .then(setCursorAccounts)
      .catch((reason: unknown) => setCursorAccountError(reason instanceof Error ? reason.message : String(reason)))
    void window.qingtianDesktop.getAozaiCardStatus()
      .then(setAozaiStatus)
      .catch(() => {})
    void window.qingtianDesktop.getAgentLaunchPlan()
      .then((plan) => { if (plan) setAgentLaunchPlan(plan) })
      .catch(() => {})
    void window.qingtianDesktop.getAccountAutomationSettings()
      .then(setAccountAutomationSettings)
      .catch(() => {})
    void window.qingtianDesktop.getAccountAutomationRun()
      .then((run) => { if (run.phase !== 'idle') setAccountAutomationRun(run) })
      .catch(() => {})
    const unsubscribeAozai = window.qingtianDesktop.onAozaiProgress(setAozaiProgress)
    const unsubscribeAgentLaunch = window.qingtianDesktop.onAgentLaunchProgress(setAgentLaunchPlan)
    const unsubscribeCdpAutoHeal = window.qingtianDesktop.onCdpAutoHealEvent((event) => {
      if (event.phase === 'done') {
        setCdpAutoHealEvent(undefined)
        setTeamNotice(event.ok ? event.message : `自动重启未成功：${event.message}`)
        return
      }
      if (event.phase === 'cancelled') {
        setCdpAutoHealEvent(undefined)
        setTeamNotice('已取消本次自动重启；本次 Cursor 启动期间不再提示。')
        return
      }
      setCdpAutoHealEvent(event)
    })
    void window.qingtianDesktop.getCursorCdpSettings()
      .then((settings) => setCdpAutoHealEnabled(settings.autoHealEnabled))
      .catch(() => {})
    void window.qingtianDesktop.getCursorUpdatePreferences()
      .then(setCursorUpdatePreferences)
      .catch((reason: unknown) => setCursorUpdateError(userFacingErrorMessage(reason)))
    const unsubscribeAccountAutomation = window.qingtianDesktop.onAccountAutomationProgress((run) => {
      setAccountAutomationRun(run)
      if (run.phase === 'done' || run.phase === 'failed') {
        // 自动化会改动账号列表（新 token 入库 / 移除本地记录），终态后刷新
        void window.qingtianDesktop.listCursorAccounts().then(setCursorAccounts).catch(() => {})
        // 链内为提速跳过了余额刷新，这里链外异步补齐
        void window.qingtianDesktop.refreshAozaiBalance().then(setAozaiStatus).catch(() => {})
      }
    })
    return () => {
      unsubscribeAozai()
      unsubscribeAgentLaunch()
      unsubscribeCdpAutoHeal()
      unsubscribeAccountAutomation()
    }
  }, [])

  const selectSession = useCallback((channelId: string) => {
    setActiveModule('sessions')
    setSelectedChannelId(channelId)
  }, [])

  const launchAgentSessions = useCallback(async (channelIds: string[]): Promise<AgentLaunchPlan> => {
    const plan = await window.qingtianDesktop.launchAgentSessions(channelIds)
    setAgentLaunchPlan(plan)
    return plan
  }, [])

  const refreshAozaiBalance = useCallback(async (options: { silent?: boolean } = {}): Promise<void> => {
    if (!options.silent) {
      setAozaiBusy(true)
      setAozaiError('')
    }
    try {
      setAozaiStatus(await window.qingtianDesktop.refreshAozaiBalance())
    } catch (reason) {
      if (!options.silent) setAozaiError(userFacingErrorMessage(reason))
    } finally {
      if (!options.silent) setAozaiBusy(false)
    }
  }, [])

  const saveAozaiCard = useCallback(async (cardCode: string): Promise<void> => {
    setAozaiBusy(true)
    setAozaiError('')
    setAozaiFeedback(null)
    try {
      setAozaiStatus(await window.qingtianDesktop.saveAozaiCard(cardCode))
    } catch (reason) {
      setAozaiError(userFacingErrorMessage(reason))
      throw reason
    } finally {
      setAozaiBusy(false)
    }
  }, [])

  const clearAozaiCard = useCallback(async (): Promise<void> => {
    setAozaiBusy(true)
    setAozaiError('')
    setAozaiFeedback(null)
    try {
      setAozaiStatus(await window.qingtianDesktop.clearAozaiCard())
    } catch (reason) {
      setAozaiError(userFacingErrorMessage(reason))
    } finally {
      setAozaiBusy(false)
    }
  }, [])

  const processAozaiAccount = useCallback(async (accountId: string): Promise<void> => {
    setAozaiBusy(true)
    setAozaiError('')
    setAozaiFeedback(null)
    setAozaiProgress(null)
    try {
      const result = await window.qingtianDesktop.processAozaiAccount({ accountId, requestId: crypto.randomUUID() })
      setAozaiFeedback({ ok: result.ok, message: result.message })
      setAozaiStatus((previous) => ({
        ...previous,
        remaining: typeof result.remaining === 'number' ? result.remaining : previous.remaining
      }))
    } catch (reason) {
      setAozaiFeedback({ ok: false, message: userFacingErrorMessage(reason) })
    } finally {
      setAozaiBusy(false)
      setAozaiProgress(null)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let polling = false
    const inspect = async (): Promise<void> => {
      if (polling) return
      polling = true
      try {
        const detection = await window.qingtianDesktop.detectCursorWorkspace()
        if (!disposed) {
          setCursorWorkspace((previous) => (
            cursorWorkspaceFingerprint(previous) === cursorWorkspaceFingerprint(detection)
              ? previous
              : detection
          ))
        }
      } catch {
        // Cursor may be updating its state database while switching windows.
        // Keep the last trustworthy detection and try again on the next poll.
      } finally {
        polling = false
      }
    }
    void inspect()
    const timer = setInterval(() => void inspect(), 2_000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const run = teamControl.activeRun
    if (!run || !['draft', 'ready'].includes(run.status)) return
    if (memberChannelIds.length === 0) return
    const topologyKey = `${run.id}:${memberChannelKey}`
    if (mcpReconcileRunRef.current === topologyKey) return
    mcpReconcileRunRef.current = topologyKey
    void window.qingtianDesktop.installTaskMcp()
      .then(async (installation) => {
        if (installation.ok) {
          setTeamMcpReloadRequired(installation.restartRequired)
          setTeamNotice(installation.restartRequired
            ? '已自动升级为稳定通道 MCP；请重载 Cursor 一次，之后新一轮无需重复重载。'
            : '本轮通道已自动接入，无需重载 Cursor。')
        }
        acceptTeamControl(await window.qingtianDesktop.getTeamControlSnapshot())
      })
      .catch((reason: unknown) => {
        setTeamMcpReloadRequired(true)
        setTeamNotice(`自动接入 MCP 失败：${reason instanceof Error ? reason.message : String(reason)}`)
      })
  }, [
    acceptTeamControl,
    teamControl.activeRun?.id,
    teamControl.activeRun?.status,
    memberChannelKey
  ])

  useEffect(() => {
    if (!teamControlLoaded) return
    const run = teamControl.activeRun
    activeRunRef.current = { id: run?.id, status: run?.status }
    setCollaboration((previous) => {
      if (!shouldShowCollaborationForRun(previous, run)) {
        return previous.runId === run?.id && previous.messageOrder.length === 0
          ? previous
          : emptyTeamCollaborationSnapshot(run?.id)
      }
      return previous
    })
    void window.qingtianDesktop.getTeamCollaborationSnapshot()
      .then(acceptCollaboration)
      .catch(() => {})
  }, [acceptCollaboration, teamControl.activeRun?.id, teamControl.activeRun?.status, teamControlLoaded])

  const visibleSnapshot = useMemo(() => {
    const memberByChannel = new Map(teamControl.members.flatMap((member) => {
      const channelId = member.binding?.channelId ?? member.slot.channelId
      return channelId ? [[channelId, member] as const] : []
    }))
    return {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => {
        const member = memberByChannel.get(session.channelId)
        if (!member) return session
        const task = taskPool.taskOrder
          .map((taskId) => taskPool.tasks[taskId])
          .find((candidate) => candidate?.assigneeSessionId === member.binding?.agentSessionId)
        return {
          ...session,
          displayName: `${member.role.name} · CH-${session.channelId}`,
          roleName: member.slot.name,
          roleTemplateKey: member.role.templateKey,
          avatarId: member.slot.avatarId,
          status: member.readiness === 'launching' ? 'reviving' as const : session.status,
          currentTask: task?.title ?? ''
        }
      })
    }
  }, [snapshot, taskPool, teamControl.members])
  const selectedSession = visibleSnapshot.sessions.find((session) => session.channelId === selectedChannelId)
  const selectedMember = teamControl.members.find((member) => (
    (member.binding?.channelId ?? member.slot.channelId) === selectedSession?.channelId
  ))
  const selectedHandoffSlotId = selectedMember?.binding
    && !selectedMember.runtime?.online
    && teamControl.activeRun
    && ['running', 'attention'].includes(teamControl.activeRun.status)
    ? selectedMember.slot.id
    : undefined
  useEffect(() => {
    if (activeModule !== 'sessions') return
    if (selectedChannelId && visibleSnapshot.sessions.some((session) => session.channelId === selectedChannelId)) return
    const fallback = visibleSnapshot.sessions.find((session) => session.online) ?? visibleSnapshot.sessions[0]
    if (fallback) setSelectedChannelId(fallback.channelId)
  }, [activeModule, selectedChannelId, visibleSnapshot.sessions])
  const activeRunCollaboration = useMemo(() => (
    visibleTeamCollaborationSnapshot(collaboration, teamControl.activeRun)
  ), [collaboration, teamControl.activeRun])
  const collaborationUnread = useMemo(() => (
    summarizeTeamCollaborationForRun(collaboration, teamControl.activeRun).operatorUnread
  ), [collaboration, teamControl.activeRun])
  const changeModule = useCallback((module: AppModule): void => {
    setActiveModule(module)
    if (module !== 'sessions') setSelectedChannelId(undefined)
  }, [])

  const openManualHandoff = useCallback(async (slotId: string): Promise<void> => {
    setHandoffBusy(true)
    setHandoffError('')
    try {
      setHandoffOptions(await window.qingtianDesktop.getManualHandoffOptions(slotId))
    } catch (reason) {
      setHandoffError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setHandoffBusy(false)
    }
  }, [])

  const confirmManualHandoff = useCallback(async (agentSessionId: string): Promise<void> => {
    if (!handoffOptions) return
    setHandoffBusy(true)
    setHandoffError('')
    try {
      const result = await window.qingtianDesktop.manualHandoff({
        sourceSlotId: handoffOptions.sourceSlotId,
        replacementAgentSessionId: agentSessionId
      })
      acceptTeamControl(result.team)
      const [tasks, messages, desktop] = await Promise.all([
        window.qingtianDesktop.getTaskPoolSnapshot(),
        window.qingtianDesktop.getTeamCollaborationSnapshot(),
        window.qingtianDesktop.getSnapshot()
      ])
      acceptTaskPool(tasks)
      acceptCollaboration(messages)
      acceptSnapshot(desktop)
      const replacementChannel = result.team.members
        .find((member) => member.slot.id === handoffOptions.sourceSlotId)?.binding?.channelId
      if (replacementChannel) setSelectedChannelId(replacementChannel)
      setHandoffOptions(undefined)
    } catch (reason) {
      setHandoffError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setHandoffBusy(false)
    }
  }, [acceptCollaboration, acceptSnapshot, acceptTaskPool, acceptTeamControl, handoffOptions])

  const applyWorkspaceSelection = useCallback(async (
    result: ChooseTeamWorkspaceResult,
    detected: boolean
  ): Promise<void> => {
    if ('cancelled' in result) return
    setActiveModule('lobby')
    setSelectedChannelId(undefined)
    if (result.kind === 'setup') {
      setTeamSetup(result.draft)
      setTeamNotice(detected ? `已自动识别 Cursor 当前工程：${result.draft.workspaceName}` : '')
      return
    }
    setTeamSetup(undefined)
    acceptTeamControl(result.snapshot)
    const [tasks, messages, desktop] = await Promise.all([
      window.qingtianDesktop.getTaskPoolSnapshot(),
      window.qingtianDesktop.getTeamCollaborationSnapshot(),
      window.qingtianDesktop.getSnapshot()
    ])
    acceptTaskPool(tasks)
    acceptCollaboration(messages)
    acceptSnapshot(desktop)
    const workspace = result.snapshot.workspaces.find((item) => item.id === result.snapshot.activeWorkspaceId)
    setTeamNotice(workspace ? `${detected ? '已切换到 Cursor 当前工程' : '已切换工程'}：${workspace.name}` : '')
  }, [acceptCollaboration, acceptSnapshot, acceptTaskPool, acceptTeamControl])

  const followDetectedWorkspace = useCallback(async (): Promise<void> => {
    await applyWorkspaceSelection(await window.qingtianDesktop.prepareDetectedTeamWorkspace(), true)
  }, [applyWorkspaceSelection])

  const chooseWorkspace = useCallback(async (): Promise<void> => {
    await applyWorkspaceSelection(await window.qingtianDesktop.chooseTeamWorkspace(), false)
  }, [applyWorkspaceSelection])

  useEffect(() => {
    if (!teamControlLoaded || teamSetup || !cursorWorkspace?.workspace) return
    if (!shouldAutoFollowCursorWorkspace({
      detection: cursorWorkspace,
      activeWorkspaceId: teamControl.activeWorkspaceId,
      activeRunStatus: teamControl.activeRun?.status
    })) return
    const key = `${cursorWorkspace.workspace.id}:${cursorWorkspace.workspace.cursorWorkspaceId ?? ''}`
    if (autoFollowedWorkspaceRef.current === key) return
    autoFollowedWorkspaceRef.current = key
    void followDetectedWorkspace().catch((reason: unknown) => {
      setTeamNotice(`已识别当前 Cursor 工程，但自动切换失败：${reason instanceof Error ? reason.message : String(reason)}`)
    })
  }, [
    cursorWorkspace,
    followDetectedWorkspace,
    teamControl.activeRun?.status,
    teamControl.activeWorkspaceId,
    teamControlLoaded,
    teamSetup
  ])

  return (
    <>
    <DesktopShell
      snapshot={visibleSnapshot}
      activeModule={activeModule}
      sidebar={activeModule === 'sessions' ? (
        <SessionSidebar
          snapshot={visibleSnapshot}
          selectedChannelId={selectedSession?.channelId}
          onSelectSession={selectSession}
        />
      ) : null}
      collaborationUnread={collaborationUnread}
      cursorAccountLabel={cursorAccounts.find((account) => account.active)?.label}
      cursorAccountCount={cursorAccounts.length}
      cursorWorkspace={cursorWorkspace}
      displayedWorkspaceId={teamSetup?.workspaceId ?? teamControl.activeWorkspaceId}
      wideContent={activeModule === 'lobby'}
      teamChannelIds={memberChannelIds}
      onModuleChange={changeModule}
      onOpenCursorAccounts={() => {
        setCursorAccountError('')
        setAozaiError('')
        setAozaiFeedback(null)
        setActiveModule('lobby')
        setSelectedChannelId(undefined)
        void window.qingtianDesktop.getAozaiCardStatus()
          .then((status) => {
            setAozaiStatus(status)
            if (status.saved) void refreshAozaiBalance({ silent: true })
          })
          .catch(() => {})
      }}
      onDetectedWorkspaceClick={() => {
        const action = cursorWorkspace?.state === 'ambiguous' ? chooseWorkspace : followDetectedWorkspace
        void action().catch((reason: unknown) => {
          setTeamNotice(reason instanceof Error ? reason.message : String(reason))
        })
      }}
    >
      {activeModule === 'lobby' && teamSetup ? (
        <TeamSetupPage
          key={teamSetup.draftId}
          draft={teamSetup}
          onCancel={() => {
            setTeamSetup(undefined)
            setTeamNotice('')
          }}
          onCreate={async (input) => {
            const result = await window.qingtianDesktop.createTeam(input)
            acceptTeamControl(result)
            mcpReconcileRunRef.current = reconcileKeyOf(result)
            try {
              const installation = await window.qingtianDesktop.installTaskMcp()
              setTeamMcpReloadRequired(installation.ok && installation.restartRequired)
              if (!installation.ok) {
                setTeamNotice('团队已创建；团队 MCP 尚未安装。请安装后在 Cursor 手动启动 Agent 会话。')
              } else if (installation.restartRequired) {
                setTeamNotice('团队已创建并安装 qt-ch 团队 MCP；请重载 Cursor，再手动启动 Agent 会话。')
              } else {
                setTeamNotice('团队与 qt-ch 团队 MCP 已就绪。请在 Cursor 手动启动 Agent 会话，群枢会自动接管。')
              }
            } catch (reason) {
              setTeamMcpReloadRequired(true)
              setTeamNotice(`团队已创建；MCP 自动接入失败：${reason instanceof Error ? reason.message : String(reason)}`)
            }
            const [desktop, latestTeam, tasks, messages] = await Promise.all([
              window.qingtianDesktop.getSnapshot(),
              window.qingtianDesktop.getTeamControlSnapshot(),
              window.qingtianDesktop.getTaskPoolSnapshot(),
              window.qingtianDesktop.getTeamCollaborationSnapshot()
            ])
            acceptSnapshot(desktop)
            acceptTeamControl(latestTeam)
            acceptTaskPool(tasks)
            acceptCollaboration(messages)
            setTeamSetup(undefined)
          }}
        />
      ) : activeModule === 'lobby' ? (
        <LobbyPage
          team={teamControl}
          collaboration={activeRunCollaboration}
          externalNotice={teamNotice}
          autoStartOnGoalSave={!teamMcpReloadRequired}
          mcpReloadRequired={teamMcpReloadRequired}
          onChooseWorkspace={chooseWorkspace}
          onReconfigure={async () => {
            setTeamSetup(await window.qingtianDesktop.prepareActiveTeamSetup())
          }}
          onUpdateGoal={async (goal) => {
            const result = await window.qingtianDesktop.updateTeamGoal(goal)
            acceptTeamControl(result)
            return result
          }}
          onInstallMcp={async () => {
            const installation = await window.qingtianDesktop.installTaskMcp()
            if (installation.ok) setTeamMcpReloadRequired(installation.restartRequired)
            const snapshot = await window.qingtianDesktop.getTeamControlSnapshot()
            acceptTeamControl(snapshot)
            return { installation, snapshot }
          }}
          onLaunch={async () => {
            const result = await window.qingtianDesktop.launchTeam()
            acceptTeamControl(result)
            return result
          }}
          agentLaunchPlan={agentLaunchPlan}
          onLaunchAgentSessions={launchAgentSessions}
          onEnableCursorCdp={() => window.qingtianDesktop.enableCursorCdp()}
          cdpAutoHealEnabled={cdpAutoHealEnabled}
          cdpAutoHealEvent={cdpAutoHealEvent}
          onToggleCdpAutoHeal={async (enabled) => {
            const saved = await window.qingtianDesktop.saveCursorCdpSettings({ autoHealEnabled: enabled })
            setCdpAutoHealEnabled(saved.autoHealEnabled)
          }}
          onCancelCdpAutoHealCountdown={async () => {
            await window.qingtianDesktop.cancelCdpAutoHealCountdown()
          }}
          account={{
            accounts: cursorAccounts,
            busy: cursorAccountBusy,
            error: cursorAccountError,
            onSave: async (input) => {
              setCursorAccountBusy(true); setCursorAccountError('')
              try { setCursorAccounts(await window.qingtianDesktop.saveCursorAccount(input)) }
              catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)); throw reason }
              finally { setCursorAccountBusy(false) }
            },
            onSelect: async (accountId) => {
              setCursorAccountBusy(true); setCursorAccountError('')
              try { setCursorAccounts(await window.qingtianDesktop.selectCursorAccount(accountId)) }
              catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
              finally { setCursorAccountBusy(false) }
            },
            onRemove: async (accountId) => {
              setCursorAccountBusy(true); setCursorAccountError('')
              try { setCursorAccounts(await window.qingtianDesktop.removeCursorAccount(accountId)) }
              catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
              finally { setCursorAccountBusy(false) }
            },
            onImportFromLocal: async () => {
              setCursorAccountBusy(true); setCursorAccountError('')
              try { setCursorAccounts(await window.qingtianDesktop.importCursorAccountFromLocalCursor()) }
              catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
              finally { setCursorAccountBusy(false) }
            },
            onImportFromBrowser: async () => {
              setCursorAccountBusy(true); setCursorAccountError('')
              try { setCursorAccounts(await window.qingtianDesktop.importCursorAccountFromBrowser()) }
              catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
              finally { setCursorAccountBusy(false) }
            },
            onInject: async (accountId) => {
              setCursorAccountBusy(true); setCursorAccountError('')
              try {
                const result = await window.qingtianDesktop.injectCursorAccount(accountId)
                if (!result.injected) return
                if (result.tokenExpired) {
                  setCursorAccountError('⚠️ 注入的 Token 已过期，请重新获取后再注入。')
                  return
                }
                if (result.hotSwapped) {
                  setCursorAccountError('✅ 注入并热切换成功，Cursor 登录态已即时生效。')
                  return
                }
                if (!result.cursorPid) {
                  setCursorAccountError('✅ 注入成功。Cursor 当前未在运行，登录态将在下次启动时生效。')
                  return
                }
                // 默认不重启：重启 Cursor 会关闭所有窗口并断开全部群枢通道，必须用户显式确认
                const restartNow = window.confirm(
                  '注入成功（登录态已写入 Cursor）。\n\n' +
                  '立即生效需要重启 Cursor：将关闭所有 Cursor 窗口，并断开窗口中承载的全部群枢通道（群枢界面会短暂无响应）。\n\n' +
                  '点「确定」立即重启 Cursor；点「取消」保留注入结果，稍后你自行重启 Cursor 同样生效。'
                )
                if (!restartNow) {
                  setCursorAccountError('✅ 注入成功，未重启 Cursor。下次你手动重启 Cursor 后登录态生效。')
                  return
                }
                const restarted = await window.qingtianDesktop.injectCursorAccount(accountId, { restart: true })
                setCursorAccountError(
                  restarted.restartPerformed
                    ? '✅ 已注入并重启 Cursor，请等待 Cursor 重新拉起后检查登录态。'
                    : '✅ 注入成功。Cursor 未在运行或热切换已成功，无需重启。'
                )
              } catch (reason) { setCursorAccountError(reason instanceof Error ? reason.message : String(reason)) }
              finally { setCursorAccountBusy(false) }
            },
            aozaiStatus,
            aozaiBusy,
            aozaiError,
            aozaiProgress,
            aozaiFeedback,
            onSaveAozaiCard: saveAozaiCard,
            onClearAozaiCard: clearAozaiCard,
            onRefreshAozaiBalance: refreshAozaiBalance,
            onProcessAozaiAccount: processAozaiAccount,
            automationSettings: accountAutomationSettings,
            automationRun: accountAutomationRun,
            cursorUpdatePreferences,
            cursorUpdateBusy,
            cursorUpdateError,
            onSetCursorAutoUpdateDisabled: async (disabled) => {
              setCursorUpdateBusy(true); setCursorUpdateError('')
              try {
                const result = await window.qingtianDesktop.setCursorAutoUpdateDisabled(disabled)
                setCursorUpdatePreferences(result)
              } catch (reason) {
                setCursorUpdateError(userFacingErrorMessage(reason))
              } finally {
                setCursorUpdateBusy(false)
              }
            },
            onSaveAutomationSettings: (settings) => {
              void window.qingtianDesktop.saveAccountAutomationSettings(settings)
                .then(setAccountAutomationSettings)
                .catch((reason: unknown) => setAozaiError(userFacingErrorMessage(reason)))
            },
            onCancelAutomation: () => {
              void window.qingtianDesktop.cancelAccountAutomation().catch(() => {})
            }
          }}
          onCreateNextRun={async () => {
            const created = await window.qingtianDesktop.createNextTeamRun()
            acceptTeamControl(created)
            acceptCollaboration(emptyTeamCollaborationSnapshot(created.activeRun?.id))
            mcpReconcileRunRef.current = reconcileKeyOf(created)
            let restartRequired = false
            let issue: string | undefined
            try {
              const installation = await window.qingtianDesktop.installTaskMcp()
              restartRequired = installation.ok ? installation.restartRequired : false
              if (!installation.ok) {
                issue = '团队 MCP 安装已取消，请安装后再在 Cursor 手动启动 Agent 会话。'
              }
            } catch (reason) {
              issue = `MCP 自动接入失败：${reason instanceof Error ? reason.message : String(reason)}`
            }
            const [snapshot, desktop, messages] = await Promise.all([
              window.qingtianDesktop.getTeamControlSnapshot(),
              window.qingtianDesktop.getSnapshot(),
              window.qingtianDesktop.getTeamCollaborationSnapshot()
            ])
            acceptTeamControl(snapshot)
            acceptSnapshot(desktop)
            acceptCollaboration(messages)
            setTeamMcpReloadRequired(restartRequired)
            setTeamNotice(issue
              ? `新一轮已建立；${issue}`
              : restartRequired
                ? '新一轮已建立；请重载 Cursor，再手动启动 Agent 会话。'
                : '新一轮已建立；请填写目标，并在 Cursor 手动启动 Agent 会话。')
            return {
              snapshot,
              restartRequired,
              issue
            }
          }}
        />
      ) : selectedSession ? (
        <SessionWorkspace
          key={selectedSession.channelId}
          session={selectedSession}
          entries={snapshot.conversations[selectedSession.channelId] ?? []}
          currentProjectName={activeProjectName}
          onBack={() => setSelectedChannelId(undefined)}
          onHandoff={selectedHandoffSlotId ? () => void openManualHandoff(selectedHandoffSlotId) : undefined}
          draft={composerDrafts[selectedSession.channelId] ?? ''}
          onDraftChange={(value) => setComposerDrafts((current) => ({ ...current, [selectedSession.channelId]: value }))}
          attachments={composerAttachments[selectedSession.channelId] ?? []}
          onAttachmentsChange={(attachments) => setComposerAttachments((current) => ({ ...current, [selectedSession.channelId]: attachments }))}
          liveProcess={snapshot.liveProcess?.[selectedSession.channelId]}
          onSend={async (text, attachments) => {
            await window.qingtianDesktop.sendMessage({ channelId: selectedSession.channelId, text, attachments })
          }}
        />
      ) : (
        <SessionOverview
          snapshot={visibleSnapshot}
        />
      )}
    </DesktopShell>
    {handoffOptions ? (
      <ManualHandoffDialog
        key={handoffOptions.sourceSlotId}
        options={handoffOptions}
        busy={handoffBusy}
        error={handoffError}
        onClose={() => { if (!handoffBusy) setHandoffOptions(undefined) }}
        onConfirm={confirmManualHandoff}
      />
    ) : null}
    </>
  )
}
