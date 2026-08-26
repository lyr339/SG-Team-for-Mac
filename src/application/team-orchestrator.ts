import type { TaskPoolSnapshot } from '../domain/task-pool'
import type { TeamControlSnapshot, TeamMemberView } from '../domain/team-control'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { MemoryReviewCoordinator } from './memory-review-coordinator'
import { orchestratorMessageId, type OrchestrationSource } from './orchestration-source'
import type { TaskDispatcher } from './task-dispatcher'

/** 任务无更新催办宽限：超过该时长未推进 updatedAt 触发催办/预警。 */
const STALE_TASK_REMINDER_MS = 5 * 60_000

function leadMember(team: TeamControlSnapshot): TeamMemberView | undefined {
  return team.members
    .filter((member) => member.role.templateKey === 'lead' && member.binding)
    .sort((left, right) => left.role.order - right.role.order)[0]
}

export class TeamOrchestrator {
  private unsubscribers: Array<() => void> = []
  private reconciling = false
  private timer?: ReturnType<typeof setInterval>
  constructor(
    private readonly team: OrchestrationSource<TeamControlSnapshot>,
    private readonly tasks: OrchestrationSource<TaskPoolSnapshot>,
    private readonly collaboration: TeamCollaborationRepository,
    private readonly taskDispatcher: TaskDispatcher,
    private readonly memoryCoordinator: MemoryReviewCoordinator,
    private readonly onerror: (error: unknown) => void = () => undefined
  ) {}

  start(intervalMs = 1_000): void {
    if (this.unsubscribers.length) return
    this.taskDispatcher.start()
    this.memoryCoordinator.start()
    this.unsubscribers = [
      this.team.subscribe(() => this.reconcileStaleTasks()),
      this.tasks.subscribe(() => this.reconcileStaleTasks())
    ]
    this.reconcile()
    this.timer = setInterval(() => this.reconcile(), Math.max(250, intervalMs))
    this.timer.unref?.()
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.taskDispatcher.stop()
    this.memoryCoordinator.stop()
  }

  reconcile(): void {
    this.reconcileStaleTasks()
    this.taskDispatcher.reconcile()
    this.memoryCoordinator.reconcile()
  }

  /**
   * 成员任务长时间无更新催办（S3 团队职责强化）：
   * leased/running 任务超过宽限仍无 updatedAt 推进时，
   * 向负责人发催办、向主控发预警；clientMessageId 按时间窗幂等，每窗最多一次。
   */
  private reconcileStaleTasks(now = Date.now()): void {
    if (this.reconciling) return
    this.reconciling = true
    try {
      const team = this.team.getSnapshot()
      const run = team.activeRun
      if (!run || run.status !== 'running') return
      const pool = this.tasks.getSnapshot()
      if (pool.runId && pool.runId !== run.id) return
      const lead = leadMember(team)
      for (const taskId of pool.taskOrder) {
        const task = pool.tasks[taskId]
        if (!task || task.runId !== run.id) continue
        if (task.status !== 'leased' && task.status !== 'running') continue
        const age = now - task.updatedAt
        if (age < STALE_TASK_REMINDER_MS) continue
        const windowIndex = Math.floor(age / STALE_TASK_REMINDER_MS)
        const assignee = team.members.find((member) => (
          member.binding?.agentSessionId === task.assigneeSessionId
        ))
        if (assignee?.binding) {
          this.collaboration.createMessage({
            runId: run.id,
            sender: { type: 'operator' },
            recipient: { type: 'agent', slotId: assignee.slot.id },
            kind: 'question',
            subject: '任务进度催办',
            content: [
              '【系统催办】',
              `任务「${task.title}」已 ${Math.max(1, Math.round(age / 60_000))} 分钟无进度更新。`,
              '请立即调用 team_report_progress 汇报当前进展或阻塞原因；若已完成实现与测试，请 submit_for_review。'
            ].join('\n'),
            clientMessageId: orchestratorMessageId('stale-reminder', task.id, `w${windowIndex}`)
          })
        }
        if (lead && lead.slot.id !== assignee?.slot.id) {
          this.collaboration.createMessage({
            runId: run.id,
            sender: { type: 'operator' },
            recipient: { type: 'agent', slotId: lead.slot.id },
            kind: 'notice',
            subject: '成员任务长时间无更新',
            content: [
              '【系统预警】',
              `${assignee ? `「${assignee.role.name}」的` : ''}任务「${task.title}」已 ${Math.max(1, Math.round(age / 60_000))} 分钟无进度更新，已向其发送催办。`,
              '请关注该任务：必要时用 team_send_message 询问阻塞，或在其掉线后安排接替。'
            ].join('\n'),
            clientMessageId: orchestratorMessageId('stale-lead-notice', task.id, `w${windowIndex}`)
          })
        }
      }
    } catch (error) {
      this.onerror(error)
    } finally {
      this.reconciling = false
    }
  }
}
