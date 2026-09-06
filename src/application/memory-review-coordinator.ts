import type { TeamControlSnapshot } from '../domain/team-control'
import type { TeamMemoryItem, TeamMemorySnapshot } from '../domain/team-memory'
import { memoryReviewNeedsOperator, selectMemoryReviewMember } from '../domain/team-orchestration'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import { orchestratorMessageId, type OrchestrationSource } from './orchestration-source'

export class MemoryReviewCoordinator {
  private unsubscribers: Array<() => void> = []
  private reconciling = false

  constructor(
    private readonly memory: OrchestrationSource<TeamMemorySnapshot>,
    private readonly team: OrchestrationSource<TeamControlSnapshot>,
    private readonly collaboration: TeamCollaborationRepository,
    private readonly onerror: (error: unknown) => void = () => undefined,
    private readonly now: () => number = Date.now
  ) {}

  start(): void {
    if (this.unsubscribers.length) return
    this.unsubscribers = [
      this.memory.subscribe(() => this.reconcile()),
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
      const snapshot = this.memory.getSnapshot()
      if (snapshot.runId && snapshot.runId !== runId) return
      for (const id of snapshot.itemOrder) {
        const item = snapshot.items[id]
        if (!item || item.status !== 'proposed' || item.runId !== runId) continue
        try {
          this.assign(item, team)
        } catch (error) {
          this.onerror(error)
        }
      }
    } finally {
      this.reconciling = false
    }
  }

  private assign(item: TeamMemoryItem, team: TeamControlSnapshot): void {
    const reviewer = selectMemoryReviewMember(item, team)
    if (reviewer) {
      this.collaboration.createMessage({
        runId: item.runId,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: reviewer.slot.id },
        kind: 'directive',
        subject: `团队记忆审核：${item.title}`,
        content: [
          '【系统记忆审核调度】',
          `记忆 ID：${item.id}`,
          `范围：${item.scope === 'project' ? '项目长期记忆' : '本次运行记忆'}`,
          `类型：${item.kind}`,
          `标题：${item.title}`,
          `内容：${item.content}`,
          `来源数量：${item.sources.length}`,
          '请调用 team_memory({action:\'search\', includeProposed:true}) 核对来源，再调用 team_memory({action:\'review\', memoryId, decision}) 给出采纳或拒绝结论，并用 team_message({action:\'respond\', messageId, content}) 回应本调度消息。',
          '禁止审核自己提出的记忆；项目级记忆必须由质量角色确认。'
        ].join('\n'),
        clientMessageId: orchestratorMessageId('memory', item.id, item.version)
      })
      if (!memoryReviewNeedsOperator(item, team, this.now())) return
    }

    if (item.proposedBy.type === 'agent') {
      this.collaboration.createMessage({
        runId: item.runId,
        sender: item.proposedBy,
        recipient: { type: 'operator' },
        kind: 'notice',
        subject: `记忆审核需要人工处理：${item.title}`,
        content: reviewer
          ? `记忆 ${item.id} 自动审核超过 30 分钟仍未完成，请由用户决定是否接管。`
          : `记忆 ${item.id} 找不到独立且有权限的审核 Agent，请由用户决定是否采纳。`,
        clientMessageId: orchestratorMessageId('memory-escalation', item.id, item.version)
      })
    }
  }
}
