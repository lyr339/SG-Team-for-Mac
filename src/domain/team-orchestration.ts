import type { TaskPoolSnapshot, TaskReview, TeamTask } from './task-pool'
import type { TeamControlSnapshot, TeamMemberView } from './team-control'
import type { TeamMemoryItem } from './team-memory'

export const MEMORY_REVIEW_ESCALATION_MS = 30 * 60 * 1_000

function runtimeRank(member: TeamMemberView): number {
  return member.runtime?.online && member.runtime.waiting ? 0 : 1
}

export function selectTaskReviewMember(
  review: TaskReview,
  team: TeamControlSnapshot,
  pool: TaskPoolSnapshot
): TeamMemberView | undefined {
  const implementation = pool.attempts[review.attemptId]
  return team.members
    .filter((member) => member.slot.solo !== true)
    .filter((member) => Boolean(member.binding))
    .filter((member) => member.role.capabilities.includes('qa'))
    .filter((member) => member.binding?.agentSessionId !== implementation?.agentSessionId)
    .sort((left, right) => runtimeRank(left) - runtimeRank(right) || left.role.order - right.role.order)[0]
}

export function selectMemoryReviewMember(
  item: TeamMemoryItem,
  team: TeamControlSnapshot
): TeamMemberView | undefined {
  return team.members
    // solo 模板能力为空且不是 lead/reviewer，本过滤属显式防御，防未来模板扩展误纳入。
    .filter((member) => member.slot.solo !== true)
    .filter((member) => Boolean(member.binding))
    .filter((member) => item.scope === 'project'
      ? member.role.templateKey === 'reviewer' || member.role.capabilities.includes('qa')
      : member.role.templateKey === 'lead' || member.role.templateKey === 'reviewer')
    .filter((member) => item.proposedBy.type !== 'agent' || member.slot.id !== item.proposedBy.slotId)
    .sort((left, right) => {
      const roleRank = (member: TeamMemberView): number => {
        if (item.scope === 'project') return member.role.templateKey === 'reviewer' ? 0 : 1
        return member.role.templateKey === 'lead' ? 0 : 1
      }
      return runtimeRank(left) - runtimeRank(right)
        || roleRank(left) - roleRank(right)
        || left.role.order - right.role.order
    })[0]
}

export function memoryReviewNeedsOperator(
  item: TeamMemoryItem,
  team: TeamControlSnapshot,
  now = Date.now()
): boolean {
  return !selectMemoryReviewMember(item, team)
    || now - item.createdAt >= MEMORY_REVIEW_ESCALATION_MS
}
