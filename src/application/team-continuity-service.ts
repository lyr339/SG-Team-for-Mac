import { createHash, randomUUID } from 'node:crypto'
import type { TaskPoolState, TeamTask } from '../domain/task-pool'
import type { TeamControlSnapshot, TeamMemberView } from '../domain/team-control'
import type { TeamCollaborationSnapshot, TeamMessage } from '../domain/team-collaboration'
import { teamMessageReceiptStage, teamMessageRequiresResponse } from '../domain/team-collaboration'
import type { TeamMemoryItem, TeamMemorySnapshot } from '../domain/team-memory'
import type {
  TeamCheckpoint,
  TeamCheckpointCapsule,
  TeamContinuitySnapshot,
  TeamRestoreMember,
  TeamRestoreOperation
} from '../domain/team-continuity'
import { emptyTeamContinuitySnapshot } from '../domain/team-continuity'
import type { TeamTakeoverCapsule } from '../domain/team-continuity'
import { cursorComposerBindingMarker } from '../domain/cursor-telemetry'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { TeamContinuityRepository } from './team-continuity-repository'

const AUTO_CAPTURE_DEBOUNCE_MS = 650
const MAX_TASKS = 50
const MAX_MESSAGES = 80
const MAX_MEMORY = 20

interface SnapshotSource<T> {
  getSnapshot(): T
  subscribe(listener: (snapshot: T) => void): () => void
}

export interface TeamContinuitySources {
  team: SnapshotSource<TeamControlSnapshot>
  tasks: SnapshotSource<TaskPoolState>
  collaboration: SnapshotSource<TeamCollaborationSnapshot>
  memory: SnapshotSource<TeamMemorySnapshot>
}

type Listener = (snapshot: TeamContinuitySnapshot) => void

function activeTaskViews(pool: TaskPoolState): TeamCheckpointCapsule['activeTasks'] {
  return pool.taskOrder
    .map((id) => pool.tasks[id])
    .filter((task): task is TeamTask => Boolean(task))
    .filter((task) => ['queued', 'leased', 'running', 'review'].includes(task.status))
    .slice(0, MAX_TASKS)
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      targetSlotId: task.targetSlotId,
      assigneeSessionId: task.assigneeSessionId,
      progress: task.progress,
      summary: task.currentAttemptId
        ? pool.attempts[task.currentAttemptId]?.summary.slice(0, 2_000)
        : undefined
    }))
}

function pendingMessageViews(snapshot: TeamCollaborationSnapshot): TeamCheckpointCapsule['pendingMessages'] {
  return snapshot.messageOrder
    .map((id) => snapshot.messages[id])
    .filter((message): message is TeamMessage => Boolean(message))
    .filter((message) => (
      message.recipient.type === 'agent'
      && teamMessageRequiresResponse(message.kind)
      && message.receipt.respondedAt === undefined
    ))
    .slice(-MAX_MESSAGES)
    .map((message) => ({
      id: message.id,
      sender: message.sender,
      recipient: message.recipient,
      kind: message.kind,
      content: message.content.slice(0, 2_000),
      stage: teamMessageReceiptStage(message.receipt)
    }))
}

function acceptedMemoryViews(snapshot: TeamMemorySnapshot): TeamCheckpointCapsule['sharedMemory'] {
  return snapshot.itemOrder
    .map((id) => snapshot.items[id])
    .filter((item): item is TeamMemoryItem => Boolean(item && item.status === 'accepted' && item.scope === 'run'))
    .slice(0, MAX_MEMORY)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      content: item.content.slice(0, 4_000),
      version: item.version
    }))
}

function memberViews(team: TeamControlSnapshot): TeamCheckpointCapsule['members'] {
  return team.members.map((member) => ({
    slotId: member.slot.id,
    roleKey: member.role.key,
    roleName: member.role.name,
    channelId: member.binding?.channelId ?? member.slot.channelId,
    workingFiles: [...(member.runtime?.workingFiles ?? [])]
  }))
}

