import { describe, expect, it } from 'vitest'
import type { TeamControlSnapshot, TeamMemberRuntime, TeamMemberView, TeamRunStatus } from '../src/domain/team-control'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import {
  buildRunView,
  replaceRunConsequence,
  seatStateOf,
  teamFlowSteps,
  teamPrimaryAction
} from '../src/renderer/src/run/run-view'
import { teamControlSnapshot } from '../src/renderer/src/preview/mock-data'

type SeatShape = 'waiting' | 'working' | 'offline' | 'unconfirmed'

function runtimeOf(shape: SeatShape, channelId: string): TeamMemberRuntime | undefined {
  if (shape === 'unconfirmed') return undefined
  const base = { channelId, queueDepth: 0, lastSeenAt: Date.now() - 5_000, healthEvidence: [], workingFiles: [] }
  if (shape === 'waiting') return { ...base, status: 'waiting', online: true, waiting: true, connectionPhase: 'waiting' }
  // 执行租约：已取走消息、长任务期间心跳停刷（online=false）仍算在岗执行中。
  if (shape === 'working') return { ...base, status: 'running', online: false, waiting: false, connectionPhase: 'processing' }
  return { ...base, status: 'offline', online: false, waiting: false, connectionPhase: 'offline' }
}

/** 独立批次快照：按形态给每个独立席位一个运行态。 */
function independentTeam(shapes: SeatShape[], status: TeamRunStatus = 'running'): TeamControlSnapshot {
  const snapshot = structuredClone(teamControlSnapshot)
  const solo = snapshot.members.find((member) => member.slot.solo === true)!
  snapshot.activeRun = { ...snapshot.activeRun!, templateId: 'independent-session-v1', status }
  snapshot.members = shapes.map((shape, index): TeamMemberView => {
    const channelId = String(index + 1)
    return {
      ...solo,
      slot: { ...solo.slot, id: `slot:solo-${channelId}`, name: `独立席 ${channelId}`, channelId },
      binding: solo.binding ? { ...solo.binding, channelId } : undefined,
      runtime: runtimeOf(shape, channelId)
    }
  })
  return snapshot
}

/** 团队快照：所有团队席位按同一形态。 */
function teamRun(shape: SeatShape, status: TeamRunStatus = 'running'): TeamControlSnapshot {
  const snapshot = structuredClone(teamControlSnapshot)
  snapshot.activeRun = { ...snapshot.activeRun!, status }
  snapshot.members = snapshot.members.map((member) => ({
    ...member,
    runtime: runtimeOf(shape, member.slot.channelId ?? '9')
  }))
  return snapshot
}

describe('run view · seats', () => {
  it('maps runtime evidence to waiting / working / offline / unconfirmed like the server guard', () => {
    const team = independentTeam(['waiting', 'working', 'offline', 'unconfirmed'])
    expect(team.members.map(seatStateOf)).toEqual(['waiting', 'working', 'offline', 'unconfirmed'])
    const view = buildRunView(team)
    expect(view.mode).toBe('independent')
    // 执行中的席位不算待重建：它在干活，只是长任务期间心跳停刷。
    expect(view.seats.map((seat) => [seat.channelId, seat.state, seat.pending])).toEqual([
      ['1', 'waiting', false],
      ['2', 'working', false],
      ['3', 'offline', true],
      ['4', 'unconfirmed', true]
    ])
    // 软守卫口径：在线 / 执行中 / 尚无证据 都算 live；离线不算。
    expect(view.liveSeatCount).toBe(3)
    expect(view.evidencePending).toBe(true)
    expect(view.state).toMatchObject({ label: '待命 1 · 执行中 1' })
  })

  it('shows only the seats of the active mode: team seats hide the solo seat and vice versa', () => {
    const team = buildRunView(teamControlSnapshot)
    expect(team.mode).toBe('team')
    expect(team.seats.every((seat) => !seat.solo)).toBe(true)
    expect(team.seats).toHaveLength(teamControlSnapshot.members.filter((member) => member.slot.solo !== true).length)
    const independent = buildRunView(independentTeam(['waiting']))
    expect(independent.seats.every((seat) => seat.solo)).toBe(true)
  })

  it('an ended run has no live seats and nothing pending to create', () => {
    const view = buildRunView(independentTeam(['waiting', 'unconfirmed'], 'completed'))
    expect(view.phase).toBe('completed')
    expect(view.liveSeatCount).toBe(0)
    expect(view.pendingSeats).toEqual([])
    expect(view.state).toMatchObject({ label: '批次已结束', tone: 'muted' })
  })

  it('has no run, no mode and no seats before the first run', () => {
    const view = buildRunView(emptyTeamControlSnapshot())
    expect(view).toMatchObject({ phase: 'none', mode: undefined, seats: [], liveSeatCount: 0 })
    expect(view.state.label).toBe('尚未开始运行')
  })

  it('flags a Cursor workspace switch relative to the run workspace', () => {
    expect(buildRunView(teamControlSnapshot, { id: 'wedge-demo', name: 'wedge-demo', path: '/x' }).cursorWorkspaceChanged).toBe(false)
    expect(buildRunView(teamControlSnapshot, { id: 'other', name: '新工程', path: '/y' }).cursorWorkspaceChanged).toBe(true)
  })
})

