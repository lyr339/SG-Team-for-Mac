import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, normalize } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  TeamMemoryRepository,
  TeamMemorySearchInput
} from '../../application/team-memory-repository'
import type { TeamMessageActor } from '../../domain/team-collaboration'
import type {
  ProposeTeamMemoryInput,
  ReviewTeamMemoryInput,
  TeamMemoryEvent,
  TeamMemoryItem,
  TeamMemoryKind,
  TeamMemoryScope,
  TeamMemorySnapshot,
  TeamMemorySource,
  TeamMemorySourceType,
  TeamMemoryStatus
} from '../../domain/team-memory'
import { TaskPoolError } from '../../domain/task-pool'

const SCHEMA_VERSION = 1
const EVENT_LIMIT = 2_000
const CLIENT_PROPOSAL_ID = /^[a-zA-Z0-9:_-]{8,200}$/
const MEMORY_KINDS = new Set<TeamMemoryKind>(['decision', 'constraint', 'fact', 'risk', 'lesson'])
const MEMORY_SCOPES = new Set<TeamMemoryScope>(['run', 'project'])
const MEMORY_STATUSES = new Set<TeamMemoryStatus>(['proposed', 'accepted', 'superseded', 'rejected'])
const SOURCE_TYPES = new Set<TeamMemorySourceType>(['message', 'task', 'file'])

type SqliteRow = Record<string, string | number | bigint | null>

