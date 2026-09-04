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
  /** 显式结束当前独立批次。 */
  onEndRun: () => Promise<void>
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
  onEndRun,
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
  /** 软守卫确认：replace = 新建批次替换当前批次；end = 结束批次；create = 替换活跃团队 run。 */
  const [confirming, setConfirming] = useState<'replace' | 'end' | 'create' | null>(null)
  const activeRun = team.activeRun
  const independentActive = workspaceRunMode(activeRun) === 'independent'
  const configuringNew = !independentActive || replaceMode
  const activeWorkspace = team.workspaces.find((workspace) => workspace.id === team.activeWorkspaceId)
  const workspace = independentActive ? activeWorkspace : chosenWorkspace ?? detectedWorkspace ?? activeWorkspace
  const members = independentActive ? team.members.filter((member) => member.slot.solo === true) : []
  const pendingMembers = members.filter((member) => !isAgentOnDuty(member.runtime))
  const pendingEvidence = pendingMembers.some((member) => !member.runtime)
  /** 在线 / 执行中 / 尚无运行时证据的会话数：软守卫据此决定是否需要一次确认。 */
  const liveMemberCount = members.filter((member) => (
    !member.runtime || member.runtime.online || hasInFlightExecution(member.runtime)
  )).length
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
  // 仅针对「外来」的团队 run：独立批次替换自身（replaceMode）已在进入配置前确认过，不重复守卫。
  const activeForeignRun = Boolean(configuringNew && activeRun
    && workspaceRunMode(activeRun) !== 'independent'
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

  const launchSessions = (): void => {
    if (!workspace) return
    void run(() => configuringNew
      ? onCreate({
          workspacePath: workspace.path,
          sessions: channels.map((channelId) => ({ modelSelection: selections[channelId] }))
        })
      : onLaunch(channels.map((channelId) => ({ channelId, modelSelection: selections[channelId] }))))
  }

  const endRun = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await onEndRun()
      setReplaceMode(false)
      setNotice('独立批次已结束；旧会话会在下一次轮询自行退出。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  /** 软守卫：有仍在线/待确认的会话时先确认一次，全部离线则直接执行。 */
  const performGuarded = (action: 'replace' | 'end' | 'create'): void => {
    setConfirming(null)
    if (action === 'replace') setReplaceMode(true)
    else if (action === 'end') void endRun()
    else launchSessions()
  }
  const requestGuarded = (action: 'replace' | 'end' | 'create'): void => {
    const needsConfirm = action === 'create' ? activeForeignRun : liveMemberCount > 0
    if (needsConfirm) setConfirming(action)
    else performGuarded(action)
  }

  const confirmText = confirming === 'replace'
    ? `确认新建批次？${liveMemberCount} 个会话仍在线或待确认，它们会在下一次轮询（最长 60 秒）收到结束指令并自行退出；尚未取走的排队消息将归档。`
    : confirming === 'end'
      ? `确认结束独立批次？${liveMemberCount} 个会话将收到结束指令并自行退出；尚未取走的排队消息将归档。`
      : '当前团队运行仍有在线或执行中的 Agent。创建独立批次会结束该团队运行，旧会话在下一次轮询收到结束指令并自行退出。确认继续？'

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
            <button disabled={busy} onClick={() => requestGuarded('end')}>结束批次</button>
            <button disabled={busy} onClick={() => requestGuarded('replace')}>新建批次</button>
          </div>
        </div>
      )}

      {activeForeignRun ? (
        <p className="independent-config__warning">当前团队运行仍有在线或执行中的 Agent；创建独立批次会结束该团队运行（点击创建时需确认一次）。</p>
      ) : null}
      {!configuringNew && pendingEvidence ? (
        <p className="independent-config__warning">正在确认离线会话的运行状态，确认完成后开放安全重建。</p>
      ) : null}
      {error || notice ? <p className={`independent-config__notice${error ? ' is-error' : ''}`} role="status">{error || notice}</p> : null}

      {confirming ? (
        <div className="independent-config__confirm" role="alertdialog" aria-label="确认操作">
          <p>{confirmText}</p>
          <div>
            <button className="is-secondary" disabled={busy} onClick={() => setConfirming(null)}>取消</button>
            <button className="is-danger" disabled={busy} onClick={() => performGuarded(confirming)}>
              {confirming === 'replace' ? '确认新建' : confirming === 'end' ? '确认结束' : '确认创建'}
            </button>
          </div>
        </div>
      ) : null}

      {(configuringNew || pendingMembers.length > 0) && workspace ? (
        <LobbySessionLaunchTile
          variant="independent"
          pendingChannels={channels}
          cursorModels={cursorModels}
          selections={selections}
          isPrelaunch={configuringNew}
          plan={relevantPlan}
          busy={busy || pendingEvidence}
          cdpAutoHealEnabled={cdpAutoHealEnabled}
          cdpAutoHealEvent={cdpAutoHealEvent}
          onLaunch={() => requestGuarded('create')}
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
