import type { TeamControlSnapshot, TeamRunStatus } from '../../../domain/team-control'

export type TeamDashboardPhase = 'prelaunch' | 'launching' | 'active' | 'paused' | 'completed'

export interface TeamDashboardGate {
  label: string
  detail: string
  passed: boolean
}

export function teamDashboardPhase(status: TeamRunStatus): TeamDashboardPhase {
  if (status === 'draft' || status === 'ready') return 'prelaunch'
  if (status === 'launching') return 'launching'
  if (status === 'running' || status === 'attention') return 'active'
  if (status === 'paused') return 'paused'
  return 'completed'
}

export function unresolvedDashboardGates(team: TeamControlSnapshot): TeamDashboardGate[] {
  const status = team.activeRun?.status
  if (!status) return []
  const phase = teamDashboardPhase(status)
  const waitingAgents = team.members.filter((member) => member.runtime?.online && member.runtime.waiting).length
  const offlineAgents = team.members.filter((member) => !member.runtime?.online).length

  const candidates: TeamDashboardGate[] = phase === 'prelaunch' ? [
    { label: '通道未连接', detail: '点击右上角连接状态处理', passed: team.preflight.bridgeConnected },
    { label: '工作区未绑定', detail: '重新选择 Cursor 工程', passed: team.preflight.workspaceBound },
    { label: '目标未保存', detail: '补充团队目标后才能启动', passed: team.preflight.goalDefined },
    { label: 'Agent MCP 待安装', detail: '为当前工程写入团队工具', passed: team.preflight.mcpInstalled },
    {
      label: `${Math.max(0, team.members.length - waitingAgents)} 个在岗 Agent 尚未进入消息监听`,
      detail: `${waitingAgents}/${team.members.length} 已就绪`,
      passed: team.preflight.agentsWaiting
    }
  ] : phase === 'active' ? [
    { label: '通道未连接', detail: '点击右上角连接状态处理', passed: team.preflight.bridgeConnected },
    {
      label: `${offlineAgents} 个在岗 Agent 离线`,
      detail: `${team.members.length - offlineAgents}/${team.members.length} 在线`,
      passed: offlineAgents === 0
    }
  ] : []

  return candidates.filter((gate) => !gate.passed)
}
