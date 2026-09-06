import { hasInFlightExecution, isAgentOnDuty } from '../../../domain/channel-message'
import type { CursorModelSelection } from '../../../domain/cursor-model'
import type { DetectedCursorWorkspace } from '../../../domain/cursor-workspace'
import {
  workspaceRunMode,
  type TeamControlSnapshot,
  type TeamMemberView,
  type TeamRun,
  type TeamRunStatus,
  type TeamWorkspace,
  type WorkspaceRunMode
} from '../../../domain/team-control'
import {
  teamDashboardPhase,
  teamRuntimePresence,
  unresolvedDashboardGates,
  type TeamDashboardGate,
  type TeamRuntimePresence
} from '../team/team-dashboard-view'

/**
 * 「运行」页视图模型：一个工程同一时刻只有一个活跃 run，要么团队、要么独立批次。
 * 页面直接表达"一个槽位、两种模式"——这里把领域快照折叠成页面需要的少数事实：
 * 当前模式、阶段、席位状态、破坏性操作的后果，组件只负责摆放与交互。
 */
export type RunSeatState = 'waiting' | 'working' | 'offline' | 'unconfirmed'

export interface RunSeat {
  channelId: string
  name: string
  roleName: string
  solo: boolean
  state: RunSeatState
  lastSeenAt?: number
  modelSelection?: CursorModelSelection
  /**
   * 需要（重新）创建 Cursor 会话：离线，或尚无运行证据。执行中的席位即使心跳停刷
   * 也不算——它正在干活，重建会杀掉一个活着的会话。
   */
  pending: boolean
}

export const SEAT_STATE_LABEL: Record<RunSeatState, string> = {
  waiting: '待命中',
  working: '执行中',
  offline: '离线',
  unconfirmed: '待确认'
}

/** 席位运行态归一：与服务端守卫/围栏口径一致（在岗 / 执行租约 / 无证据 / 离线）。 */
export function seatStateOf(member: TeamMemberView): RunSeatState {
  const runtime = member.runtime
  if (!runtime) return 'unconfirmed'
  if (isAgentOnDuty(runtime) && runtime.waiting) return 'waiting'
  if (runtime.online || hasInFlightExecution(runtime)) return 'working'
  return 'offline'
}

export function runSeatOf(member: TeamMemberView): RunSeat {
  const state = seatStateOf(member)
  return {
    channelId: member.binding?.channelId ?? member.slot.channelId ?? '?',
    name: member.slot.name,
    roleName: member.role.name,
    solo: member.slot.solo === true,
    state,
    lastSeenAt: member.runtime?.lastSeenAt,
    modelSelection: member.slot.modelSelection,
    pending: state === 'offline' || state === 'unconfirmed'
  }
}

/** 页面阶段：无运行 → 启动前 → 启动中 → 执行 → 暂停 → 已结束。 */
export type RunPhase = 'none' | 'prelaunch' | 'launching' | 'active' | 'paused' | 'completed'

export interface RunStateChip {
  label: string
  tone: 'neutral' | 'progress' | 'active' | 'warning' | 'muted'
  hint?: string
}

export interface RunView {
  workspace?: TeamWorkspace
  run?: TeamRun
  mode?: WorkspaceRunMode
  phase: RunPhase
  /** 团队模式的运行时在场判定（在线 / 长任务待确认 / 全部离线）；独立模式无此概念。 */
  presence?: TeamRuntimePresence
  seats: RunSeat[]
  /** 仍在线 / 执行中 / 尚无运行证据的席位数：破坏性操作前的软守卫依据。 */
  liveSeatCount: number
  /** 未待命席位：会话创建区的对象。 */
  pendingSeats: RunSeat[]
  /** 有席位尚无运行证据：先确认它是否只是还没调用工具，再开放安全重建。 */
  evidencePending: boolean
  gates: TeamDashboardGate[]
  state: RunStateChip
  /** Cursor 当前打开的工程与运行所属工程不一致。 */
  cursorWorkspaceChanged: boolean
}

const RUN_STATUS_LABEL: Record<TeamRunStatus, string> = {
  draft: '待配置',
  ready: '可启动',
  launching: '启动中',
  running: '运行中',
  attention: '需处理',
  paused: '已暂停',
  completed: '已结束'
}

function phaseOf(run?: TeamRun): RunPhase {
  if (!run) return 'none'
  return teamDashboardPhase(run.status)
}

