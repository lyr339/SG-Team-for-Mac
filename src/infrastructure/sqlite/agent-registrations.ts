import { DatabaseSync } from 'node:sqlite'
import type {
  AgentAuthorizationIdentity,
  AgentRegistrationBatch
} from '../../application/agent-authorization'
import { TaskPoolError } from '../../domain/task-pool'

type SqliteRow = Record<string, string | number | bigint | null>

function stringArrayOf(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('Agent 能力字段不是合法 JSON 数组')
  return parsed.map(String).filter(Boolean)
}

function normalizedCapabilities(values: string[]): string[] {
  const capabilities = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()
  if (capabilities.length > 32 || capabilities.some((value) => value.length > 80)) {
    throw new Error('Agent 能力配置超出限制')
  }
  return capabilities
}

export function ensureAgentRegistrationsSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_registrations (
      agent_session_id TEXT PRIMARY KEY,
      runtime_id TEXT,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      run_id TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      installed_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_registrations_active_channel
    ON agent_registrations(workspace_id, channel_id)
    WHERE revoked_at IS NULL;
  `)
  const columns = database.prepare('PRAGMA table_info(agent_registrations)').all() as SqliteRow[]
  if (!columns.some((column) => String(column.name) === 'runtime_id')) {
    database.exec('ALTER TABLE agent_registrations ADD COLUMN runtime_id TEXT')
  }
  database.exec(`
    UPDATE agent_registrations
    SET runtime_id = workspace_id || ':ch-' || channel_id
    WHERE runtime_id IS NULL OR length(trim(runtime_id)) = 0;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_registrations_active_runtime
    ON agent_registrations(runtime_id) WHERE revoked_at IS NULL;
  `)
}

/**
 * Mutates registrations inside the caller's transaction. Keeping transaction
 * ownership outside lets Team installation update authorization and runtime
 * bindings atomically.
 */
export function replaceWorkspaceAgentRegistrations(
  database: DatabaseSync,
  batch: AgentRegistrationBatch,
  installedAt = Date.now()
): void {
  const workspaceId = batch.workspaceId.trim()
  const generation = batch.generation.trim()
  const runId = batch.runId.trim()
  if (!workspaceId || !generation || !runId) throw new Error('Agent 注册批次字段不能为空')
  if (!batch.agents.length) throw new Error('Agent 注册批次不能为空')

  const normalizedAgents = batch.agents.map((agent) => {
    const channelId = String(agent.channelId).trim()
    if (
      agent.workspaceId !== workspaceId ||
      agent.generation !== generation ||
      agent.runId !== runId
    ) {
      throw new Error('Agent 注册与批次不一致')
    }
    if (!/^\d+$/.test(channelId)) throw new Error(`Agent 通道号无效：${agent.channelId}`)
    const agentSessionId = agent.agentSessionId.trim()
    if (agentSessionId !== `${workspaceId}:ch-${channelId}:${generation}`) {
      throw new Error('AgentSessionId 与工作区、通道或 generation 不一致')
    }
    const runtimeId = agent.runtimeId?.trim() || `${workspaceId}:ch-${channelId}`
    if (runtimeId !== `${workspaceId}:ch-${channelId}`) {
      throw new Error('RuntimeId 与工作区或通道不一致')
    }
    return {
      ...agent,
      agentSessionId,
      runtimeId,
      channelId,
      capabilities: normalizedCapabilities(agent.capabilities)
    }
  })
  if (new Set(normalizedAgents.map((agent) => agent.channelId)).size !== normalizedAgents.length) {
    throw new Error('Agent 注册批次包含重复通道')
  }
  if (new Set(normalizedAgents.map((agent) => agent.agentSessionId)).size !== normalizedAgents.length) {
    throw new Error('Agent 注册批次包含重复 AgentSession')
  }

  database.prepare(`
    UPDATE agent_registrations
    SET revoked_at = ?
    WHERE workspace_id = ? AND revoked_at IS NULL
  `).run(installedAt, workspaceId)
  const insert = database.prepare(`
    INSERT INTO agent_registrations (
      agent_session_id, runtime_id, workspace_id, channel_id, generation, run_id,
      capabilities_json, installed_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(agent_session_id) DO UPDATE SET
      runtime_id = excluded.runtime_id,
      workspace_id = excluded.workspace_id,
      channel_id = excluded.channel_id,
      generation = excluded.generation,
      run_id = excluded.run_id,
      capabilities_json = excluded.capabilities_json,
      installed_at = excluded.installed_at,
      revoked_at = NULL
  `)
  for (const agent of normalizedAgents) {
    insert.run(
      agent.agentSessionId.trim(),
      agent.runtimeId,
      workspaceId,
      agent.channelId,
      generation,
      runId,
      JSON.stringify(agent.capabilities),
      installedAt
    )
  }
}

export function revokeWorkspaceAgentRegistrations(
  database: DatabaseSync,
  workspaceId: string,
  revokedAt = Date.now()
): void {
  database.prepare(`
    UPDATE agent_registrations
    SET revoked_at = ?
    WHERE workspace_id = ? AND revoked_at IS NULL
  `).run(revokedAt, workspaceId.trim())
}

export function assertAgentRegistrationAuthorized(
  database: DatabaseSync,
  identity: AgentAuthorizationIdentity
): void {
  const row = database.prepare(`
    SELECT run_id, capabilities_json
    FROM agent_registrations
    WHERE agent_session_id = ? AND revoked_at IS NULL
  `).get(identity.agentSessionId) as SqliteRow | undefined
  if (!row || String(row.run_id) !== identity.runId) {
    throw new TaskPoolError('agent_not_authorized', '当前 Agent generation 未注册或已被撤销')
  }
  const allowed = new Set(stringArrayOf(row.capabilities_json))
  if (identity.capabilities.some((capability) => !allowed.has(capability))) {
    throw new TaskPoolError('agent_capability_mismatch', '当前 Agent 请求了未注册的能力')
  }
}
