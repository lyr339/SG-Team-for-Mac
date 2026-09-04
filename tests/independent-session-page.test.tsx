// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamControlSnapshot, TeamMemberView } from '../src/domain/team-control'
import { IndependentSessionPage } from '../src/renderer/src/lobby/IndependentSessionPage'
import { desktopSnapshot, teamControlSnapshot } from '../src/renderer/src/preview/mock-data'

const donePlan = { id: 'plan:test', state: 'done' as const, items: [], startedAt: 1, finishedAt: 2 }

/** 独立批次快照：全部独立席位，按 online 决定在岗与否。 */
function independentTeam(options: { online: boolean; seats?: number }): TeamControlSnapshot {
  const snapshot = structuredClone(teamControlSnapshot)
  const solo = snapshot.members.find((member) => member.slot.solo === true)!
  snapshot.activeRun = { ...snapshot.activeRun!, templateId: 'independent-session-v1', status: 'running' }
  snapshot.members = Array.from({ length: options.seats ?? 2 }, (_, index): TeamMemberView => {
    const channelId = String(index + 1)
    return {
      ...solo,
      slot: { ...solo.slot, id: `slot:solo-${channelId}`, name: `独立席 ${channelId}`, channelId },
      binding: solo.binding ? { ...solo.binding, channelId } : undefined,
      runtime: {
        channelId, queueDepth: 0, healthEvidence: [], workingFiles: [], lastSeenAt: Date.now() - 3_000,
        status: options.online ? 'waiting' : 'offline', online: options.online, waiting: options.online,
        connectionPhase: options.online ? 'waiting' : 'offline'
      }
    }
  })
  return snapshot
}

/** 团队 run（外来）快照：成员在岗 / 全部离线。 */
function teamRun(options: { online: boolean }): TeamControlSnapshot {
  const snapshot = structuredClone(teamControlSnapshot)
  snapshot.members = snapshot.members.map((member) => ({
    ...member,
    runtime: member.runtime
      ? { ...member.runtime, online: options.online, waiting: options.online, status: options.online ? 'waiting' : 'offline', connectionPhase: options.online ? 'waiting' : 'offline' }
      : { channelId: member.slot.channelId ?? '9', queueDepth: 0, healthEvidence: [], workingFiles: [], status: 'offline', online: false, waiting: false, connectionPhase: 'offline' }
  }))
  return snapshot
}

describe('IndependentSessionPage 软守卫（结束批次 / 新建批次 / 替换团队 run）', () => {
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
    if (!button) throw new Error(`button "${label}" not found in: ${[...container.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`)
    return button
  }
  const dialog = () => container.querySelector('[role="alertdialog"]')

  const render = async (team: TeamControlSnapshot) => {
    const onEndRun = vi.fn(async () => {})
    const onCreate = vi.fn(async () => donePlan)
    const onLaunch = vi.fn(async () => donePlan)
    const onOpenSessions = vi.fn()
    await act(async () => root.render(
      <IndependentSessionPage
        team={team}
        detectedWorkspace={{ id: 'wedge-demo', name: 'wedge-demo', path: '/workspace/wedge-demo', channelIds: [] }}
        cursorModels={desktopSnapshot.cursorModels ?? []}
        cdpAutoHealEnabled={false}
        onCreate={onCreate}
        onChooseWorkspace={async () => undefined}
        onEndRun={onEndRun}
        onLaunch={onLaunch}
        onOpenSessions={onOpenSessions}
      />
    ))
    return { onEndRun, onCreate, onLaunch, onOpenSessions }
  }

  it('confirms before ending a batch with live sessions, then reports the fence consequence', async () => {
    const { onEndRun } = await render(independentTeam({ online: true }))
    expect(container.textContent).toContain('2 / 2 已待命')
    await act(async () => buttonNamed('结束批次').click())
    expect(onEndRun).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('确认结束独立批次？2 个会话将收到结束指令并自行退出')
    await act(async () => buttonNamed('确认结束').click())
    expect(onEndRun).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('独立批次已结束；旧会话会在下一次轮询自行退出。')
  })

  it('ends an all-offline batch immediately and surfaces onEndRun failures inline', async () => {
    const onEndRun = vi.fn(async () => { throw new Error('运行状态已变化，请刷新后重试') })
    await act(async () => root.render(
      <IndependentSessionPage
        team={independentTeam({ online: false })}
        cursorModels={[]}
        cdpAutoHealEnabled={false}
        onCreate={async () => donePlan}
        onChooseWorkspace={async () => undefined}
        onEndRun={onEndRun}
        onLaunch={async () => donePlan}
        onOpenSessions={() => {}}
      />
    ))
    await act(async () => buttonNamed('结束批次').click())
    expect(dialog()).toBeNull()
    expect(onEndRun).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="status"]')?.className).toContain('is-error')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('运行状态已变化')
  })

  it('guards "新建批次" once while sessions are live; cancel keeps the status view, confirm opens the configurator', async () => {
    await render(independentTeam({ online: true }))
    expect(container.textContent).not.toContain('会话数量')
    await act(async () => buttonNamed('新建批次').click())
    expect(dialog()?.textContent).toContain('确认新建批次？2 个会话仍在线或待确认')
    await act(async () => buttonNamed('取消').click())
    expect(dialog()).toBeNull()
    expect(container.textContent).not.toContain('会话数量')

    await act(async () => buttonNamed('新建批次').click())
    await act(async () => buttonNamed('确认新建').click())
    expect(dialog()).toBeNull()
    expect(container.textContent).toContain('会话数量')
    // 替换自身批次已确认过：创建时不再二次守卫。
    expect(container.textContent).not.toContain('当前团队运行仍有在线或执行中的 Agent')
  })

  it('confirms before replacing a live team run with an independent batch, then creates it', async () => {
    const { onCreate } = await render(teamRun({ online: true }))
    expect(container.textContent).toContain('创建独立批次会结束该团队运行（点击创建时需确认一次）')
    expect(buttonNamed('批量创建独立会话（3）').disabled).toBe(false)
    await act(async () => buttonNamed('批量创建独立会话（3）').click())
    expect(onCreate).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('创建独立批次会结束该团队运行')
    await act(async () => buttonNamed('确认创建').click())
    expect(onCreate).toHaveBeenCalledTimes(1)
    // 非独立模式下以 Cursor 当前识别到的工程为准（detectedWorkspace 优先于旧 run 的 workspace）。
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ workspacePath: '/workspace/wedge-demo' })
    expect((onCreate.mock.calls[0]?.[0] as { sessions: unknown[] }).sessions).toHaveLength(3)
  })

  it('creates directly over a team run whose agents are all offline', async () => {
    const { onCreate } = await render(teamRun({ online: false }))
    expect(container.textContent).not.toContain('点击创建时需确认一次')
    await act(async () => buttonNamed('批量创建独立会话（3）').click())
    expect(dialog()).toBeNull()
    expect(onCreate).toHaveBeenCalledTimes(1)
  })
})
