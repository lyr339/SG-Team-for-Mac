import type { TeamControlSnapshot } from '../domain/team-control'
import type { TeamMemoryItem, TeamMemorySnapshot } from '../domain/team-memory'
import { emptyTeamMemorySnapshot } from '../domain/team-memory'
import type { TeamMemoryRepository } from './team-memory-repository'

export interface TeamMemoryTeamSource {
  getSnapshot(): TeamControlSnapshot
  subscribe(listener: (snapshot: TeamControlSnapshot) => void): () => void
}

type Listener = (snapshot: TeamMemorySnapshot) => void

export class TeamMemoryService {
  private readonly listeners = new Set<Listener>()
  private readonly unsubscribeTeam: () => void
  private watchTimer?: ReturnType<typeof setInterval>
  private lastRevision: number

  constructor(
    private readonly repository: TeamMemoryRepository,
    private readonly team: TeamMemoryTeamSource
  ) {
    this.lastRevision = repository.revision()
    this.unsubscribeTeam = team.subscribe(() => this.emit())
  }

  getSnapshot(): TeamMemorySnapshot {
    const team = this.team.getSnapshot()
    const run = team.activeRun
    const workspaceId = team.activeWorkspaceId
    return run && workspaceId
      ? this.repository.load(workspaceId, run.id)
      : emptyTeamMemorySnapshot(workspaceId, run?.id)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  /**
   * 操作员（人类监督者）审核记忆提案。与 Agent 侧审核不同：
   * 操作员拥有最高审核权限，不受角色/自审/项目级限制——提案均来自 Agent，
   * 人的裁决天然独立。状态与取代链校验由 repository.review 保证。
   */
  review(memoryId: string, decision: 'accept' | 'reject', note?: string): TeamMemoryItem {
    const current = this.getSnapshot().items[memoryId.trim()]
    const completedStatus = decision === 'accept' ? 'accepted' : 'rejected'
    if (current?.status === completedStatus
      && current.reviewedBy?.type === 'operator'
      && (current.reviewNote ?? '') === (note?.trim() ?? '')) {
      return structuredClone(current)
    }
    const item = this.repository.review({
      memoryId,
      decision,
      reviewer: { type: 'operator' },
      note
    })
    this.emit()
    return item
  }

  startWatcher(intervalMs = 750): void {
    this.stopWatcher()
    this.watchTimer = setInterval(() => {
      const revision = this.repository.revision()
      if (revision !== this.lastRevision) this.emit()
    }, Math.max(250, intervalMs))
    this.watchTimer.unref?.()
  }

  stopWatcher(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = undefined
  }

  dispose(): void {
    this.stopWatcher()
    this.unsubscribeTeam()
    this.listeners.clear()
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    this.lastRevision = snapshot.revision
    for (const listener of this.listeners) listener(snapshot)
  }
}