describe('run view · team state chip and primary action', () => {
  it('reads the phase from the run status and presence from the seats', () => {
    expect(buildRunView(teamRun('waiting', 'running')).state).toMatchObject({ label: '协作执行中', tone: 'active' })
    expect(buildRunView(teamRun('offline', 'running')).state).toMatchObject({ label: '全部 Agent 离线', tone: 'warning' })
    expect(buildRunView(teamRun('working', 'running')).state.label).toBe('长任务中 · 连接待确认')
    expect(buildRunView(teamRun('waiting', 'attention')).state.label).toBe('团队需处理')
    expect(buildRunView(teamRun('waiting', 'launching')).state).toMatchObject({ label: '启动确认中', tone: 'progress' })
    expect(buildRunView(teamRun('offline', 'completed')).state).toMatchObject({ label: '本轮已结束', tone: 'muted' })
    expect(buildRunView(teamRun('waiting', 'ready')).state.label).toBe('待命 2/2')
  })

  it('derives the primary action from preflight, not from which page is open', () => {
    const draft = teamRun('waiting', 'draft')
    draft.activeRun!.goal = ''
    expect(teamPrimaryAction(draft, buildRunView(draft)).kind).toBe('fill-goal')

    const needsMcp = teamRun('waiting', 'ready')
    needsMcp.preflight = { ...needsMcp.preflight, canLaunch: false, mcpInstalled: false }
    expect(teamPrimaryAction(needsMcp, buildRunView(needsMcp))).toMatchObject({ kind: 'install-mcp', label: '接入团队 MCP' })

    const ready = teamRun('waiting', 'ready')
    ready.preflight = { ...ready.preflight, canLaunch: true, mcpInstalled: true }
    expect(teamPrimaryAction(ready, buildRunView(ready))).toMatchObject({ kind: 'launch', label: '启动团队' })

    const notWaiting = teamRun('offline', 'ready')
    notWaiting.preflight = { ...notWaiting.preflight, canLaunch: false, mcpInstalled: true, blockers: ['并非所有 Agent 通道都已在线待命'] }
    expect(teamPrimaryAction(notWaiting, buildRunView(notWaiting))).toMatchObject({ kind: 'check-standby', hint: '并非所有 Agent 通道都已在线待命' })

    const completed = teamRun('offline', 'completed')
    expect(teamPrimaryAction(completed, buildRunView(completed))).toMatchObject({ kind: 'new-round', label: '开始新一轮' })
    expect(teamPrimaryAction(teamRun('waiting', 'running'), buildRunView(teamRun('waiting', 'running'))).kind).toBe('none')
  })

  it('walks the four flow steps', () => {
    const running = teamRun('waiting', 'running')
    expect(teamFlowSteps(buildRunView(running)).map((step) => step.state)).toEqual(['done', 'done', 'done', 'current'])
    const draft = teamRun('offline', 'draft')
    draft.activeRun!.goal = ''
    expect(teamFlowSteps(buildRunView(draft)).map((step) => step.state)).toEqual(['current', 'todo', 'todo', 'todo'])
    expect(teamFlowSteps(buildRunView(teamRun('offline', 'completed'))).map((step) => step.state)).toEqual(['done', 'done', 'done', 'done'])
  })
})

describe('run view · one consequence template for every destructive action', () => {
  it('asks for confirmation only while seats are live, and always states the fence consequence', () => {
    const live = buildRunView(independentTeam(['waiting', 'working', 'unconfirmed', 'offline']))
    const end = replaceRunConsequence(live, { kind: 'end' })
    expect(end).toMatchObject({ title: '结束当前独立批次', confirmLabel: '确认结束', needsConfirm: true })
    expect(end.body).toContain('3 个会话仍在线或待确认')
    expect(end.body).toContain('下一次轮询（最长 60 秒）收到结束指令并自行退出')
    expect(end.body).toContain('尚未取走的排队消息将归档')

    const offline = buildRunView(independentTeam(['offline', 'offline']))
    expect(replaceRunConsequence(offline, { kind: 'end' })).toMatchObject({ needsConfirm: false })
    expect(replaceRunConsequence(offline, { kind: 'switch', to: 'team' }).body).toContain('所有会话已离线')
  })

  it('describes mode switches and new batches in terms of the current run', () => {
    const team = buildRunView(teamRun('waiting', 'running'))
    const toIndependent = replaceRunConsequence(team, { kind: 'switch', to: 'independent' })
    expect(toIndependent.title).toBe('切换到独立模式')
    expect(toIndependent.body).toContain('切换会结束当前团队运行')
    expect(toIndependent.body).toContain('随后配置独立批次')
    expect(toIndependent.needsConfirm).toBe(true)

    const independent = buildRunView(independentTeam(['waiting']))
    expect(replaceRunConsequence(independent, { kind: 'switch', to: 'team' }).body).toContain('随后进入组队流程')
    expect(replaceRunConsequence(independent, { kind: 'new-batch', targetWorkspaceName: '新工程 B' }).title).toBe('在「新工程 B」新建批次')
    expect(replaceRunConsequence(team, { kind: 'new-round' })).toMatchObject({ title: '结束本轮并开始新一轮', confirmLabel: '确认新一轮' })
  })

  it('never asks for confirmation once the run has ended', () => {
    const ended = buildRunView(independentTeam(['waiting', 'waiting'], 'completed'))
    expect(replaceRunConsequence(ended, { kind: 'switch', to: 'team' }).needsConfirm).toBe(false)
    expect(replaceRunConsequence(ended, { kind: 'new-batch' }).needsConfirm).toBe(false)
  })
})