function numberOf(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : numberOf(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function actorKey(actor: TeamMessageActor): string {
  return actor.type === 'operator' ? 'operator' : `agent:${actor.slotId}`
}

function actorOf(value: unknown): TeamMessageActor {
  const key = String(value ?? '')
  if (key === 'operator') return { type: 'operator' }
  if (key.startsWith('agent:') && key.length > 6) return { type: 'agent', slotId: key.slice(6) }
  throw new Error(`团队记忆包含无效 Actor：${key}`)
}

function normalizedText(value: string, field: string, maxLength: number): string {
  const text = value.replace(/\r\n/g, '\n').trim()
  if (!text) throw new Error(`${field}不能为空`)
  if (text.length > maxLength) throw new Error(`${field}不能超过 ${maxLength} 个字符`)
  return text
}

export class SqliteTeamMemoryRepository implements TeamMemoryRepository {
  private readonly database: DatabaseSync

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path, { timeout: 5_000, defensive: true })
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA synchronous = NORMAL')
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  revision(): number {
    const row = this.database.prepare(
      'SELECT revision FROM team_memory_meta WHERE id = 1'
    ).get() as SqliteRow
    return numberOf(row.revision)
  }

  load(workspaceId: string, runId: string): TeamMemorySnapshot {
    const normalizedWorkspaceId = workspaceId.trim()
    const normalizedRunId = runId.trim()
    const meta = this.database.prepare(
      'SELECT revision, seq, updated_at FROM team_memory_meta WHERE id = 1'
    ).get() as SqliteRow
    const rows = this.database.prepare(`
      SELECT * FROM team_memory_items
      WHERE workspace_id = ? AND (scope = 'project' OR run_id = ?)
      ORDER BY updated_at DESC, id ASC
    `).all(normalizedWorkspaceId, normalizedRunId) as SqliteRow[]
    const items: Record<string, TeamMemoryItem> = {}
    const itemOrder: string[] = []
    for (const row of rows) {
      const item = this.itemFromRow(row)
      items[item.id] = item
      itemOrder.push(item.id)
    }
    const events = (this.database.prepare(`
      SELECT * FROM team_memory_events
      WHERE workspace_id = ? AND (run_id = ? OR memory_id IN (
        SELECT id FROM team_memory_items WHERE workspace_id = ? AND scope = 'project'
      ))
      ORDER BY seq DESC LIMIT 500
    `).all(normalizedWorkspaceId, normalizedRunId, normalizedWorkspaceId) as SqliteRow[])
      .reverse()
      .map((row): TeamMemoryEvent => ({
        seq: numberOf(row.seq),
        type: String(row.event_type),
        workspaceId: String(row.workspace_id),
        runId: String(row.run_id),
        memoryId: String(row.memory_id),
        actor: actorOf(row.actor_key),
        detail: optionalString(row.detail),
        at: numberOf(row.created_at)
      }))
    return {
      schemaVersion: 1,
      revision: numberOf(meta.revision),
      seq: numberOf(meta.seq),
      workspaceId: normalizedWorkspaceId,
      runId: normalizedRunId,
      items,
      itemOrder,
      events,
      updatedAt: numberOf(meta.updated_at)
    }
  }

  search(input: TeamMemorySearchInput): TeamMemoryItem[] {
    const query = input.query?.trim().toLocaleLowerCase('zh-CN') ?? ''
    const kinds = new Set((input.kinds ?? []).filter((kind) => MEMORY_KINDS.has(kind)))
    const requestedStatuses: TeamMemoryStatus[] = input.statuses?.length ? input.statuses : ['accepted']
    const statuses = new Set(requestedStatuses
      .filter((status) => MEMORY_STATUSES.has(status)))
    const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 20)))
    const snapshot = this.load(input.workspaceId, input.runId)
    return snapshot.itemOrder
      .map((id) => snapshot.items[id])
      .filter((item): item is TeamMemoryItem => Boolean(item))
      .filter((item) => kinds.size === 0 || kinds.has(item.kind))
      .filter((item) => statuses.has(item.status))
      .filter((item) => !query || `${item.title}\n${item.content}`.toLocaleLowerCase('zh-CN').includes(query))
      .slice(0, limit)
  }

  propose(input: ProposeTeamMemoryInput): TeamMemoryItem {
    const workspaceId = normalizedText(input.workspaceId, 'workspaceId', 200)
    const runId = normalizedText(input.runId, 'runId', 200)
    const title = normalizedText(input.title, '记忆标题', 200)
    const content = normalizedText(input.content, '记忆正文', 20_000)
    const clientProposalId = input.clientProposalId.trim()
    if (!CLIENT_PROPOSAL_ID.test(clientProposalId)) throw new Error('clientProposalId 无效')
    if (!MEMORY_SCOPES.has(input.scope)) throw new Error('记忆范围无效')
    if (!MEMORY_KINDS.has(input.kind)) throw new Error('记忆类型无效')
    this.assertRun(workspaceId, runId)
    this.assertActor(runId, input.proposedBy)
    const sources = this.normalizedSources(input.sources, runId)

    const duplicate = this.database.prepare(`
      SELECT * FROM team_memory_items
      WHERE workspace_id = ? AND proposed_by_key = ? AND client_proposal_id = ?
    `).get(workspaceId, actorKey(input.proposedBy), clientProposalId) as SqliteRow | undefined
    if (duplicate) return this.itemFromRow(duplicate)

    let version = 1
    let supersedesId: string | undefined
    if (input.supersedesId?.trim()) {
      const previous = this.requireItem(input.supersedesId.trim())
      if (previous.workspaceId !== workspaceId || previous.scope !== input.scope || previous.kind !== input.kind) {
        throw new Error('修订只能取代同工作区、同范围、同类型的记忆')
      }
      if (previous.status !== 'accepted' || previous.supersededById) {
        throw new Error('只能修订当前已采纳且未被取代的记忆')
      }
      supersedesId = previous.id
      version = previous.version + 1
    }

    const id = `team-memory:${randomUUID()}`
    const now = Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        INSERT INTO team_memory_items (
          id, workspace_id, run_id, scope, kind, title, content, status,
          version, proposed_by_key, reviewed_by_key, review_note, accepted_at,
          supersedes_id, superseded_by_id, client_proposal_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, NULL, '', NULL, ?, NULL, ?, ?, ?)
      `).run(
        id,
        workspaceId,
        runId,
        input.scope,
        input.kind,
        title,
        content,
        version,
        actorKey(input.proposedBy),
        supersedesId ?? null,
        clientProposalId,
        now,
        now
      )
      const insertSource = this.database.prepare(`
        INSERT INTO team_memory_sources (memory_id, position, source_type, source_ref, label)
        VALUES (?, ?, ?, ?, ?)
      `)
      sources.forEach((source, index) => {
        insertSource.run(id, index, source.type, source.ref, source.label)
      })
      this.appendEvent({
        type: 'memory.proposed',
        workspaceId,
        runId,
        memoryId: id,
        actor: input.proposedBy,
        detail: input.kind,
        at: now
      })
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
    return this.requireItem(id)
  }

  review(input: ReviewTeamMemoryInput): TeamMemoryItem {
    const item = this.requireItem(input.memoryId)
    if (item.status !== 'proposed') throw new TaskPoolError('memory_not_proposed', '只有待确认记忆可以审核')
    this.assertActor(item.runId, input.reviewer)
    const now = Date.now()
    const note = input.note?.trim().slice(0, 4_000) ?? ''
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (input.decision === 'accept') {
        if (item.supersedesId) {
          const previous = this.requireItem(item.supersedesId)
          if (previous.status !== 'accepted' || previous.supersededById) {
            throw new Error('待取代记忆的状态已经变化，请重新审查')
          }
          this.database.prepare(`
            UPDATE team_memory_items
            SET status = 'superseded', superseded_by_id = ?, updated_at = ?
            WHERE id = ?
          `).run(item.id, now, previous.id)
        }
        this.database.prepare(`
          UPDATE team_memory_items
          SET status = 'accepted', reviewed_by_key = ?, review_note = ?,
              accepted_at = ?, updated_at = ?
          WHERE id = ?
        `).run(actorKey(input.reviewer), note, now, now, item.id)
      } else if (input.decision === 'reject') {
        this.database.prepare(`
          UPDATE team_memory_items
          SET status = 'rejected', reviewed_by_key = ?, review_note = ?, updated_at = ?
          WHERE id = ?
        `).run(actorKey(input.reviewer), note, now, item.id)
      } else {
        throw new Error('记忆审核决定无效')
      }
      this.appendEvent({
        type: input.decision === 'accept' ? 'memory.accepted' : 'memory.rejected',
        workspaceId: item.workspaceId,
        runId: item.runId,
        memoryId: item.id,
        actor: input.reviewer,
        detail: note,
        at: now
      })
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
    return this.requireItem(item.id)
  }

  close(): void {
    if (this.database.isOpen) this.database.close()
  }

  private itemFromRow(row: SqliteRow): TeamMemoryItem {
    const id = String(row.id)
    const sources = (this.database.prepare(`
      SELECT source_type, source_ref, label FROM team_memory_sources
      WHERE memory_id = ? ORDER BY position ASC
    `).all(id) as SqliteRow[]).map((source): TeamMemorySource => ({
      type: String(source.source_type) as TeamMemorySourceType,
      ref: String(source.source_ref),
      label: String(source.label)
    }))
    return {
      id,
      workspaceId: String(row.workspace_id),
      runId: String(row.run_id),
      scope: String(row.scope) as TeamMemoryScope,
      kind: String(row.kind) as TeamMemoryKind,
      title: String(row.title),
      content: String(row.content),
      status: String(row.status) as TeamMemoryStatus,
      version: numberOf(row.version),
      proposedBy: actorOf(row.proposed_by_key),
      reviewedBy: optionalString(row.reviewed_by_key) ? actorOf(row.reviewed_by_key) : undefined,
      reviewNote: optionalString(row.review_note),
      acceptedAt: optionalNumber(row.accepted_at),
      supersedesId: optionalString(row.supersedes_id),
      supersededById: optionalString(row.superseded_by_id),
      sources,
      createdAt: numberOf(row.created_at),
      updatedAt: numberOf(row.updated_at)
    }
  }

  private requireItem(memoryId: string): TeamMemoryItem {
    const row = this.database.prepare(
      'SELECT * FROM team_memory_items WHERE id = ?'
    ).get(memoryId.trim()) as SqliteRow | undefined
    if (!row) throw new TaskPoolError('memory_not_found', '团队记忆不存在')
    return this.itemFromRow(row)
  }

  private normalizedSources(values: TeamMemorySource[], runId: string): TeamMemorySource[] {
    if (!Array.isArray(values) || values.length < 1 || values.length > 20) {
      throw new Error('团队记忆必须包含 1 到 20 个来源')
    }
    const unique = new Map<string, TeamMemorySource>()
    for (const source of values) {
      if (!SOURCE_TYPES.has(source.type)) throw new Error('记忆来源类型无效')
      const ref = normalizedText(source.ref, '来源引用', 2_000)
      const label = normalizedText(source.label, '来源标签', 240)
      if (source.type === 'message') {
        const row = this.database.prepare(
          'SELECT id FROM team_messages WHERE id = ? AND run_id = ?'
        ).get(ref, runId)
        if (!row) throw new Error('引用的团队消息不属于当前 TeamRun')
      }
      if (source.type === 'task') {
        const row = this.database.prepare(
          'SELECT id FROM tasks WHERE id = ? AND run_id = ?'
        ).get(ref, runId)
        if (!row) throw new Error('引用的任务不属于当前 TeamRun')
      }
      if (source.type === 'file') {
        const normalized = normalize(ref)
        if (isAbsolute(ref) || normalized === '..' || /^\.\.[\\/]/.test(normalized)) {
          throw new Error('文件来源必须是工作区内相对路径')
        }
      }
      unique.set(`${source.type}:${ref}`, { type: source.type, ref, label })
    }
    return [...unique.values()]
  }

  private assertRun(workspaceId: string, runId: string): void {
    const row = this.database.prepare(
      'SELECT id FROM team_runs WHERE id = ? AND workspace_id = ?'
    ).get(runId, workspaceId)
    if (!row) throw new Error('TeamRun 与工作区不匹配')
  }

  private assertActor(runId: string, actor: TeamMessageActor): void {
    if (actor.type === 'operator') return
    const row = this.database.prepare(
      'SELECT id FROM agent_slots WHERE id = ? AND run_id = ?'
    ).get(actor.slotId, runId)
    if (!row) throw new Error('记忆 Actor 不属于当前 TeamRun')
  }

  private appendEvent(input: {
    type: string
    workspaceId: string
    runId: string
    memoryId: string
    actor: TeamMessageActor
    detail?: string
    at: number
  }): void {
    const meta = this.database.prepare('SELECT seq FROM team_memory_meta WHERE id = 1').get() as SqliteRow
    const seq = numberOf(meta.seq) + 1
    this.database.prepare(`
      INSERT INTO team_memory_events (
        seq, event_type, workspace_id, run_id, memory_id, actor_key, detail, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      seq,
      input.type,
      input.workspaceId,
      input.runId,
      input.memoryId,
      actorKey(input.actor),
      input.detail?.trim().slice(0, 2_000) ?? null,
      input.at
    )
    this.database.prepare(`
      UPDATE team_memory_meta
      SET revision = revision + 1, seq = ?, updated_at = ? WHERE id = 1
    `).run(seq, input.at)
    this.database.prepare(`
      DELETE FROM team_memory_events
      WHERE seq <= (SELECT MAX(seq) - ? FROM team_memory_events)
    `).run(EVENT_LIMIT)
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS team_memory_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_memory_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        proposed_by_key TEXT NOT NULL,
        reviewed_by_key TEXT,
        review_note TEXT NOT NULL,
        accepted_at INTEGER,
        supersedes_id TEXT REFERENCES team_memory_items(id) ON DELETE RESTRICT,
        superseded_by_id TEXT REFERENCES team_memory_items(id) ON DELETE SET NULL,
        client_proposal_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (workspace_id, proposed_by_key, client_proposal_id)
      );

      CREATE TABLE IF NOT EXISTS team_memory_sources (
        memory_id TEXT NOT NULL REFERENCES team_memory_items(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        label TEXT NOT NULL,
        PRIMARY KEY (memory_id, position),
        UNIQUE (memory_id, source_type, source_ref)
      );

      CREATE TABLE IF NOT EXISTS team_memory_events (
        seq INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        actor_key TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_team_memory_scope_status
      ON team_memory_items(workspace_id, scope, run_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_team_memory_kind
      ON team_memory_items(workspace_id, kind, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_team_memory_events_workspace
      ON team_memory_events(workspace_id, seq);

      INSERT OR IGNORE INTO team_memory_meta (
        id, schema_version, revision, seq, updated_at
      ) VALUES (1, ${SCHEMA_VERSION}, 0, 0, 0);
    `)
    const meta = this.database.prepare(
      'SELECT schema_version FROM team_memory_meta WHERE id = 1'
    ).get() as SqliteRow
    const version = numberOf(meta.schema_version)
    if (version !== SCHEMA_VERSION) {
      throw new Error(`团队记忆数据库版本不兼容：${version}，当前支持 ${SCHEMA_VERSION}`)
    }
  }
}
