import { useEffect, useState } from 'react'
import type { AgentLaunchPlan, AgentLaunchRequest } from '../../../domain/agent-launch'
import type { CursorModelOption, CursorModelSelection } from '../../../domain/cursor-model'
import type { CdpAutoHealEvent } from '../../../domain/cursor-cdp'
import { hasInFlightExecution, isAgentOnDuty } from '../../../domain/channel-message'
import {
  workspaceRunMode,
  type TeamControlSnapshot
} from '../../../domain/team-control'
import type { DetectedCursorWorkspace } from '../../../domain/cursor-workspace'
import type { CreateIndependentSessionsInput, IndependentWorkspaceSelection } from '../../../shared/desktop-api'
import { cursorModelSelectionFromOption, normalizeCursorModelSelection } from '../cursor-model-selection'
import { LobbySessionLaunchTile } from './LobbySessionLaunchTile'

interface IndependentSessionPageProps {
  team: TeamControlSnapshot
  detectedWorkspace?: DetectedCursorWorkspace
  cursorModels: CursorModelOption[]
  plan?: AgentLaunchPlan
  cdpAutoHealEnabled: boolean
  cdpAutoHealEvent?: CdpAutoHealEvent
  onCreate: (input: CreateIndependentSessionsInput) => Promise<AgentLaunchPlan>
  onChooseWorkspace: () => Promise<IndependentWorkspaceSelection | undefined>
  onLaunch: (requests: AgentLaunchRequest[]) => Promise<AgentLaunchPlan>
  onPersistModelSelection?: (channelId: string, selection: CursorModelSelection) => Promise<TeamControlSnapshot>
  onEnableCursorCdp?: () => Promise<{ ok: boolean; message: string; suggestAutoHeal?: boolean }>
  onToggleCdpAutoHeal?: (enabled: boolean) => Promise<void>
  onCancelCdpAutoHealCountdown?: () => Promise<void>
  onOpenSessions: () => void
}

