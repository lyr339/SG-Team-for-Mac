import { describe, expect, it } from 'vitest'
import type { TeamControlSnapshot, TeamRunStatus } from '../src/domain/team-control'
import { teamDashboardPhase, teamRuntimePresence, unresolvedDashboardGates } from '../src/renderer/src/team/team-dashboard-view'
import { teamControlSnapshot } from '../src/renderer/src/preview/mock-data'

function snapshot(status: TeamRunStatus): TeamControlSnapshot {
  return {
    ...structuredClone(teamControlSnapshot),
    activeRun: teamControlSnapshot.activeRun
      ? { ...teamControlSnapshot.activeRun, status }
      : undefined,
    preflight: {
      ...teamControlSnapshot.preflight,
      mcpInstalled: false,
      agentsWaiting: false,
      canLaunch: false,
      blockers: ['Agent MCP 尚未接入全部本轮通道', '并非所有 Agent 通道都已在线待命']
    }
  }
}

describe('team dashboard lifecycle view', () => {
  it('shows installation and waiting gates only before launch', () => {
    const gates = unresolvedDashboardGates(snapshot('ready')).map((gate) => gate.label)
    expect(teamDashboardPhase('ready')).toBe('prelaunch')
    expect(gates).toContain('Agent MCP 待安装')
    expect(gates.some((label) => label.includes('尚未进入消息监听'))).toBe(true)
  })

  it.each(['launching', 'completed'] as const)('does not reuse preflight warnings while %s', (status) => {
    expect(unresolvedDashboardGates(snapshot(status))).toEqual([])
  })

  it('reports only real operational problems while running', () => {
    const team = snapshot('running')
    team.preflight.bridgeConnected = true
    team.members = team.members.map((member) => ({
      ...member,
      runtime: member.runtime ? { ...member.runtime, online: true, waiting: false } : member.runtime
    }))
    expect(unresolvedDashboardGates(team)).toEqual([])

    team.members[0]!.runtime!.online = false
    expect(unresolvedDashboardGates(team).map((gate) => gate.label)).toEqual(['1 个在岗 Agent 离线'])
  })

  it('separates persistent run status from live transport presence', () => {
    const team = snapshot('running')
    team.members = team.members.map((member) => ({
      ...member,
      runtime: member.runtime ? {
        ...member.runtime,
        online: false,
        waiting: false,
        connectionPhase: 'offline'
      } : member.runtime
    }))
    expect(teamRuntimePresence(team)).toBe('offline')

    const solo = team.members.find((member) => member.slot.solo)!
    solo.runtime!.online = true
    expect(teamRuntimePresence(team)).toBe('offline')
    solo.runtime!.online = false

    team.members[0]!.runtime!.connectionPhase = 'processing'
    expect(teamRuntimePresence(team)).toBe('in_flight_unverified')

    team.members[1]!.runtime!.online = true
    expect(teamRuntimePresence(team)).toBe('online')
  })
})