function digestOf(capsule: Omit<TeamCheckpointCapsule, 'capturedAt'>): string {
  return createHash('sha256').update(JSON.stringify(capsule)).digest('hex')
}

function restoreMemberState(message: TeamMessage | undefined): TeamRestoreMember['state'] {
  if (!message) return 'queued'
  const stage = teamMessageReceiptStage(message.receipt)
  if (stage === 'responded') return 'restored'
  if (stage === 'read' || stage === 'acknowledged') return 'read'
  if (stage === 'notified') return 'notified'
  if (stage === 'failed' || stage === 'uncertain') return 'attention'
  return 'queued'
}

function restoreDetail(state: TeamRestoreMember['state']): string {
  const labels: Record<TeamRestoreMember['state'], string> = {
    queued: '恢复胶囊已入队，等待 Agent 待命',
    notified: '已通知 Agent，等待读取',
    read: 'Agent 已读取，正在恢复上下文',
    restored: 'Agent 已明确回应恢复完成',
    attention: '通知状态不确定，需要检查通道'
  }
  return labels[state]
}

function roleRestoreContent(
  checkpoint: TeamCheckpoint,
  member: TeamMemberView,
  takeover?: {
    failoverId: string
    previousAgentSessionId: string
    replacementChannelId: string
    bindingKey: string
    mode: 'automatic' | 'manual'
  }
): string {
  const capsule = checkpoint.capsule
  const taskIds = new Set(capsule.activeTasks
    .filter((task) => (
      task.targetSlotId === member.slot.id
      || task.assigneeSessionId === member.binding?.agentSessionId
      || Boolean(takeover && task.assigneeSessionId === takeover.previousAgentSessionId)
    ))
    .map((task) => task.id))
  const tasks = capsule.activeTasks.filter((task) => taskIds.has(task.id)).slice(0, 12)
  const messages = capsule.pendingMessages.filter((message) => (
    (message.recipient.type === 'agent' && message.recipient.slotId === member.slot.id)
    || (message.sender.type === 'agent' && message.sender.slotId === member.slot.id)
  )).slice(0, 12)
  const workingFiles = capsule.members.find((candidate) => candidate.slotId === member.slot.id)?.workingFiles ?? []
  const takeoverLines = takeover ? [
    `接替事件：${takeover.failoverId}`,
    `${takeover.mode === 'manual' ? '用户已执行手动交接' : '系统已执行自动接替'}：你正在 CH-${takeover.replacementChannelId} 接替已掉线运行时；旧 Agent 已被封禁。`,
    `Cursor 会话绑定标记：${cursorComposerBindingMarker({ bindingKey: takeover.bindingKey, channelId: takeover.replacementChannelId })}`
  ] : []
  return [
    takeover ? `【群枢 ${takeover.mode === 'manual' ? '手动交接' : '自动接替'}胶囊】` : '【群枢恢复胶囊】',
    ...takeoverLines,
    `检查点：${checkpoint.id}`,
    `稳定身份：${member.slot.id}；角色：${member.role.name}。`,
    `团队目标：${capsule.goal}`,
    '',
    '你的未完成任务：',
    tasks.length
      ? tasks.map((task) => `- ${task.id}｜${task.title}｜${task.status}｜${task.progress}%${task.summary ? `｜${task.summary}` : ''}`).join('\n')
      : '- 暂无定向未完成任务',
    '',
    '与你相关的待处理协作消息：',
    messages.length
      ? messages.map((message) => `- ${message.id}｜${message.kind}｜${message.stage}｜${message.content.slice(0, 600)}`).join('\n')
      : '- 暂无待处理协作消息',
    '',
    '相关工作文件：',
    workingFiles.length > 0
      ? workingFiles.map((path) => `- ${path}`).join('\n')
      : '- 暂无已采集文件路径，请先核对当前工作区变更',
    '',
    '团队共享记忆（只包含已采纳条目）：',
    capsule.sharedMemory.length
      ? capsule.sharedMemory.slice(0, 12).map((memory) => `- [${memory.kind}] ${memory.title}：${memory.content.slice(0, 600)}`).join('\n')
      : '- 暂无已采纳共享记忆',
    '',
    `${takeover ? '接替' : '恢复'}步骤：`,
    ...(takeover ? ['1. 先调用 team_check_in，确认新的稳定角色和权限已经生效。'] : []),
    `${takeover ? '2' : '1'}. 调用 team_get_context 核对当前成员、任务、消息和本轮关键上下文。`,
    `${takeover ? '3' : '2'}. 对未读消息调用 team_read_message；继续属于你的 leased/running 任务，不要重复创建任务。`,
    `${takeover ? '4' : '3'}. 使用 team_respond_message 回应本${takeover ? '接替' : '恢复'}消息，写清“已${takeover ? '接替' : '恢复'}”、当前任务和仍存在的阻塞。`,
    '普通 record_reply 只同步给用户，不能替代恢复回执。'
  ].join('\n')
}

