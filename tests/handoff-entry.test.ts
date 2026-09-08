import { describe, expect, it } from 'vitest'
import type { TeamMemberView, TeamRunStatus } from '../src/domain/team-control'
import {
  CONTEXT_HANDOFF_TITLE_SOLO,
  CONTEXT_HANDOFF_TITLE_TEAM,
  resolveHandoffEntry,
  ROLES_HANDOFF_TITLE
} from '../src/renderer/src/handoff-entry'

function member(templateKey: string, options: { online?: boolean; bound?: boolean } = {}): Pick<TeamMemberView, 'slot' | 'role' | 'binding' | 'runtime'> {
  const slot = { id: `slot-${templateKey}`, runId: 'run', roleId: `role-${templateKey}`, name: '席位', avatarId: 'lead', channelId: '2', order: 0, createdAt: 1, updatedAt: 1 }
  const role = { id: `role-${templateKey}`, runId: 'run', key: templateKey, templateKey, name: '角色', mission: '', instructions: '', capabilities: [], skills: [], accent: 'mint' as const, order: 0 }
  const binding = options.bound === false ? undefined : {
    id: 'b', workspaceId: 'ws', runId: 'run', slotId: slot.id, channelId: '2', agentSessionId: 'a', generation: 'g',
    installedAt: 1, launchStatus: 'acknowledged' as const, launchDetail: '', lastCheckInNote: '', composerBindingKey: 'k'
  }
  const online = options.online ?? true
  const runtime = { channelId: '2', status: online ? 'waiting' as const : 'offline' as const, online, waiting: online, queueDepth: 0, healthEvidence: [], workingFiles: [] }
  return { slot, role, binding, runtime }
}

const run = (status: TeamRunStatus) => ({ status })

describe('resolveHandoffEntry（会话页「交接」按钮三态）', () => {
  it('opens the context handoff for solo seats whenever the run is not over, regardless of liveness', () => {
    expect(resolveHandoffEntry({ member: member('solo'), run: run('running') })).toEqual({ kind: 'context', title: CONTEXT_HANDOFF_TITLE_SOLO })
    expect(resolveHandoffEntry({ member: member('solo', { online: false }), run: run('running') })).toEqual({ kind: 'context', title: CONTEXT_HANDOFF_TITLE_SOLO })
    expect(resolveHandoffEntry({ member: member('solo'), run: run('completed') })).toMatchObject({ kind: 'disabled', title: '当前运行已结束，无法交接' })
  })

  it('routes an offline team seat in a live run to the role migration, and every other team seat to the context handoff', () => {
    expect(resolveHandoffEntry({ member: member('builder', { online: false }), run: run('running') }))
      .toEqual({ kind: 'roles', slotId: 'slot-builder', title: ROLES_HANDOFF_TITLE })
    expect(resolveHandoffEntry({ member: member('lead', { online: false }), run: run('attention') })).toMatchObject({ kind: 'roles', slotId: 'slot-lead' })
    // 在线团队席位：上下文交接
    expect(resolveHandoffEntry({ member: member('builder'), run: run('running') })).toEqual({ kind: 'context', title: CONTEXT_HANDOFF_TITLE_TEAM })
    // 尚未 launch（draft / ready）：会话已一键创建、转录已存在，同样开放上下文交接；离线也不走职责迁移
    expect(resolveHandoffEntry({ member: member('builder', { online: false }), run: run('ready') })).toEqual({ kind: 'context', title: CONTEXT_HANDOFF_TITLE_TEAM })
    expect(resolveHandoffEntry({ member: member('reviewer'), run: run('draft') })).toEqual({ kind: 'context', title: CONTEXT_HANDOFF_TITLE_TEAM })
    // 没有运行绑定的离线席位无法迁移职责，退回上下文交接
    expect(resolveHandoffEntry({ member: member('builder', { online: false, bound: false }), run: run('running') })).toEqual({ kind: 'context', title: CONTEXT_HANDOFF_TITLE_TEAM })
  })

  it('explains why a channel cannot be handed off', () => {
    expect(resolveHandoffEntry({ member: member('builder'), run: undefined })).toEqual({ kind: 'disabled', title: '当前没有活动运行，无法交接' })
    expect(resolveHandoffEntry({ member: member('builder'), run: run('completed') })).toEqual({ kind: 'disabled', title: '当前运行已结束，无法交接' })
    expect(resolveHandoffEntry({ member: undefined, run: run('running') })).toEqual({ kind: 'disabled', title: '该通道不是本轮运行的席位，无法交接' })
  })
})
