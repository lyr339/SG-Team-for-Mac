import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  StoredRestoreOperation,
  TeamContinuityRepository
} from '../../application/team-continuity-repository'
import type {
  TeamCheckpoint,
  TeamCheckpointCapsule
} from '../../domain/team-continuity'

const SCHEMA_VERSION = 1
const MAX_CAPSULE_BYTES = 512 * 1024
const CHECKPOINT_LIMIT_PER_RUN = 100

type SqliteRow = Record<string, string | number | bigint | null>

function numberOf(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function checkpointFromRow(row: SqliteRow): TeamCheckpoint {
  const capsule = JSON.parse(String(row.capsule_json)) as TeamCheckpointCapsule
  if (capsule.schemaVersion !== 1) throw new Error('团队检查点胶囊版本不兼容')
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    reason: String(row.reason) as TeamCheckpoint['reason'],
    digest: String(row.digest),
    capsule,
    createdAt: numberOf(row.created_at)
  }
}

export class SqliteTeamContinuityRepository implements TeamContinuityRepository {
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
      'SELECT revision FROM team_continuity_meta WHERE id = 1'
    ).get() as SqliteRow
    return numberOf(row.revision)
  }

  listCheckpoints(workspaceId: string, runId: string, limit = 50): TeamCheckpoint[] {
    const normalizedLimit = Math.min(100, Math.max(1, Math.floor(limit)))
    return (this.database.prepare(`
      SELECT * FROM team_checkpoints
      WHERE workspace_id = ? AND run_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(workspaceId.trim(), runId.trim(), normalizedLimit) as SqliteRow[])
      .map(checkpointFromRow)
  }

  saveCheckpoint(input: {
    workspaceId: string
    runId: string
    reason: TeamCheckpoint['reason']
    digest: string
    capsule: TeamCheckpointCapsule
  }): TeamCheckpoint {
    const workspaceId = input.workspaceId.trim()
    const runId = input.runId.trim()
    const digest = input.digest.trim()
    if (!workspaceId || !runId || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('团队检查点标识无效')
    const capsuleJson = JSON.stringify(input.capsule)
    if (Buffer.byteLength(capsuleJson, 'utf8') > MAX_CAPSULE_BYTES) {
      throw new Error('团队恢复胶囊超过 512KB，已停止保存')
    }
    const existing = this.database.prepare(`
      SELECT * FROM team_checkpoints
      WHERE workspace_id = ? AND run_id = ? AND digest = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(workspaceId, runId, digest) as SqliteRow | undefined
    if (existing) return checkpointFromRow(existing)

    const id = `team-checkpoint:${randomUUID()}`
    const now = input.capsule.capturedAt
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        INSERT INTO team_checkpoints (
          id, workspace_id, run_id, reason, digest, capsule_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, workspaceId, runId, input.reason, digest, capsuleJson, now)
      this.bumpRevision(now)
      this.database.prepare(`
        DELETE FROM team_checkpoints
        WHERE run_id = ? AND id NOT IN (
          SELECT id FROM team_checkpoints WHERE run_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?
        ) AND id NOT IN (SELECT checkpoint_id FROM team_restore_operations)
      `).run(runId, runId, CHECKPOINT_LIMIT_PER_RUN)
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
    return this.getCheckpoint(id)!
  }

  getCheckpoint(checkpointId: string): TeamCheckpoint | undefined {
    const row = this.database.prepare(
      'SELECT * FROM team_checkpoints WHERE id = ?'
    ).get(checkpointId.trim()) as SqliteRow | undefined
    return row ? checkpointFromRow(row) : undefined
  }

  beginRestore(input: {
    id: string
    workspaceId: string
    runId: string
    checkpointId: string
    members: Array<{ slotId: string; roleName: string }>
  }): StoredRestoreOperation {
    if (!input.members.length) throw new Error('恢复操作没有团队成员')
    const checkpoint = this.getCheckpoint(input.checkpointId)
    if (!checkpoint || checkpoint.workspaceId !== input.workspaceId || checkpoint.runId !== input.runId) {
      throw new Error('恢复检查点不属于当前 TeamRun')
    }
    const now = Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        INSERT INTO team_restore_operations (
          id, workspace_id, run_id, checkpoint_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'preparing', ?, ?)
      `).run(input.id, input.workspaceId, input.runId, input.checkpointId, now, now)
      const insert = this.database.prepare(`
        INSERT INTO team_restore_members (restore_id, slot_id, role_name, message_id)
        VALUES (?, ?, ?, NULL)
      `)
      for (const member of input.members) insert.run(input.id, member.slotId, member.roleName)
      this.bumpRevision(now)
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
    return this.latestRestore(input.runId)!
  }

  attachRestoreMessage(restoreId: string, slotId: string, messageId: string): void {
    const now = Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const updated = this.database.prepare(`
        UPDATE team_restore_members SET message_id = ?
        WHERE restore_id = ? AND slot_id = ? AND message_id IS NULL
      `).run(messageId, restoreId, slotId)
      if (numberOf(updated.changes) !== 1) throw new Error('恢复成员不存在或已经绑定消息')
      const pending = this.database.prepare(`
        SELECT COUNT(*) AS count FROM team_restore_members
        WHERE restore_id = ? AND message_id IS NULL
      `).get(restoreId) as SqliteRow
      if (numberOf(pending.count) === 0) {
        this.database.prepare(`
          UPDATE team_restore_operations SET status = 'waiting', updated_at = ? WHERE id = ?
        `).run(now, restoreId)
      }
      this.bumpRevision(now)
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  latestRestore(runId: string): StoredRestoreOperation | undefined {
    const row = this.database.prepare(`
      SELECT * FROM team_restore_operations
      WHERE run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(runId.trim()) as SqliteRow | undefined
    if (!row) return undefined
    const members = (this.database.prepare(`
      SELECT slot_id, role_name, message_id FROM team_restore_members
      WHERE restore_id = ? ORDER BY slot_id ASC
    `).all(String(row.id)) as SqliteRow[]).map((member) => ({
      slotId: String(member.slot_id),
      roleName: String(member.role_name),
      messageId: member.message_id ? String(member.message_id) : undefined
    }))
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      runId: String(row.run_id),
      checkpointId: String(row.checkpoint_id),
      status: String(row.status) as StoredRestoreOperation['status'],
      members,
      createdAt: numberOf(row.created_at),
      updatedAt: numberOf(row.updated_at)
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close()
  }

  private bumpRevision(at: number): void {
    this.database.prepare(`
      UPDATE team_continuity_meta SET revision = revision + 1, updated_at = ? WHERE id = 1
    `).run(at)
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS team_continuity_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_checkpoints (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        digest TEXT NOT NULL,
        capsule_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (run_id, digest)
      );

      CREATE TABLE IF NOT EXISTS team_restore_operations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        checkpoint_id TEXT NOT NULL REFERENCES team_checkpoints(id) ON DELETE RESTRICT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_restore_members (
        restore_id TEXT NOT NULL REFERENCES team_restore_operations(id) ON DELETE CASCADE,
        slot_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
        role_name TEXT NOT NULL,
        message_id TEXT REFERENCES team_messages(id) ON DELETE SET NULL,
        PRIMARY KEY (restore_id, slot_id)
      );

      CREATE INDEX IF NOT EXISTS idx_team_checkpoints_run
      ON team_checkpoints(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_team_restore_run
      ON team_restore_operations(run_id, created_at DESC);

      INSERT OR IGNORE INTO team_continuity_meta (
        id, schema_version, revision, updated_at
      ) VALUES (1, ${SCHEMA_VERSION}, 0, 0);
    `)
    const meta = this.database.prepare(
      'SELECT schema_version FROM team_continuity_meta WHERE id = 1'
    ).get() as SqliteRow
    if (numberOf(meta.schema_version) !== SCHEMA_VERSION) {
      throw new Error('团队连续性数据库版本不兼容')
    }
  }
}
