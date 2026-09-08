import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationEntry } from '../domain/conversation-entry'
import {
  buildSessionHandoffMessage,
  buildSessionHandoffRecord,
  handoffRecordFileName,
  isTeamSeatRole,
  SESSION_HANDOFF_NOTE_MAX_CHARS,
  type SessionHandoffContext,
  type SessionHandoffRequest,
  type SessionHandoffResult,
  type SessionHandoffSeatRole,
  type SessionHandoffTarget,
  type SessionTranscriptLocation
} from '../domain/session-handoff'
import type { TeamControlSnapshot } from '../domain/team-control'
import type { DesktopSnapshot, SendMessageAccepted, SendMessageInput } from '../shared/desktop-api'

export interface SessionHandoffPorts {
  team: { getSnapshot(): TeamControlSnapshot }
  sessions: {
    getSnapshot(): DesktopSnapshot
    sendMessage(input: SendMessageInput): SendMessageAccepted
    currentSessionToken(channelId: string): string | undefined
  }
  /** Cursor 转录定位（CursorComposerTelemetryReader.locateTranscript）。 */
  locateTranscript(composerId: string, workspacePath?: string): SessionTranscriptLocation | undefined
  /** 通道时间线（relay.conversationsOf）。 */
  conversationsOf(channelId: string): readonly ConversationEntry[] | undefined
  /** 拾光会话记录落盘目录（userData/handoff）。 */
  handoffRoot: string
  now?: () => number
  onerror?: (error: unknown) => void
}

/** 通道在当前运行中的席位角色（独立席位也算，templateKey='solo'）；备用/未编入通道无。 */
function seatRoleOf(team: TeamControlSnapshot, channelId: string): SessionHandoffSeatRole | undefined {
  const member = team.members.find((candidate) => (candidate.binding?.channelId ?? candidate.slot.channelId) === channelId)
  return member
    ? { name: member.role.name, slotName: member.slot.name, templateKey: member.role.templateKey }
    : undefined
}

/**
 * 会话交接：把当前 Cursor 会话的上下文文档（转录）路径连同拾光会话记录，作为一条
 * 用户消息排进目标通道队列。目标为本会话时携带「等待新会话」保持位。
 */
export class SessionHandoffService {
  private readonly now: () => number

  constructor(private readonly ports: SessionHandoffPorts) {
    this.now = ports.now ?? Date.now
  }

  context(channelId: string): SessionHandoffContext {
    const id = String(channelId ?? '').trim()
    if (!/^\d+$/.test(id)) throw new Error('通道号无效')
    const team = this.ports.team.getSnapshot()
    const snapshot = this.ports.sessions.getSnapshot()
    const session = snapshot.sessions.find((candidate) => candidate.channelId === id)
    const runId = team.activeRun?.id
    const binding = team.bindings.find((candidate) => candidate.channelId === id && (!runId || candidate.runId === runId))
    const workspacePath = team.workspaces.find((workspace) => workspace.id === team.activeWorkspaceId)?.path
    const composerId = session?.composerId ?? binding?.composerId ?? session?.telemetryChannelComposerId
    const entries = (this.ports.conversationsOf(id) ?? []).filter((entry) => !entry.silent)
    const users = entries.filter((entry) => entry.role === 'user')
    const assistants = entries.filter((entry) => entry.role === 'assistant')
    const role = seatRoleOf(team, id)
    return {
      channelId: id,
      displayName: session?.displayName ?? `CH-${id}`,
      ...(role ? { role } : {}),
      composerId,
      modelName: session?.executionProfile?.displayName ?? session?.modelName,
      transcript: composerId ? this.ports.locateTranscript(composerId, workspacePath) : undefined,
      holdSupported: Boolean(this.ports.sessions.currentSessionToken(id)),
      userMessageCount: users.length,
      assistantMessageCount: assistants.length,
      firstMessageAt: entries[0]?.timestamp,
      lastMessageAt: entries.at(-1)?.timestamp
    }
  }

  deliver(request: SessionHandoffRequest): SessionHandoffResult {
    return this.deliverFrom(this.context(request.sourceChannelId), request.target, request.note)
  }

  /**
   * 用已解析好的来源上下文投递。职责迁移会改写原席位绑定（channel_id 换成接手通道、
   * composer_id 清空），迁移后再 context(原通道) 已定位不到转录——调用方须在迁移前解析，
   * 迁移成功后再用这里投递。
   */
  deliverFrom(source: SessionHandoffContext, target: SessionHandoffTarget, note?: string): SessionHandoffResult {
    if (!source.composerId || !source.transcript) {
      throw new Error(`CH-${source.channelId} 尚未绑定 Cursor Composer，找不到它的上下文文档`)
    }
    const targetChannelId = target.kind === 'self' ? source.channelId : String(target.channelId ?? '').trim()
    if (!/^\d+$/.test(targetChannelId)) throw new Error('目标通道无效')
    if (target.kind === 'channel' && targetChannelId === source.channelId) {
      throw new Error('投递给本会话请选择「本会话（等待新会话）」')
    }
    const snapshot = this.ports.sessions.getSnapshot()
    if (!snapshot.sessions.some((candidate) => candidate.channelId === targetChannelId)) {
      throw new Error(`CH-${targetChannelId} 不在当前运行中`)
    }
    const issuedAt = this.now()
    const held = target.kind === 'self' && source.holdSupported
    const team = this.ports.team.getSnapshot()
    const recordPath = this.writeRecord(source, issuedAt, team)
    // 接收方是否团队席位按目标通道此刻的角色判断：本会话 = 来源自己的角色；
    // 其他通道 = 该通道在运行中的角色（备用通道无角色 → 不附团队说明）。
    const targetRole = target.kind === 'self' ? source.role : seatRoleOf(team, targetChannelId)
    const text = buildSessionHandoffMessage({
      sourceChannelId: source.channelId,
      sourceDisplayName: source.displayName,
      sourceRole: source.role,
      sourceModelName: source.modelName,
      target,
      targetIsTeamSeat: isTeamSeatRole(targetRole),
      issuedAt,
      transcript: source.transcript,
      recordPath,
      note: note?.trim().slice(0, SESSION_HANDOFF_NOTE_MAX_CHARS) || undefined
    })
    const accepted = this.ports.sessions.sendMessage({
      channelId: targetChannelId,
      text,
      ...(held ? { holdUntilNewSession: true } : {})
    })
    return {
      targetChannelId,
      held,
      transcriptPath: source.transcript.path,
      recordPath,
      commandId: accepted.commandId,
      issuedAt
    }
  }

  private writeRecord(source: SessionHandoffContext, issuedAt: number, team: TeamControlSnapshot): string | undefined {
    try {
      const entries = this.ports.conversationsOf(source.channelId) ?? []
      const markdown = buildSessionHandoffRecord({
        channelId: source.channelId,
        displayName: source.displayName,
        workspacePath: team.workspaces.find((workspace) => workspace.id === team.activeWorkspaceId)?.path,
        runId: team.activeRun?.id,
        composerId: source.composerId,
        modelName: source.modelName,
        transcriptPath: source.transcript?.path,
        issuedAt,
        entries
      })
      mkdirSync(this.ports.handoffRoot, { recursive: true })
      const path = join(this.ports.handoffRoot, handoffRecordFileName(source.channelId, source.composerId, issuedAt))
      writeFileSync(path, markdown, 'utf8')
      return path
    } catch (error) {
      // 记录文件只是补充材料：写入失败不阻断交接，Cursor 转录路径仍然投递。
      this.ports.onerror?.(error)
      return undefined
    }
  }
}
