import type { TeamMemberView, TeamRun } from '../../domain/team-control'

/**
 * 会话页「交接」按钮的三态。同一个按钮承载两套语义，但不在一个弹窗里切换：
 * - roles：离线团队席位的职责迁移（AgentSlot 换绑 / 主控权限转移，可附带上下文文档）；
 * - context：上下文交接（独立席位与团队席位一致：把 Cursor 转录文档排进本会话
 *   「等待新会话」或其他席位的队列），只要运行未结束就开放，不看在线状态；
 * - disabled：说明为什么不能交接。
 */
export type HandoffEntry =
  | { kind: 'roles'; slotId: string; title: string }
  | { kind: 'context'; title: string }
  | { kind: 'disabled'; title: string }

export const CONTEXT_HANDOFF_TITLE_SOLO = '交接会话上下文：投递转录文档路径到本会话（等待新会话）或其他会话'
export const CONTEXT_HANDOFF_TITLE_TEAM = '交接会话上下文：把该席位 Cursor 会话的转录文档投递到本会话（等待新会话）或其他席位'
export const ROLES_HANDOFF_TITLE = '把离线职责交给其他在线空闲 Agent，可同时交接上下文文档'

export function resolveHandoffEntry(input: {
  member?: Pick<TeamMemberView, 'slot' | 'role' | 'binding' | 'runtime'>
  run?: Pick<TeamRun, 'status'>
}): HandoffEntry {
  const { member, run } = input
  if (!run) return { kind: 'disabled', title: '当前没有活动运行，无法交接' }
  if (run.status === 'completed') return { kind: 'disabled', title: '当前运行已结束，无法交接' }
  if (!member) return { kind: 'disabled', title: '该通道不是本轮运行的席位，无法交接' }
  if (member.role.templateKey === 'solo') return { kind: 'context', title: CONTEXT_HANDOFF_TITLE_SOLO }
  const offlineInLiveRun = Boolean(member.binding)
    && !member.runtime?.online
    && (run.status === 'running' || run.status === 'attention')
  if (offlineInLiveRun) return { kind: 'roles', slotId: member.slot.id, title: ROLES_HANDOFF_TITLE }
  return { kind: 'context', title: CONTEXT_HANDOFF_TITLE_TEAM }
}
