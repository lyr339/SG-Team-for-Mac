import type { SessionHandoffContext, SessionHandoffResult, SessionHandoffTarget } from '../domain/session-handoff'
import type { TeamControlSnapshot } from '../domain/team-control'
import type {
  ContextHandoffOutcome,
  ManualTeamHandoffInput,
  ManualTeamHandoffOutcome,
  ManualTeamHandoffResult
} from '../domain/team-handoff'

export interface ManualHandoffWithContextPorts {
  failover: { manualHandoff(input: ManualTeamHandoffInput): ManualTeamHandoffResult }
  team: { getSnapshot(): TeamControlSnapshot }
  handoff: {
    context(channelId: string): SessionHandoffContext
    deliverFrom(source: SessionHandoffContext, target: SessionHandoffTarget, note?: string): SessionHandoffResult
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 用户手动职责迁移 + 可选的上下文交接，一次调用内按固定顺序完成：
 *
 * 1. 迁移前解析原席位的上下文（转录位置、会话记录口径）与接手通道——
 *    `rebindSlot*` 会把原席位绑定的 channel_id 改成接手通道并清空 composer_id，
 *    迁移之后 context(原通道) 已定位不到它的转录；
 * 2. 执行迁移（失败原样抛出，不投递任何消息）；
 * 3. 迁移成功后把预解析的上下文作为普通用户消息排进接手通道队列。投递失败不回滚
 *    迁移，以 contextHandoff.ok=false 报告给用户。
 *
 * 不带 includeContext 时与直接调用 failover.manualHandoff 完全等价。
 */
export function manualHandoffWithContext(
  ports: ManualHandoffWithContextPorts,
  input: ManualTeamHandoffInput
): ManualTeamHandoffOutcome {
  const migration = { sourceSlotId: input.sourceSlotId, replacementAgentSessionId: input.replacementAgentSessionId }
  if (!input.includeContext) return { handoff: ports.failover.manualHandoff(migration) }

  const team = ports.team.getSnapshot()
  const sourceChannelId = team.members
    .find((member) => member.slot.id === input.sourceSlotId.trim())?.binding?.channelId
  const targetChannelId = [...team.runtimeChannels, ...team.standbyChannels]
    .find((channel) => channel.agentSessionId === input.replacementAgentSessionId.trim())?.channelId
  // 来源上下文在迁移前解析。找不到 Composer 时 transcript 只是缺省，由投递阶段报告
  // 「找不到上下文文档」；解析阶段的任何异常同样只影响上下文，不能反过来拦住职责迁移。
  let source: SessionHandoffContext | undefined
  let resolveError: string | undefined
  try {
    source = sourceChannelId ? ports.handoff.context(sourceChannelId) : undefined
  } catch (error) {
    resolveError = describe(error)
  }

  const handoff = ports.failover.manualHandoff(migration)

  let contextHandoff: ContextHandoffOutcome
  if (!source || !targetChannelId) {
    contextHandoff = { ok: false, error: resolveError ?? '迁移前没有定位到原席位或接手通道，上下文文档未投递' }
  } else {
    try {
      contextHandoff = { ok: true, result: ports.handoff.deliverFrom(source, { kind: 'channel', channelId: targetChannelId }) }
    } catch (error) {
      contextHandoff = { ok: false, error: describe(error) }
    }
  }
  return { handoff, contextHandoff }
}
