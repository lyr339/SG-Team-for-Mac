import { numberOf, type SqliteRow } from '../sqlite/rows'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { TaskPoolRepository } from '../../application/task-pool-transaction'
import type {
  AgentAuthorizationIdentity,
  AgentRegistrationBatch,
  AgentRegistrationStore
} from '../../application/agent-authorization'
import {
  type AttemptStatus,
  type TaskAttempt,
  type TaskPoolEvent,
  type TaskPoolState,
  type TaskReview,
  type TaskReviewDecision,
  type TaskReviewStatus,
  type TaskStatus,
  type TeamTask
} from '../../domain/task-pool'
import {
  assertAgentRegistrationAuthorized,
  ensureAgentRegistrationsSchema,
  replaceWorkspaceAgentRegistrations
} from '../sqlite/agent-registrations'

const SCHEMA_VERSION = 3

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function stringArrayOf(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('任务池数组字段不是合法 JSON 数组')
  return parsed.map(String).filter(Boolean)
}

function changesOf(result: { changes: number | bigint }): number {
  return typeof result.changes === 'bigint' ? Number(result.changes) : result.changes
}

function tableHasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as SqliteRow[])
    .some((row) => String(row.name) === column)
}

export class SqliteTaskPoolRepository implements TaskPoolRepository, AgentRegistrationStore {
  private readonly database: DatabaseSync
  private readonly insertTask: StatementSync
  private readonly insertAttempt: StatementSync
  private readonly insertReview: StatementSync
  private readonly insertEvent: StatementSync

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path, { timeout: 5_000, defensive: true })
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA synchronous = NORMAL')
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.migrate()

    this.insertTask = this.database.prepare(`
      INSERT INTO tasks (
        id, position, run_id, task_key, title, description, acceptance,
        priority, status, depends_on_json, capabilities_json, max_attempts,
        target_slot_id, attempt_count, progress, assignee_session_id, current_attempt_id,
        current_review_id, result, failure_reason, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `)
    this.insertAttempt = this.database.prepare(`
      INSERT INTO attempts (
        id, task_id, attempt_number, agent_session_id, status, lease_token,
        lease_expires_at, progress, summary, output, error, created_at,
        started_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.insertReview = this.database.prepare(`
      INSERT INTO task_reviews (
        id, position, task_id, attempt_id, status, reviewer_session_id,
        reviewer_slot_id, reviewed_by, lease_count, lease_token, lease_expires_at,
        decision, evidence, reason, created_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.insertEvent = this.database.prepare(`
      INSERT INTO task_events (
        seq, event_type, task_id, attempt_id, agent_session_id, detail, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
  }

  load(): TaskPoolState {
    const meta = this.database.prepare(
      'SELECT schema_version, revision, seq FROM task_pool_meta WHERE id = 1'
    ).get() as SqliteRow | undefined
    if (!meta) throw new Error('任务池数据库缺少 meta 行')

    const taskRows = this.database.prepare('SELECT * FROM tasks ORDER BY position ASC').all() as SqliteRow[]
    const tasks: Record<string, TeamTask> = {}
    const taskOrder: string[] = []
    for (const row of taskRows) {
      const task: TeamTask = {
        id: String(row.id),
        runId: String(row.run_id),
        key: String(row.task_key),
        title: String(row.title),
        description: String(row.description),
        acceptance: String(row.acceptance),
        priority: numberOf(row.priority),
        status: String(row.status) as TaskStatus,
        dependsOn: stringArrayOf(row.depends_on_json),
        requiredCapabilities: stringArrayOf(row.capabilities_json),
        targetSlotId: optionalString(row.target_slot_id),
        maxAttempts: numberOf(row.max_attempts),
        attemptCount: numberOf(row.attempt_count),
        progress: numberOf(row.progress),
        assigneeSessionId: optionalString(row.assignee_session_id),
        currentAttemptId: optionalString(row.current_attempt_id),
        currentReviewId: optionalString(row.current_review_id),
        result: optionalString(row.result),
        failureReason: optionalString(row.failure_reason),
        createdAt: numberOf(row.created_at),
        updatedAt: numberOf(row.updated_at)
      }
      tasks[task.id] = task
      taskOrder.push(task.id)
    }

    const attemptRows = this.database.prepare('SELECT * FROM attempts ORDER BY created_at ASC').all() as SqliteRow[]
    const attempts: Record<string, TaskAttempt> = {}
    for (const row of attemptRows) {
      const attempt: TaskAttempt = {
        id: String(row.id),
        taskId: String(row.task_id),
        number: numberOf(row.attempt_number),
        agentSessionId: String(row.agent_session_id),
        status: String(row.status) as AttemptStatus,
        leaseToken: optionalString(row.lease_token),
        leaseExpiresAt: row.lease_expires_at === null ? undefined : numberOf(row.lease_expires_at),
        progress: numberOf(row.progress),
        summary: String(row.summary),
        output: optionalString(row.output),
        error: optionalString(row.error),
        createdAt: numberOf(row.created_at),
        startedAt: row.started_at === null ? undefined : numberOf(row.started_at),
        completedAt: row.completed_at === null ? undefined : numberOf(row.completed_at),
        updatedAt: numberOf(row.updated_at)
      }
      attempts[attempt.id] = attempt
    }

    const reviewRows = this.database.prepare('SELECT * FROM task_reviews ORDER BY position ASC').all() as SqliteRow[]
    const reviews: Record<string, TaskReview> = {}
    const reviewOrder: string[] = []
    for (const row of reviewRows) {
      const review: TaskReview = {
        id: String(row.id),
        taskId: String(row.task_id),
        attemptId: String(row.attempt_id),
        status: String(row.status) as TaskReviewStatus,
        reviewerSessionId: optionalString(row.reviewer_session_id),
        reviewerSlotId: optionalString(row.reviewer_slot_id),
        reviewedBy: optionalString(row.reviewed_by),
        leaseCount: numberOf(row.lease_count),
        leaseToken: optionalString(row.lease_token),
        leaseExpiresAt: row.lease_expires_at === null ? undefined : numberOf(row.lease_expires_at),
        decision: optionalString(row.decision) as TaskReviewDecision | undefined,
        evidence: String(row.evidence),
        reason: optionalString(row.reason),
        createdAt: numberOf(row.created_at),
        completedAt: row.completed_at === null ? undefined : numberOf(row.completed_at),
        updatedAt: numberOf(row.updated_at)
      }
      reviews[review.id] = review
      reviewOrder.push(review.id)
    }

    const eventRows = this.database.prepare('SELECT * FROM task_events ORDER BY seq ASC').all() as SqliteRow[]
    const events: TaskPoolEvent[] = eventRows.map((row) => ({
      seq: numberOf(row.seq),
      type: String(row.event_type),
      taskId: String(row.task_id),
      attemptId: optionalString(row.attempt_id),
      agentSessionId: optionalString(row.agent_session_id),
      detail: optionalString(row.detail),
      at: numberOf(row.created_at)
    }))

    return {
      schemaVersion: numberOf(meta.schema_version) as 3,
      revision: numberOf(meta.revision),
      seq: numberOf(meta.seq),
      tasks,
      taskOrder,
      attempts,
      reviews,
      reviewOrder,
      events
    }
  }

  compareAndSwap(expectedRevision: number, nextState: TaskPoolState): boolean {
    if (nextState.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`不支持的任务池 schemaVersion：${nextState.schemaVersion}`)
    }
    if (nextState.revision <= expectedRevision) {
      throw new Error('nextState.revision 必须大于 expectedRevision')
    }

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.database.prepare('SELECT revision FROM task_pool_meta WHERE id = 1').get() as SqliteRow
      if (numberOf(current.revision) !== expectedRevision) {
        this.database.exec('ROLLBACK')
        return false
      }

      this.database.exec('DELETE FROM task_events')
      this.database.exec('DELETE FROM task_reviews')
      this.database.exec('DELETE FROM attempts')
      this.database.exec('DELETE FROM tasks')

      nextState.taskOrder.forEach((taskId, position) => {
        const task = nextState.tasks[taskId]
        if (!task) throw new Error(`taskOrder 引用了不存在的任务：${taskId}`)
        this.insertTask.run(
          task.id,
          position,
          task.runId,
          task.key,
          task.title,
          task.description,
          task.acceptance,
          task.priority,
          task.status,
          JSON.stringify(task.dependsOn),
          JSON.stringify(task.requiredCapabilities),
          task.maxAttempts,
          task.targetSlotId ?? null,
          task.attemptCount,
          task.progress,
          task.assigneeSessionId ?? null,
          task.currentAttemptId ?? null,
          task.currentReviewId ?? null,
          task.result ?? null,
          task.failureReason ?? null,
          task.createdAt,
          task.updatedAt
        )
      })

      for (const attempt of Object.values(nextState.attempts)) {
        if (!nextState.tasks[attempt.taskId]) {
          throw new Error(`Attempt ${attempt.id} 引用了不存在的任务：${attempt.taskId}`)
        }
        this.insertAttempt.run(
          attempt.id,
          attempt.taskId,
          attempt.number,
          attempt.agentSessionId,
          attempt.status,
          attempt.leaseToken ?? null,
          attempt.leaseExpiresAt ?? null,
          attempt.progress,
          attempt.summary,
          attempt.output ?? null,
          attempt.error ?? null,
          attempt.createdAt,
          attempt.startedAt ?? null,
          attempt.completedAt ?? null,
          attempt.updatedAt
        )
      }

      nextState.reviewOrder.forEach((reviewId, position) => {
        const review = nextState.reviews[reviewId]
        if (!review) throw new Error(`reviewOrder 引用了不存在的验收：${reviewId}`)
        if (!nextState.tasks[review.taskId]) {
          throw new Error(`Review ${review.id} 引用了不存在的任务：${review.taskId}`)
        }
        if (!nextState.attempts[review.attemptId]) {
          throw new Error(`Review ${review.id} 引用了不存在的 Attempt：${review.attemptId}`)
        }
        this.insertReview.run(
          review.id,
          position,
          review.taskId,
          review.attemptId,
          review.status,
          review.reviewerSessionId ?? null,
          review.reviewerSlotId ?? null,
          review.reviewedBy ?? null,
          review.leaseCount,
          review.leaseToken ?? null,
          review.leaseExpiresAt ?? null,
          review.decision ?? null,
          review.evidence,
          review.reason ?? null,
          review.createdAt,
          review.completedAt ?? null,
          review.updatedAt
        )
      })

      for (const event of nextState.events) {
        this.insertEvent.run(
          event.seq,
          event.type,
          event.taskId,
          event.attemptId ?? null,
          event.agentSessionId ?? null,
          event.detail ?? null,
          event.at
        )
      }

      const updated = this.database.prepare(`
        UPDATE task_pool_meta
        SET schema_version = ?, revision = ?, seq = ?
        WHERE id = 1 AND revision = ?
      `).run(SCHEMA_VERSION, nextState.revision, nextState.seq, expectedRevision)
      if (changesOf(updated) !== 1) throw new Error('任务池 revision CAS 更新失败')
      this.database.exec('COMMIT')
      return true
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  replaceWorkspaceAgentRegistrations(batch: AgentRegistrationBatch): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      replaceWorkspaceAgentRegistrations(this.database, batch)
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  assertAgentAuthorized(identity: AgentAuthorizationIdentity): void {
    assertAgentRegistrationAuthorized(this.database, identity)
  }

  close(): void {
    if (this.database.isOpen) this.database.close()
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_pool_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        seq INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        task_key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptance TEXT NOT NULL,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
        status TEXT NOT NULL,
        depends_on_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        max_attempts INTEGER NOT NULL,
        target_slot_id TEXT,
        attempt_count INTEGER NOT NULL,
        progress INTEGER NOT NULL CHECK (progress BETWEEN 0 AND 100),
        assignee_session_id TEXT,
        current_attempt_id TEXT,
        current_review_id TEXT,
        result TEXT,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (run_id, task_key)
      );

      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        agent_session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_token TEXT,
        lease_expires_at INTEGER,
        progress INTEGER NOT NULL CHECK (progress BETWEEN 0 AND 100),
        summary TEXT NOT NULL,
        output TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        UNIQUE (task_id, attempt_number)
      );

      CREATE TABLE IF NOT EXISTS task_reviews (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        reviewer_session_id TEXT,
        reviewer_slot_id TEXT,
        reviewed_by TEXT,
        lease_count INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_expires_at INTEGER,
        decision TEXT,
        evidence TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_events (
        seq INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_id TEXT,
        agent_session_id TEXT,
        detail TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_attempts_agent_status ON attempts(agent_session_id, status);
      CREATE INDEX IF NOT EXISTS idx_task_reviews_status ON task_reviews(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_reviews_reviewer ON task_reviews(reviewer_session_id, status);
      CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, seq);
      INSERT OR IGNORE INTO task_pool_meta (id, schema_version, revision, seq)
      VALUES (1, ${SCHEMA_VERSION}, 0, 0);
    `)
    ensureAgentRegistrationsSchema(this.database)
    const meta = this.database.prepare('SELECT schema_version FROM task_pool_meta WHERE id = 1').get() as SqliteRow
    let databaseVersion = numberOf(meta.schema_version)
    if (databaseVersion === 1) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        if (!tableHasColumn(this.database, 'tasks', 'target_slot_id')) {
          this.database.exec('ALTER TABLE tasks ADD COLUMN target_slot_id TEXT')
        }
        this.database.prepare(
          'UPDATE task_pool_meta SET schema_version = ? WHERE id = 1'
        ).run(2)
        this.database.exec('COMMIT')
        databaseVersion = 2
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion === 2) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        if (!tableHasColumn(this.database, 'tasks', 'current_review_id')) {
          this.database.exec('ALTER TABLE tasks ADD COLUMN current_review_id TEXT')
        }
        this.database.exec(`
          INSERT OR IGNORE INTO task_reviews (
            id, position, task_id, attempt_id, status, reviewer_session_id,
            reviewer_slot_id, reviewed_by, lease_count, lease_token, lease_expires_at,
            decision, evidence, reason, created_at, completed_at, updated_at
          )
          SELECT
            'review-migrated-' || t.id,
            ROW_NUMBER() OVER (ORDER BY t.created_at, t.id) - 1,
            t.id,
            t.current_attempt_id,
            'queued',
            NULL, NULL, NULL, 0, NULL, NULL, NULL, '', NULL,
            t.updated_at,
            NULL,
            t.updated_at
          FROM tasks t
          JOIN attempts a ON a.id = t.current_attempt_id
          WHERE t.status = 'review' AND a.status = 'review'
        `)
        this.database.exec(`
          UPDATE tasks
          SET current_review_id = 'review-migrated-' || id
          WHERE status = 'review' AND current_attempt_id IS NOT NULL
        `)
        this.database.prepare(
          'UPDATE task_pool_meta SET schema_version = ? WHERE id = 1'
        ).run(SCHEMA_VERSION)
        this.database.exec('COMMIT')
        databaseVersion = SCHEMA_VERSION
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion !== SCHEMA_VERSION) {
      throw new Error(`任务池数据库版本不兼容：${databaseVersion}，当前支持 ${SCHEMA_VERSION}`)
    }
  }
}
