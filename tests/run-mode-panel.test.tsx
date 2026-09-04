// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamControlSnapshot, TeamMemberRuntime, TeamMemberView, TeamRunStatus } from '../src/domain/team-control'
import { RunModePanel, runModeSeatOf } from '../src/renderer/src/lobby/RunModePanel'
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

/** 独立批次快照：按形态给每个独立席位一个运行态（团队席位一律剔除，面板只看独立席）。 */
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

describe('runModeSeatOf（席位运行态归一）', () => {
  it('maps runtime evidence to waiting / working / offline / unconfirmed like the server guard', () => {
    const team = independentTeam(['waiting', 'working', 'offline', 'unconfirmed'])
    expect(team.members.map((member) => runModeSeatOf(member).state)).toEqual(['waiting', 'working', 'offline', 'unconfirmed'])
    expect(runModeSeatOf(team.members[0]!)).toMatchObject({ channelId: '1', name: '独立席 1' })
  })
})

describe('RunModePanel（独立模式面板：围栏软守卫交互）', () => {
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

  const buttonNamed = (label: string): HTMLButtonElement => {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === label)
    if (!button) throw new Error(`button "${label}" not found`)
    return button
  }

  const render = async (team: TeamControlSnapshot, handlers: Partial<Parameters<typeof RunModePanel>[0]> = {}) => {
    const onSwitchToTeam = vi.fn(async () => {})
    const onEndRun = vi.fn(async () => {})
    const onViewSessions = vi.fn()
    await act(async () => root.render(
      <RunModePanel team={team} busy={false} onViewSessions={onViewSessions} onSwitchToTeam={onSwitchToTeam} onEndRun={onEndRun} {...handlers} />
    ))
    return { onSwitchToTeam, onEndRun, onViewSessions }
  }

  it('switches immediately when every independent session is offline (no confirm step)', async () => {
    const { onSwitchToTeam, onEndRun } = await render(independentTeam(['offline', 'offline']))
    expect(container.textContent).toContain('所有独立会话已离线，可以直接切换。')
    await act(async () => buttonNamed('切换为团队模式').click())
    expect(onSwitchToTeam).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    await act(async () => buttonNamed('结束独立批次').click())
    expect(onEndRun).toHaveBeenCalledTimes(1)
  })

  it('asks once before switching while sessions are live, and cancel keeps everything running', async () => {
    const { onSwitchToTeam } = await render(independentTeam(['waiting', 'working', 'unconfirmed', 'offline']))
    expect(container.textContent).toContain('3 个会话仍在线或待确认')
    expect(container.querySelector('.run-mode-panel__consequence')?.className).toContain('is-warning')

    await act(async () => buttonNamed('切换为团队模式').click())
    expect(onSwitchToTeam).not.toHaveBeenCalled()
    const dialog = container.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('确认切换为团队模式？3 个独立会话将被结束')

    await act(async () => buttonNamed('取消').click())
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(onSwitchToTeam).not.toHaveBeenCalled()

    await act(async () => buttonNamed('切换为团队模式').click())
    await act(async () => buttonNamed('确认切换').click())
    expect(onSwitchToTeam).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('confirms ending a live batch and never triggers the other action', async () => {
    const { onSwitchToTeam, onEndRun } = await render(independentTeam(['waiting']))
    await act(async () => buttonNamed('结束独立批次').click())
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('确认结束独立批次？1 个独立会话将被结束')
    await act(async () => buttonNamed('确认结束').click())
    expect(onEndRun).toHaveBeenCalledTimes(1)
    expect(onSwitchToTeam).not.toHaveBeenCalled()
  })

  it('shows the ended state: end is disabled, switch is immediate, and seat evidence is still listed', async () => {
    const { onSwitchToTeam } = await render(independentTeam(['waiting'], 'completed'))
    expect(container.textContent).toContain('独立批次 · 已结束')
    expect(buttonNamed('结束独立批次').disabled).toBe(true)
    await act(async () => buttonNamed('切换为团队模式').click())
    expect(onSwitchToTeam).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('renders per-seat state labels and routes "查看独立会话" to the sessions section', async () => {
    const { onViewSessions } = await render(independentTeam(['waiting', 'working', 'offline', 'unconfirmed']))
    const seats = [...container.querySelectorAll<HTMLElement>('.run-mode-panel__seats li')]
    expect(seats.map((seat) => seat.className)).toEqual(['is-waiting', 'is-working', 'is-offline', 'is-unconfirmed'])
    expect(seats.map((seat) => seat.querySelector('em')?.textContent)).toEqual(['待命中', '执行中', '离线', '待确认'])
    expect(seats[3]?.textContent).toContain('尚无工具调用证据')
    expect(container.textContent).toContain('4 席 · 待命 1 · 执行中 1 · 待确认 1 · 离线 1')
    await act(async () => buttonNamed('查看独立会话').click())
    expect(onViewSessions).toHaveBeenCalledTimes(1)
  })

  it('disables every action while busy and surfaces the error text', async () => {
    await render(independentTeam(['offline']), { busy: true, error: '结束失败：运行状态已变化' })
    for (const label of ['查看独立会话', '结束独立批次']) expect(buttonNamed(label).disabled).toBe(true)
    expect(buttonNamed('处理中…').disabled).toBe(true)
    expect(container.querySelector('.run-mode-panel__error')?.textContent).toBe('结束失败：运行状态已变化')
  })
})