function teamStateChip(run: TeamRun, phase: RunPhase, presence: TeamRuntimePresence, seats: RunSeat[]): RunStateChip {
  if (phase === 'completed') return { label: '本轮已结束', tone: 'muted', hint: '可以开始新一轮，或切换到独立模式' }
  if (phase === 'paused') return { label: '已暂停', tone: 'warning', hint: '可在会话侧继续推进' }
  if (phase === 'launching') return { label: '启动确认中', tone: 'progress', hint: '等待各席位 team_check_in 回执' }
  if (phase === 'active') {
    if (presence === 'online') {
      return run.status === 'attention'
        ? { label: '团队需处理', tone: 'warning' }
        : { label: '协作执行中', tone: 'active' }
    }
    return presence === 'in_flight_unverified'
      ? { label: '长任务中 · 连接待确认', tone: 'progress', hint: 'Agent 上次处于执行阶段；等待 Cursor 恢复连接或明确停止证据' }
      : { label: '全部 Agent 离线', tone: 'warning', hint: '当前没有在线 Agent；可重新创建会话，恢复后自动接管' }
  }
  const waiting = seats.filter((seat) => seat.state === 'waiting').length
  return {
    label: seats.length ? `待命 ${waiting}/${seats.length}` : RUN_STATUS_LABEL[run.status],
    tone: waiting === seats.length && seats.length > 0 ? 'active' : 'neutral'
  }
}

function independentStateChip(run: TeamRun, seats: RunSeat[]): RunStateChip {
  if (run.status === 'completed') return { label: '批次已结束', tone: 'muted', hint: '旧会话下一次轮询会收到结束指令并自行退出' }
  const waiting = seats.filter((seat) => seat.state === 'waiting').length
  const working = seats.filter((seat) => seat.state === 'working').length
  if (!seats.length) return { label: '空批次', tone: 'neutral' }
  if (waiting + working === 0) return { label: '全部离线', tone: 'warning' }
  return {
    label: working ? `待命 ${waiting} · 执行中 ${working}` : `待命 ${waiting}/${seats.length}`,
    tone: waiting + working === seats.length ? 'active' : 'neutral'
  }
}

export function buildRunView(team: TeamControlSnapshot, detected?: DetectedCursorWorkspace): RunView {
  const run = team.activeRun
  const workspace = team.workspaces.find((candidate) => candidate.id === team.activeWorkspaceId)
  const mode = run ? workspaceRunMode(run) : undefined
  const phase = phaseOf(run)
  const members = mode === 'independent'
    ? team.members.filter((member) => member.slot.solo === true)
    : mode === 'team'
      ? team.members.filter((member) => member.slot.solo !== true)
      : []
  const seats = members.map(runSeatOf)
  const liveSeatCount = phase === 'completed'
    ? 0
    : seats.filter((seat) => seat.state !== 'offline').length
  const presence = mode === 'team' ? teamRuntimePresence(team) : undefined
  const state: RunStateChip = !run
    ? { label: '尚未开始运行', tone: 'neutral' }
    : mode === 'independent'
      ? independentStateChip(run, seats)
      : teamStateChip(run, phase, presence ?? 'offline', seats)
  return {
    workspace,
    run,
    mode,
    phase,
    presence,
    seats,
    liveSeatCount,
    pendingSeats: phase === 'completed' ? [] : seats.filter((seat) => seat.pending),
    evidencePending: phase !== 'completed' && seats.some((seat) => seat.state === 'unconfirmed'),
    gates: mode === 'team' ? unresolvedDashboardGates(team) : [],
    state,
    cursorWorkspaceChanged: Boolean(detected && workspace && detected.id !== workspace.id)
  }
}

/**
 * 破坏性动作的统一后果说明。结束、切换模式、新建批次、新一轮，全部走同一段文案模板
 * 与同一个守卫（仍有 live 席位才要确认），不再各处各写一套。
 */
export type ReplaceRunAction =
  | { kind: 'end' }
  | { kind: 'switch'; to: WorkspaceRunMode }
  | { kind: 'new-batch'; targetWorkspaceName?: string }
  | { kind: 'new-round' }

export interface ReplaceRunConsequence {
  title: string
  body: string
  confirmLabel: string
  needsConfirm: boolean
}

