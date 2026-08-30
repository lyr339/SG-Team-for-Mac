import type { TaskPoolSnapshot, TaskReview, TeamTask } from '../domain/task-pool'
import type { TeamControlSnapshot, TeamMemberView } from '../domain/team-control'
import { selectTaskReviewMember } from '../domain/team-orchestration'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import { orchestratorMessageId, type OrchestrationSource } from './orchestration-source'

function runnable(task: TeamTask, pool: TaskPoolSnapshot): boolean {
  return task.status === 'queued' && task.dependsOn.every((id) => pool.tasks[id]?.status === 'done')
}

function activeAgentSessions(pool: TaskPoolSnapshot): Set<string> {
  return new Set(pool.taskOrder.flatMap((id) => {
    const task = pool.tasks[id]
    return task && ['leased', 'running'].includes(task.status) && task.assigneeSessionId
      ? [task.assigneeSessionId]
      : []
  }))
}

export function executionMember(task: TeamTask, team: TeamControlSnapshot, pool: TaskPoolSnapshot): TeamMemberView | undefined {
  const busySessions = activeAgentSessions(pool)
  const eligible = team.members
    .filter((member) => member.slot.solo !== true)
    .filter((member) => Boolean(member.binding))
    .filter((member) => !task.targetSlotId || member.slot.id === task.targetSlotId)
    .filter((member) => task.requiredCapabilities.every((capability) => member.role.capabilities.includes(capability)))
    .filter((member) => !member.binding || !busySessions.has(member.binding.agentSessionId))
    .sort((left, right) => {
      const roleRank = (member: TeamMemberView): number => {
        if (['builder', 'backend', 'frontend', 'specialist'].includes(member.role.templateKey)) return 0
        if (member.role.templateKey === 'lead') return 1
        return 2
      }
      const runtimeRank = (member: TeamMemberView): number => member.runtime?.online && member.runtime.waiting ? 0 : 1
      return runtimeRank(left) - runtimeRank(right)
        || roleRank(left) - roleRank(right)
        || left.role.order - right.role.order
    })
  return eligible[0]
}

export class TaskDispatcher {
  private unsubscribers: Array<() => void> = []
  private reconciling = false

  constructor(
    private readonly tasks: OrchestrationSource<TaskPoolSnapshot>,
    private readonly team: OrchestrationSource<TeamControlSnapshot>,
    private readonly collaboration: TeamCollaborationRepository,
    private readonly onerror: (error: unknown) => void = () => undefined
  ) {}

  start(): void {
    if (this.unsubscribers.length) return
    this.unsubscribers = [
      this.tasks.subscribe(() => this.reconcile()),
      this.team.subscribe(() => this.reconcile())
    ]
    this.reconcile()
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
  }

  reconcile(): void {
    if (this.reconciling) return
    this.reconciling = true
    try {
      const team = this.team.getSnapshot()
      const run = team.activeRun
      if (!run || !['running', 'attention'].includes(run.status)) return
      const runId = run.id
      const pool = this.tasks.getSnapshot()
      if (pool.runId && pool.runId !== runId) return

      for (const taskId of pool.taskOrder) {
        const task = pool.tasks[taskId]
        if (!task || task.runId !== runId) continue
        try {
          if (runnable(task, pool)) this.dispatchExecution(task, team, pool)
          if (task.status === 'review' && task.currentReviewId) {
            const review = pool.reviews[task.currentReviewId]
            if (review?.status === 'queued') this.dispatchReview(task, review, team, pool)
          }
        } catch (error) {
          this.onerror(error)
        }
      }
    } finally {
      this.reconciling = false
    }
  }

  private dispatchExecution(task: TeamTask, team: TeamControlSnapshot, pool: TaskPoolSnapshot): void {
    const member = executionMember(task, team, pool)
    if (!member) return
    const retry = task.attemptCount > 0
    this.collaboration.createMessage({
      runId: task.runId,
      sender: { type: 'operator' },
      recipient: { type: 'agent', slotId: member.slot.id },
      kind: 'directive',
      subject: retry ? `任务重新分配：${task.title}` : `新任务：${task.title}`,
      content: [
        '【系统任务调度】',
        `任务 ID：${task.id}`,
        `标题：${task.title}`,
        task.description ? `目标与边界：${task.description}` : '',
        task.acceptance ? `验收标准：${task.acceptance}` : '',
        retry && task.failureReason ? `上次未通过原因：${task.failureReason}` : '',
        `请调用 team_get_task({ taskId: "${task.id}" }) 核对详情，再调用 team_claim_task({ taskId: "${task.id}" }) 原子领取。`,
        '领取成功后开始执行并按 Team 流程汇报；不要只回复“收到”。'
      ].filter(Boolean).join('\n'),
      clientMessageId: orchestratorMessageId('task', task.id, task.attemptCount)
    })
  }

  private dispatchReview(
    task: TeamTask,
    review: TaskReview,
    team: TeamControlSnapshot,
    pool: TaskPoolSnapshot
  ): void {
    const member = selectTaskReviewMember(review, team, pool)
    if (!member) return
    const attempt = pool.attempts[review.attemptId]
    this.collaboration.createMessage({
      runId: task.runId,
      sender: { type: 'operator' },
      recipient: { type: 'agent', slotId: member.slot.id },
      kind: 'directive',
      subject: `独立验收：${task.title}`,
      content: [
        '【系统独立验收调度】',
        `任务 ID：${task.id}`,
        `验收记录：${review.id}`,
        `验收标准：${task.acceptance || '按任务目标与交付证据独立验证'}`,
        attempt?.output ? `实现方交付摘要：${attempt.output.slice(0, 4_000)}` : '',
        '请调用 team_claim_review 领取，独立复现并检查失败路径；随后用 team_submit_review 提交证据与通过/打回结论。',
        '禁止复述实现方结论，禁止让实现者自审。'
      ].filter(Boolean).join('\n'),
      clientMessageId: orchestratorMessageId('review', review.id, review.leaseCount)
    })
  }
}
