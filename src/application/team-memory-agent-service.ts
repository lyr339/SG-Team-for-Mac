import { randomUUID } from 'node:crypto'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { TeamMemoryRepository } from './team-memory-repository'
import type { TeamAgentRuntimeIdentity, TeamMessageActor } from '../domain/team-collaboration'
import { sameTeamMessageActor } from '../domain/team-collaboration'
import type {
  TeamMemoryItem,
  TeamMemoryKind,
  TeamMemoryScope,
  TeamMemorySource,
  TeamMemoryStatus
} from '../domain/team-memory'
import { TaskPoolError } from '../domain/task-pool'

const CONTEXT_ITEM_LIMIT = 20
const CONTEXT_CHAR_LIMIT = 12_000

export class TeamMemoryAgentService {
  constructor(
    private readonly repository: TeamMemoryRepository,
    private readonly collaboration: TeamCollaborationRepository,
    readonly identity: TeamAgentRuntimeIdentity
  ) {}

  canReview(): boolean {
    const capabilities = new Set(this.identity.capabilities)
    return capabilities.has('coordination') || capabilities.has('qa')
  }

  contextBrief(): Record<string, unknown> {
    const agent = this.currentAgent()
    const accepted = this.repository.search({
      workspaceId: agent.workspaceId,
      runId: agent.runId,
      statuses: ['accepted'],
      limit: 50
    }).filter((item) => item.scope === 'run')
    const items: Array<Pick<TeamMemoryItem, 'id' | 'scope' | 'kind' | 'title' | 'content' | 'version'>> = []
    let characters = 0
    for (const item of accepted) {
      if (items.length >= CONTEXT_ITEM_LIMIT) break
      const nextCharacters = item.title.length + item.content.length
      if (items.length > 0 && characters + nextCharacters > CONTEXT_CHAR_LIMIT) break
      items.push({
        id: item.id,
        scope: item.scope,
        kind: item.kind,
        title: item.title,
        content: item.content,
        version: item.version
      })
      characters += nextCharacters
    }
    return {
      policy: '只注入已采纳且未被取代的记忆；聊天记录不会自动进入团队记忆。',
      itemCount: items.length,
      characterCount: characters,
      items
    }
  }

  search(input: {
    query?: string
    kinds?: TeamMemoryKind[]
    includeProposed?: boolean
    limit?: number
  }): TeamMemoryItem[] {
    const agent = this.currentAgent()
    const statuses: TeamMemoryStatus[] = ['accepted']
    if (input.includeProposed) {
      if (!this.canReview()) throw new TaskPoolError('memory_reviewer_only', '只有主控或质量角色可以查看待确认记忆')
      statuses.push('proposed')
    }
    return this.repository.search({
      workspaceId: agent.workspaceId,
      runId: agent.runId,
      query: input.query,
      kinds: input.kinds,
      statuses,
      limit: input.limit
    }).filter((item) => item.scope === 'run')
  }

  propose(input: {
    scope: TeamMemoryScope
    kind: TeamMemoryKind
    title: string
    content: string
    sources: TeamMemorySource[]
    supersedesId?: string
    clientProposalId?: string
  }): TeamMemoryItem {
    const agent = this.currentAgent()
    if (input.scope !== 'run') {
      throw new TaskPoolError('cross_run_memory_disabled', '临时团队只允许记录当前 TeamRun 上下文')
    }
    return this.repository.propose({
      workspaceId: agent.workspaceId,
      runId: agent.runId,
      scope: input.scope,
      kind: input.kind,
      title: input.title,
      content: input.content,
      proposedBy: { type: 'agent', slotId: agent.slotId },
      sources: input.sources,
      supersedesId: input.supersedesId,
      clientProposalId: input.clientProposalId?.trim() || `agent-memory:${randomUUID()}`
    })
  }

  review(input: {
    memoryId: string
    decision: 'accept' | 'reject'
    note?: string
  }): TeamMemoryItem {
    const agent = this.currentAgent()
    if (agent.roleTemplateKey !== 'lead' && agent.roleTemplateKey !== 'reviewer') {
      throw new TaskPoolError('memory_reviewer_only', '只有主控协调或质量验证可以审核团队记忆')
    }
    const snapshot = this.repository.load(agent.workspaceId, agent.runId)
    const item = snapshot.items[input.memoryId.trim()]
    if (!item) throw new TaskPoolError('memory_not_found', '团队记忆不存在')
    const reviewer: TeamMessageActor = { type: 'agent', slotId: agent.slotId }
    const completedStatus = input.decision === 'accept' ? 'accepted' : 'rejected'
    if (item.status === completedStatus
      && item.reviewedBy
      && sameTeamMessageActor(item.reviewedBy, reviewer)
      && (item.reviewNote ?? '') === (input.note?.trim() ?? '')) {
      return structuredClone(item)
    }
    if (sameTeamMessageActor(item.proposedBy, reviewer)) {
      throw new TaskPoolError('memory_self_review_forbidden', '记忆提案不能由提出者自行确认')
    }
    if (item.scope === 'project' && agent.roleTemplateKey !== 'reviewer') {
      throw new TaskPoolError('project_memory_requires_reviewer', '项目长期记忆必须由质量验证角色确认')
    }
    return this.repository.review({
      memoryId: item.id,
      decision: input.decision,
      reviewer,
      note: input.note
    })
  }

  private currentAgent() {
    return this.collaboration.resolveAuthorizedAgent(this.identity)
  }
}