export function IndependentSessionPage({
  team,
  detectedWorkspace,
  cursorModels,
  plan,
  cdpAutoHealEnabled,
  cdpAutoHealEvent,
  onCreate,
  onChooseWorkspace,
  onLaunch,
  onPersistModelSelection,
  onEnableCursorCdp,
  onToggleCdpAutoHeal,
  onCancelCdpAutoHealCountdown,
  onOpenSessions
}: IndependentSessionPageProps): React.JSX.Element {
  const [count, setCount] = useState(3)
  const [draftSelections, setDraftSelections] = useState<Record<string, CursorModelSelection>>({})
  const [chosenWorkspace, setChosenWorkspace] = useState<IndependentWorkspaceSelection>()
  const [replaceMode, setReplaceMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const activeRun = team.activeRun
  const independentActive = workspaceRunMode(activeRun) === 'independent'
  const configuringNew = !independentActive || replaceMode
  const activeWorkspace = team.workspaces.find((workspace) => workspace.id === team.activeWorkspaceId)
  const workspace = independentActive ? activeWorkspace : chosenWorkspace ?? detectedWorkspace ?? activeWorkspace
  const members = independentActive ? team.members.filter((member) => member.slot.solo === true) : []
  const pendingMembers = members.filter((member) => !isAgentOnDuty(member.runtime))
  const pendingEvidence = pendingMembers.some((member) => !member.runtime)
  const currentBlocksReplacement = members.some((member) => (
    !member.runtime || member.runtime.online || hasInFlightExecution(member.runtime)
  ))
  const channels = configuringNew
    ? Array.from({ length: count }, (_, index) => String(index + 1))
    : pendingMembers.map((member) => member.binding?.channelId ?? member.slot.channelId)
      .filter((channelId): channelId is string => Boolean(channelId))
  const defaultModel = cursorModels.find((model) => model.selected) ?? cursorModels[0]
  const defaultSelection = cursorModelSelectionFromOption(defaultModel)
  const selections = Object.fromEntries(channels.flatMap((channelId) => {
    const persisted = members.find((member) => (
      (member.binding?.channelId ?? member.slot.channelId) === channelId
    ))?.slot.modelSelection
    const candidate = draftSelections[channelId] ?? persisted ?? defaultSelection
    const option = candidate ? cursorModels.find((model) => model.modelId === candidate.modelId) : undefined
    const normalized = candidate && option ? normalizeCursorModelSelection(candidate, option) : defaultSelection
    return normalized ? [[channelId, normalized] as const] : []
  }))
  const activeForeignRun = Boolean(configuringNew && activeRun
    && team.members.some((member) => !member.runtime || member.runtime.online || hasInFlightExecution(member.runtime)))
  const relevantPlan = plan && activeRun && plan.startedAt >= activeRun.createdAt
    && plan.items.every((item) => members.some((member) => (
      (member.binding?.channelId ?? member.slot.channelId) === item.channelId
    )))
    ? plan
    : undefined

  useEffect(() => {
    if (!relevantPlan) return
    if (relevantPlan.state === 'running') setError('')
    if (relevantPlan.state === 'done') {
      setError('')
      setNotice('独立会话已全部进入待命。')
    }
  }, [relevantPlan])

  const run = async (action: () => Promise<AgentLaunchPlan>): Promise<void> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await action()
      if (result.state === 'done') {
        setNotice('独立会话已全部进入待命。')
        onOpenSessions()
      } else {
        setError(result.items.find((item) => item.stage === 'failed')?.message ?? '部分独立会话创建失败')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const enableCdp = async (): Promise<void> => {
    if (!onEnableCursorCdp) return
    setBusy(true)
    setError('')
    try {
      const result = await onEnableCursorCdp()
      if (result.ok) setNotice(result.message)
      else setError(result.message)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const chooseWorkspace = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const selection = await onChooseWorkspace()
      if (selection) setChosenWorkspace(selection)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="independent-config" aria-label="独立会话配置">
      <header className="independent-config__intro">
        <span><small>独立模式</small><strong>批量创建常驻 Cursor 会话</strong></span>
        <p>每个会话只处理自己的用户消息，不加入团队任务板，也不会互相分配任务。</p>
      </header>

      <div className="independent-config__workspace">
        <span><small>当前工程</small><strong>{workspace?.name ?? '等待识别 Cursor 工程'}</strong></span>
        <code title={workspace?.path}>{workspace?.path ?? '请先在 Cursor 中打开一个工程'}</code>
        {independentActive ? <em>{members.length} 个独立会话</em> : null}
        {configuringNew ? (
          <button disabled={busy} onClick={() => void chooseWorkspace()}>
            选择工程
          </button>
        ) : null}
      </div>

      {configuringNew ? (
        <div className="independent-config__count">
          <span><strong>会话数量</strong><small>一次创建 1–16 个，后续分别对话</small></span>
          <div>
            <button disabled={busy || count <= 1} onClick={() => setCount((value) => Math.max(1, value - 1))}>−</button>
            <output>{count}</output>
            <button disabled={busy || count >= 16} onClick={() => setCount((value) => Math.min(16, value + 1))}>+</button>
          </div>
        </div>
      ) : (
        <div className="independent-config__status">
          <span><b>{members.filter((member) => isAgentOnDuty(member.runtime)).length}</b> / {members.length} 已待命</span>
          <div>
            <button onClick={onOpenSessions}>打开会话</button>
            <button disabled={currentBlocksReplacement} onClick={() => setReplaceMode(true)}>新建批次</button>
          </div>
        </div>
      )}

      {activeForeignRun ? (
        <p className="independent-config__warning">当前团队仍有在线或执行中的 Agent。结束本轮运行后即可切换到独立会话模式。</p>
      ) : null}
      {!configuringNew && pendingEvidence ? (
        <p className="independent-config__warning">正在确认离线会话的运行状态，确认完成后开放安全重建。</p>
      ) : null}
      {error || notice ? <p className={`independent-config__notice${error ? ' is-error' : ''}`} role="status">{error || notice}</p> : null}

      {(configuringNew || pendingMembers.length > 0) && workspace ? (
        <LobbySessionLaunchTile
          variant="independent"
          pendingChannels={channels}
          cursorModels={cursorModels}
          selections={selections}
          isPrelaunch={configuringNew}
          plan={relevantPlan}
          busy={busy || activeForeignRun || pendingEvidence}
          cdpAutoHealEnabled={cdpAutoHealEnabled}
          cdpAutoHealEvent={cdpAutoHealEvent}
          onLaunch={() => void run(() => configuringNew
            ? onCreate({
                workspacePath: workspace.path,
                sessions: channels.map((channelId) => ({ modelSelection: selections[channelId] }))
              })
            : onLaunch(channels.map((channelId) => ({ channelId, modelSelection: selections[channelId] }))))}
          onModelSave={async (channelId, selection) => {
            if (!configuringNew && onPersistModelSelection) {
              await onPersistModelSelection(channelId, selection)
            }
            setDraftSelections((current) => ({ ...current, [channelId]: structuredClone(selection) }))
          }}
          onEnableCdp={onEnableCursorCdp ? () => void enableCdp() : undefined}
          onToggleAutoHeal={onToggleCdpAutoHeal ? (enabled) => void onToggleCdpAutoHeal(enabled) : undefined}
          onCancelCountdown={onCancelCdpAutoHealCountdown ? () => void onCancelCdpAutoHealCountdown() : undefined}
        />
      ) : !workspace ? (
        <div className="independent-config__empty">Cursor 工程识别完成后即可配置独立会话。</div>
      ) : null}
    </section>
  )
}