export class TeamContinuityService {
  private readonly listeners = new Set<Listener>()
  private readonly unsubscribers: Array<() => void>
  private captureTimer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly repository: TeamContinuityRepository,
    private readonly collaborationRepository: TeamCollaborationRepository,
    private readonly sources: TeamContinuitySources
  ) {
    this.unsubscribers = [
      sources.team.subscribe(() => this.scheduleCapture()),
      sources.tasks.subscribe(() => this.scheduleCapture()),
      sources.collaboration.subscribe(() => {
        this.scheduleCapture()
        this.emit()
      }),
      sources.memory.subscribe(() => this.scheduleCapture())
    ]
  }

  getSnapshot(): TeamContinuitySnapshot {
    const team = this.sources.team.getSnapshot()
    const workspaceId = team.activeWorkspaceId
    const runId = team.activeRun?.id
    if (!workspaceId || !runId) return emptyTeamContinuitySnapshot(workspaceId, runId)
    const checkpoints = this.repository.listCheckpoints(workspaceId, runId)
    const storedRestore = this.repository.latestRestore(runId)
    const collaboration = this.sources.collaboration.getSnapshot()
    let activeRestore: TeamRestoreOperation | undefined
    if (storedRestore) {
      const members = storedRestore.members.map((member): TeamRestoreMember => {
        const message = member.messageId ? collaboration.messages[member.messageId] : undefined
        const state = restoreMemberState(message)
        return {
          slotId: member.slotId,
          roleName: member.roleName,
          messageId: member.messageId,
          state,
          detail: restoreDetail(state)
        }
      })
      const status: TeamRestoreOperation['status'] = members.every((member) => member.state === 'restored')
        ? 'completed'
        : members.some((member) => member.state === 'attention')
          ? 'attention'
          : storedRestore.status
      activeRestore = { ...storedRestore, status, members }
    }
    return {
      schemaVersion: 1,
      revision: this.repository.revision(),
      workspaceId,
      runId,
      checkpoints,
      activeRestore,
      updatedAt: Math.max(
        checkpoints[0]?.createdAt ?? 0,
        activeRestore?.updatedAt ?? 0,
        collaboration.updatedAt
      )
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  capture(reason: TeamCheckpoint['reason'] = 'automatic'): TeamCheckpoint | undefined {
    const team = this.sources.team.getSnapshot()
    const run = team.activeRun
    const workspaceId = team.activeWorkspaceId
    if (!run || !workspaceId) return undefined
    const base = {
      schemaVersion: 1 as const,
      goal: run.goal,
      runName: run.name,
      runStatus: run.status,
      members: memberViews(team),
      activeTasks: activeTaskViews(this.sources.tasks.getSnapshot()),
      pendingMessages: pendingMessageViews(this.sources.collaboration.getSnapshot()),
      sharedMemory: acceptedMemoryViews(this.sources.memory.getSnapshot())
    }
    const capsule: TeamCheckpointCapsule = { ...base, capturedAt: Date.now() }
    const checkpoint = this.repository.saveCheckpoint({
      workspaceId,
      runId: run.id,
      reason,
      digest: digestOf(base),
      capsule
    })
    this.emit()
    return checkpoint
  }

  restore(checkpointId?: string): TeamRestoreOperation {
    const team = this.sources.team.getSnapshot()
    const run = team.activeRun
    const workspaceId = team.activeWorkspaceId
    if (!run || !workspaceId) throw new Error('当前没有活动 TeamRun')
    if (!team.preflight.mcpInstalled || team.members.some((member) => !member.binding)) {
      throw new Error('请先为所有 AgentSlot 安装当前 MCP generation')
    }
    this.capture('before_restore')
    const checkpoint = checkpointId
      ? this.repository.getCheckpoint(checkpointId)
      : this.repository.listCheckpoints(workspaceId, run.id, 1)[0]
    if (!checkpoint || checkpoint.workspaceId !== workspaceId || checkpoint.runId !== run.id) {
      throw new Error('没有可用于当前团队的恢复检查点')
    }
    const restoreId = `team-restore:${randomUUID()}`
    this.repository.beginRestore({
      id: restoreId,
      workspaceId,
      runId: run.id,
      checkpointId: checkpoint.id,
      members: team.members.map((member) => ({
        slotId: member.slot.id,
        roleName: member.role.name
      }))
    })
    for (const member of team.members) {
      const message = this.collaborationRepository.createMessage({
        runId: run.id,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: member.slot.id },
        kind: 'notice',
        subject: `恢复团队 · ${checkpoint.capsule.runName}`,
        content: roleRestoreContent(checkpoint, member),
        clientMessageId: `${restoreId}:${member.slot.id}`.slice(0, 200)
      })
      this.repository.attachRestoreMessage(restoreId, member.slot.id, message.id)
    }
    this.emit()
    return this.getSnapshot().activeRestore!
  }

  createTakeoverCapsule(input: {
    slotId: string
    failoverId: string
    previousAgentSessionId: string
    replacementChannelId: string
    bindingKey: string
    checkpointId?: string
    mode?: 'automatic' | 'manual'
  }): TeamTakeoverCapsule {
    const checkpoint = input.checkpointId
      ? this.repository.getCheckpoint(input.checkpointId.trim())
      : this.capture('automatic')
    if (!checkpoint) throw new Error('当前 TeamRun 无法生成接替检查点')
    const team = this.sources.team.getSnapshot()
    if (checkpoint.runId !== team.activeRun?.id || checkpoint.workspaceId !== team.activeWorkspaceId) {
      throw new Error('接替检查点不属于当前 TeamRun')
    }
    const member = team.members.find((candidate) => candidate.slot.id === input.slotId.trim())
    if (!member) throw new Error('接替职责不属于当前 TeamRun')
    const taskIds = checkpoint.capsule.activeTasks
      .filter((task) => task.targetSlotId === member.slot.id || task.assigneeSessionId === input.previousAgentSessionId)
      .map((task) => task.id)
    return {
      checkpointId: checkpoint.id,
      taskIds,
      content: roleRestoreContent(checkpoint, member, {
        failoverId: input.failoverId,
        previousAgentSessionId: input.previousAgentSessionId,
        replacementChannelId: input.replacementChannelId,
        bindingKey: input.bindingKey,
        mode: input.mode ?? 'automatic'
      })
    }
  }

  dispose(): void {
    if (this.captureTimer) clearTimeout(this.captureTimer)
    this.captureTimer = undefined
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.listeners.clear()
  }

  private scheduleCapture(): void {
    if (this.captureTimer) clearTimeout(this.captureTimer)
    this.captureTimer = setTimeout(() => {
      this.captureTimer = undefined
      try {
        this.capture()
      } catch (error) {
        process.stderr.write(`[team-continuity] automatic checkpoint failed: ${String(error)}\n`)
      }
    }, AUTO_CAPTURE_DEBOUNCE_MS)
    this.captureTimer.unref?.()
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
