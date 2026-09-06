import type { TeamControlSnapshot, TeamMemberRuntime, TeamMemberView, TeamRunStatus } from '../src/domain/team-control'
import { teamControlSnapshot } from '../src/renderer/src/preview/mock-data'

/** 席位运行形态：与服务端守卫口径一致（在岗 / 执行租约 / 离线 / 无证据）。 */
export type SeatShape = 'waiting' | 'working' | 'offline' | 'unconfirmed'

export function runtimeOf(shape: SeatShape, channelId: string): TeamMemberRuntime | undefined {
  if (shape === 'unconfirmed') return undefined
  const base = { channelId, queueDepth: 0, lastSeenAt: Date.now() - 5_000, healthEvidence: [], workingFiles: [] }
  if (shape === 'waiting') return { ...base, status: 'waiting', online: true, waiting: true, connectionPhase: 'waiting' }
  // 执行租约：已取走消息、长任务期间心跳停刷（online=false）仍算在岗执行中。
  if (shape === 'working') return { ...base, status: 'running', online: false, waiting: false, connectionPhase: 'processing' }
  return { ...base, status: 'offline', online: false, waiting: false, connectionPhase: 'offline' }
}

/** 独立批次快照：按形态给每个独立席位一个运行态（团队席位一律剔除）。 */
export function independentTeam(shapes: SeatShape[], status: TeamRunStatus = 'running'): TeamControlSnapshot {
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

/** 团队快照：所有席位按同一形态；独立席位保留在快照里（页面必须自己过滤掉）。 */
export function teamRun(shape: SeatShape, status: TeamRunStatus = 'running'): TeamControlSnapshot {
  const snapshot = structuredClone(teamControlSnapshot)
  snapshot.activeRun = { ...snapshot.activeRun!, status }
  snapshot.members = snapshot.members.map((member) => ({
    ...member,
    runtime: runtimeOf(shape, member.slot.channelId ?? '9')
  }))
  return snapshot
}