const FENCE_NOTE = '它们会在下一次轮询（最长 60 秒）收到结束指令并自行退出；尚未取走的排队消息将归档，不会误送进新的运行。'

export function replaceRunConsequence(view: RunView, action: ReplaceRunAction): ReplaceRunConsequence {
  const live = view.liveSeatCount
  const modeLabel = view.mode === 'independent' ? '独立批次' : '团队运行'
  const liveClause = live > 0 ? `${live} 个会话仍在线或待确认。` : '所有会话已离线。'
  switch (action.kind) {
    case 'end':
      return {
        title: `结束当前${modeLabel}`,
        body: `${liveClause}${live > 0 ? FENCE_NOTE : '结束后可以直接开始新的运行。'}`,
        confirmLabel: '确认结束',
        needsConfirm: live > 0
      }
    case 'switch': {
      const target = action.to === 'team' ? '团队模式' : '独立模式'
      return {
        title: `切换到${target}`,
        body: `${liveClause}切换会结束当前${modeLabel}${live > 0 ? `，${FENCE_NOTE}` : '。'}${action.to === 'team' ? '随后进入组队流程。' : '随后配置独立批次。'}`,
        confirmLabel: '确认切换',
        needsConfirm: live > 0
      }
    }
    case 'new-batch':
      return {
        title: action.targetWorkspaceName ? `在「${action.targetWorkspaceName}」新建批次` : '新建独立批次',
        body: `${liveClause}当前批次会结束${live > 0 ? `，${FENCE_NOTE}` : '。'}`,
        confirmLabel: '确认新建',
        needsConfirm: live > 0
      }
    case 'new-round':
      return {
        title: '结束本轮并开始新一轮',
        body: `${liveClause}本轮团队运行会结束${live > 0 ? `，${FENCE_NOTE}` : '，新一轮沿用同一套角色与席位。'}`,
        confirmLabel: '确认新一轮',
        needsConfirm: live > 0
      }
  }
}

/** 团队流程四步（目标 → 启动 → 待命 → 执行）的进度状态。 */
export interface RunFlowStep {
  label: string
  state: 'done' | 'current' | 'todo'
}

export function teamFlowSteps(view: RunView): RunFlowStep[] {
  const run = view.run
  if (!run) return []
  const launched = view.phase !== 'prelaunch'
  const completed = view.phase === 'completed'
  const goalDefined = Boolean(run.goal.trim())
  const allWaiting = view.seats.length > 0 && view.seats.every((seat) => seat.state === 'waiting' || seat.state === 'working')
  return [
    { label: '团队目标', state: goalDefined ? 'done' : 'current' },
    { label: '启动团队', state: launched ? 'done' : goalDefined ? 'current' : 'todo' },
    { label: 'Agent 待命', state: completed || allWaiting ? 'done' : launched ? 'current' : 'todo' },
    { label: '协作执行', state: completed ? 'done' : launched && allWaiting ? 'current' : 'todo' }
  ]
}

/** 团队模式主按钮：由 preflight 与阶段决定，与页签无关。 */
export interface TeamPrimaryAction {
  kind: 'fill-goal' | 'install-mcp' | 'launch' | 'check-standby' | 'new-round' | 'none'
  label: string
  hint: string
}

export function teamPrimaryAction(team: TeamControlSnapshot, view: RunView): TeamPrimaryAction {
  const run = view.run
  if (!run) return { kind: 'none', label: '', hint: '' }
  if (view.phase === 'completed') return { kind: 'new-round', label: '开始新一轮', hint: '本轮已结束，沿用同一套角色与席位再来一轮' }
  if (view.phase !== 'prelaunch') return { kind: 'none', label: '', hint: view.state.hint ?? '' }
  if (!run.goal.trim()) return { kind: 'fill-goal', label: '填写团队目标', hint: '一句话说清要做什么，团队才能开跑' }
  if (team.preflight.canLaunch) return { kind: 'launch', label: '启动团队', hint: '全部就绪，一键开跑' }
  if (!team.preflight.mcpInstalled) return { kind: 'install-mcp', label: '接入团队 MCP', hint: '为本轮席位登记 SG Team 通道身份，无需重载 Cursor' }
  return { kind: 'check-standby', label: '检查待命状态', hint: team.preflight.blockers[0] ?? '检测各通道待命状态，自动接管手动发起的会话' }
}
