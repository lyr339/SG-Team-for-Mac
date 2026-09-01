import { numberOf, type SqliteRow } from '../sqlite/rows'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type {
  AgentAuthorizationIdentity,
  AgentRegistration,
  AgentRegistrationBatch
} from '../../application/agent-authorization'
import type { AgentCheckInReceipt } from '../../application/agent-presence'
import type { TeamControlRepository } from '../../application/team-control-repository'
import type {
  AgentSlot,
  RuntimeBinding,
  TeamControlState,
  TeamRole,
  TeamRoleAccent,
  TeamRun,
  TeamRunStatus,
  TeamWorkspace,
  WorkspaceTeamBundle
} from '../../domain/team-control'
import type { AssignedAgentSkill } from '../../domain/agent-skill'
import type { CursorModelSelection } from '../../domain/cursor-model'
import { TaskPoolError } from '../../domain/task-pool'
import type { ComposerBindingMethod } from '../../domain/cursor-telemetry'
import type {
  TeamFailoverRebindResult,
  TeamFailoverRecord,
  TeamFailoverStatus
} from '../../domain/team-failover'
import {
  ensureAgentRegistrationsSchema,
  replaceWorkspaceAgentRegistrations,
  revokeWorkspaceAgentRegistrations
} from '../sqlite/agent-registrations'

const TEAM_SCHEMA_VERSION = 7
const COMPOSER_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/
const COMPOSER_BINDING_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
const COMPOSER_BINDING_METHODS = new Set<ComposerBindingMethod>(['launch_marker', 'channel_marker'])

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : numberOf(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function stringArrayOf(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('团队能力字段不是合法 JSON 数组')
  return parsed.map(String).filter(Boolean)
}

function effectiveCapabilities(row: SqliteRow): string[] {
  const base = new Set(stringArrayOf(row.capabilities_json))
  const lead = new Set(stringArrayOf(row.lead_capabilities_json))
  const slotId = String(row.slot_id)
  const actingLeadSlotId = optionalString(row.acting_lead_slot_id)
  const templateKey = String(row.template_key ?? '')
  if (actingLeadSlotId) {
    if (slotId === actingLeadSlotId) {
      for (const capability of lead) base.add(capability)
    } else if (templateKey === 'lead') {
      for (const capability of lead) base.delete(capability)
    }
  }
  return [...base]
}

function assignedSkillsOf(value: unknown): AssignedAgentSkill[] {
  if (typeof value !== 'string' || !value) return []
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('团队技能字段不是合法 JSON 数组')
  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return []
    const scope = raw.scope === 'project' || raw.scope === 'user' ? raw.scope : 'builtin'
    return [{
      id: raw.id,
      name: raw.name,
      description: typeof raw.description === 'string' ? raw.description : '',
      scope
    }]
  })
}

function cursorModelSelectionOf(value: unknown): CursorModelSelection | undefined {
  if (typeof value !== 'string' || !value) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return undefined }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const raw = parsed as Record<string, unknown>
  if (typeof raw.modelId !== 'string' || !raw.modelId.trim() || raw.modelId.length > 160) return undefined
  const displayName = typeof raw.displayName === 'string' && raw.displayName.trim()
    ? raw.displayName.trim().slice(0, 160)
    : raw.modelId.trim()
  const parameters = Array.isArray(raw.parameters) ? raw.parameters.slice(0, 32).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const parameter = item as Record<string, unknown>
    return typeof parameter.id === 'string' && parameter.id.trim()
      && typeof parameter.value === 'string' && parameter.value.length <= 160
      ? [{ id: parameter.id.trim().slice(0, 80), value: parameter.value }]
      : []
  }) : []
  return {
    modelId: raw.modelId.trim(),
    displayName,
    parameters,
    maxMode: raw.maxMode === true
  }
}

function tableHasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as SqliteRow[])
    .some((row) => String(row.name) === column)
}

function normalizedNote(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 2_000)
}

function failoverFromRow(row: SqliteRow): TeamFailoverRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    slotId: String(row.slot_id),
    roleName: String(row.role_name),
    fromChannelId: String(row.from_channel_id),
    fromAgentSessionId: String(row.from_agent_session_id),
    toChannelId: optionalString(row.to_channel_id),
    toAgentSessionId: optionalString(row.to_agent_session_id),
    status: String(row.status) as TeamFailoverStatus,
    reason: String(row.reason),
    checkpointId: optionalString(row.checkpoint_id),
    messageId: optionalString(row.message_id),
    taskIds: stringArrayOf(row.task_ids_json),
    detectedAt: numberOf(row.detected_at),
    updatedAt: numberOf(row.updated_at),
    completedAt: optionalNumber(row.completed_at)
  }
}

export class SqliteTeamControlRepository implements TeamControlRepository {
  private readonly database: DatabaseSync
  private readonly revisionStatement: StatementSync

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path, { timeout: 5_000, defensive: true })
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA synchronous = NORMAL')
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
    this.revisionStatement = this.database.prepare(
      'SELECT revision FROM team_control_meta WHERE id = 1'
    )
  }

  revision(): number {
    const row = this.revisionStatement.get() as SqliteRow | undefined
    if (!row) throw new Error('团队控制数据库缺少 meta 行')
    return numberOf(row.revision)
  }

  loadTeamControl(): TeamControlState {
    const meta = this.database.prepare(
      'SELECT schema_version, revision, active_workspace_id, updated_at FROM team_control_meta WHERE id = 1'
    ).get() as SqliteRow | undefined
    if (!meta) throw new Error('团队控制数据库缺少 meta 行')

    const workspaces = (this.database.prepare(
      'SELECT * FROM team_workspaces ORDER BY updated_at DESC, id ASC'
    ).all() as SqliteRow[]).map((row): TeamWorkspace => ({
      id: String(row.id),
      name: String(row.name),
      path: String(row.path),
      createdAt: numberOf(row.created_at),
      updatedAt: numberOf(row.updated_at)
    }))

    const runs = (this.database.prepare(
      'SELECT * FROM team_runs ORDER BY created_at ASC, id ASC'
    ).all() as SqliteRow[]).map((row): TeamRun => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      goal: String(row.goal),
      templateId: String(row.template_id),
      status: String(row.status) as TeamRunStatus,
      createdAt: numberOf(row.created_at),
      updatedAt: numberOf(row.updated_at),
      launchedAt: optionalNumber(row.launched_at),
      actingLeadSlotId: optionalString(row.acting_lead_slot_id)
    }))

    const roles = (this.database.prepare(
      'SELECT * FROM team_roles ORDER BY role_order ASC, id ASC'
    ).all() as SqliteRow[]).map((row): TeamRole => ({
      id: String(row.id),
      runId: String(row.run_id),
      key: String(row.role_key),
      templateKey: String(row.template_key),
      name: String(row.name),
      mission: String(row.mission),
      instructions: String(row.instructions),
      capabilities: stringArrayOf(row.capabilities_json),
      skills: assignedSkillsOf(row.skills_json),
      accent: String(row.accent) as TeamRoleAccent,
      order: numberOf(row.role_order)
    }))

    const modelSelectionBySlot = new Map((this.database.prepare(
      'SELECT slot_id, selection_json FROM agent_slot_model_selections'
    ).all() as SqliteRow[]).flatMap((row) => {
      const selection = cursorModelSelectionOf(row.selection_json)
      return selection ? [[String(row.slot_id), selection] as const] : []
    }))
    const slots = (this.database.prepare(
      'SELECT * FROM agent_slots ORDER BY slot_order ASC, id ASC'
    ).all() as SqliteRow[]).map((row): AgentSlot => ({
      id: String(row.id),
      runId: String(row.run_id),
      roleId: String(row.role_id),
      name: String(row.name),
      avatarId: String(row.avatar_id),
      modelSelection: modelSelectionBySlot.get(String(row.id)),
      solo: numberOf(row.is_solo) === 1,
      channelId: optionalString(row.channel_id),
      order: numberOf(row.slot_order),
      createdAt: numberOf(row.created_at),
      updatedAt: numberOf(row.updated_at)
    }))

    const bindings = (this.database.prepare(
      'SELECT * FROM runtime_bindings ORDER BY installed_at ASC, id ASC'
    ).all() as SqliteRow[]).map((row): RuntimeBinding => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      runId: String(row.run_id),
      slotId: String(row.slot_id),
      channelId: String(row.channel_id),
      agentSessionId: String(row.agent_session_id),
      generation: String(row.generation),
      installedAt: numberOf(row.installed_at),
      launchStatus: String(row.launch_status) as RuntimeBinding['launchStatus'],
      launchCommandId: optionalString(row.launch_command_id),
      launchDetail: String(row.launch_detail),
      acknowledgedAt: optionalNumber(row.acknowledged_at),
      lastCheckInAt: optionalNumber(row.last_check_in_at),
      lastCheckInNote: String(row.last_check_in_note),
      composerBindingKey: optionalString(row.composer_binding_key) ?? String(row.generation),
      composerId: optionalString(row.composer_id),
      composerBoundAt: optionalNumber(row.composer_bound_at),
      composerBindingMethod: optionalString(row.composer_binding_method) as RuntimeBinding['composerBindingMethod']
    }))

    return {
      schemaVersion: numberOf(meta.schema_version) as 7,
      revision: numberOf(meta.revision),
      activeWorkspaceId: optionalString(meta.active_workspace_id),
      workspaces,
      runs,
      roles,
      slots,
      bindings,
      updatedAt: numberOf(meta.updated_at)
    }
  }

  /** 单槽模型选定持久化：lobby 逐会话配置的保存出口；slot_id 幂等 upsert。 */
  setSlotModelSelection(slotId: string, selection: CursorModelSelection, updatedAt = Date.now()): void {
    this.database.prepare(`
      INSERT INTO agent_slot_model_selections (slot_id, selection_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(slot_id) DO UPDATE SET
        selection_json = excluded.selection_json,
        updated_at = excluded.updated_at
    `).run(slotId, JSON.stringify(selection), updatedAt)
    this.bumpRevision()
  }

  upsertWorkspaceTeam(bundle: WorkspaceTeamBundle): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const { workspace, run } = bundle
      const existingSlots = this.database.prepare(`
        SELECT s.id, s.channel_id, s.avatar_id, s.is_solo, r.template_key, r.capabilities_json, r.skills_json,
          ms.selection_json AS model_selection_json
        FROM agent_slots s
        JOIN team_roles r ON r.id = s.role_id
        LEFT JOIN agent_slot_model_selections ms ON ms.slot_id = s.id
        WHERE s.run_id = ? ORDER BY s.slot_order ASC
      `).all(run.id) as SqliteRow[]
      const desiredTopology = new Map(bundle.slots.map((slot) => {
        const role = bundle.roles.find((candidate) => candidate.id === slot.roleId)!
        return [slot.id, {
          channelId: slot.channelId ?? null,
          avatarId: slot.avatarId,
          templateKey: role.templateKey,
          capabilities: JSON.stringify(role.capabilities),
          skills: JSON.stringify(role.skills),
          modelSelection: slot.modelSelection ? JSON.stringify(slot.modelSelection) : null,
          solo: slot.solo === true ? 1 : 0
        }] as const
      }))
      const topologyChanged = existingSlots.length > 0 && (
        existingSlots.length !== bundle.slots.length ||
        existingSlots.some((slot) => {
          const desired = desiredTopology.get(String(slot.id))
          return !desired
            || desired.channelId !== slot.channel_id
            || desired.avatarId !== String(slot.avatar_id)
            || desired.templateKey !== String(slot.template_key)
            || desired.capabilities !== String(slot.capabilities_json)
            || desired.skills !== String(slot.skills_json)
            || desired.modelSelection !== slot.model_selection_json
            || desired.solo !== numberOf(slot.is_solo)
        })
      )
      this.database.prepare(`
        INSERT INTO team_workspaces (id, name, path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          path = excluded.path,
          updated_at = excluded.updated_at
      `).run(workspace.id, workspace.name, workspace.path, workspace.createdAt, workspace.updatedAt)
      this.database.prepare(`
        INSERT OR IGNORE INTO team_runs (
          id, workspace_id, name, goal, template_id, status, created_at, updated_at, launched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        run.id,
        run.workspaceId,
        run.name,
        run.goal,
        run.templateId,
        run.status,
        run.createdAt,
        run.updatedAt
      )

      const insertRole = this.database.prepare(`
        INSERT INTO team_roles (
          id, run_id, role_key, template_key, name, mission, instructions,
          capabilities_json, skills_json, accent, role_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          role_key = excluded.role_key,
          template_key = excluded.template_key,
          name = excluded.name,
          mission = excluded.mission,
          instructions = excluded.instructions,
          capabilities_json = excluded.capabilities_json,
          skills_json = excluded.skills_json,
          accent = excluded.accent,
          role_order = excluded.role_order
      `)
      for (const role of bundle.roles) {
        insertRole.run(
          role.id,
          role.runId,
          role.key,
          role.templateKey,
          role.name,
          role.mission,
          role.instructions,
          JSON.stringify(role.capabilities),
          JSON.stringify(role.skills),
          role.accent,
          role.order
        )
      }

      if (topologyChanged) {
        this.database.prepare('DELETE FROM runtime_bindings WHERE run_id = ?').run(run.id)
        revokeWorkspaceAgentRegistrations(this.database, workspace.id)
        this.database.prepare(`
          UPDATE team_runs SET status = 'draft', launched_at = NULL, updated_at = ? WHERE id = ?
        `).run(Date.now(), run.id)
      }

      const slotIds = bundle.slots.map((slot) => slot.id)
      const slotPlaceholders = slotIds.map(() => '?').join(', ')
      this.database.prepare(`
        DELETE FROM agent_slots WHERE run_id = ? AND id NOT IN (${slotPlaceholders})
      `).run(run.id, ...slotIds)
      this.database.prepare('UPDATE agent_slots SET channel_id = NULL WHERE run_id = ?').run(run.id)

      const insertSlot = this.database.prepare(`
        INSERT INTO agent_slots (
          id, run_id, role_id, name, avatar_id, channel_id, is_solo, slot_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          role_id = excluded.role_id,
          name = excluded.name,
          avatar_id = excluded.avatar_id,
          channel_id = excluded.channel_id,
          is_solo = excluded.is_solo,
          slot_order = excluded.slot_order,
          updated_at = excluded.updated_at
      `)
      for (const slot of bundle.slots) {
        insertSlot.run(
          slot.id,
          slot.runId,
          slot.roleId,
          slot.name,
          slot.avatarId,
          slot.channelId ?? null,
          slot.solo === true ? 1 : 0,
          slot.order,
          slot.createdAt,
          slot.updatedAt
        )
        if (slot.modelSelection) {
          this.database.prepare(`
            INSERT INTO agent_slot_model_selections (slot_id, selection_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(slot_id) DO UPDATE SET
              selection_json = excluded.selection_json,
              updated_at = excluded.updated_at
          `).run(slot.id, JSON.stringify(slot.modelSelection), slot.updatedAt)
        } else {
          this.database.prepare('DELETE FROM agent_slot_model_selections WHERE slot_id = ?').run(slot.id)
        }
      }

      const roleIds = bundle.roles.map((role) => role.id)
      const rolePlaceholders = roleIds.map(() => '?').join(', ')
      this.database.prepare(`
        DELETE FROM team_roles WHERE run_id = ? AND id NOT IN (${rolePlaceholders})
      `).run(run.id, ...roleIds)

      this.bumpRevision(workspace.id)
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  setActiveWorkspace(workspaceId: string): void {
    const normalized = workspaceId.trim()
    const exists = this.database.prepare('SELECT 1 FROM team_workspaces WHERE id = ?').get(normalized)
    if (!exists) throw new Error('工作区不存在')
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.bumpRevision(normalized)
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  updateRunGoal(runId: string, goal: string): void {
    const normalizedGoal = goal.trim()
    if (!normalizedGoal) throw new Error('团队目标不能为空')
    if (normalizedGoal.length > 8_000) throw new Error('团队目标不能超过 8000 个字符')
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const run = this.database.prepare(`
        SELECT status FROM team_runs WHERE id = ?
      `).get(runId.trim()) as SqliteRow | undefined
      if (!run) throw new Error('TeamRun 不存在')
      if (['launching', 'running', 'completed'].includes(String(run.status))) {
        throw new Error('当前 TeamRun 已启动，不能修改团队目标')
      }
      const bindingCounts = this.database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM agent_slots WHERE run_id = ?) AS slots,
          (SELECT COUNT(*) FROM runtime_bindings WHERE run_id = ?) AS bindings
      `).get(runId.trim(), runId.trim()) as SqliteRow
      const installationComplete = numberOf(bindingCounts.slots) > 0 &&
        numberOf(bindingCounts.slots) === numberOf(bindingCounts.bindings)
      const result = this.database.prepare(`
        UPDATE team_runs SET goal = ?, status = ?, updated_at = ? WHERE id = ?
      `).run(normalizedGoal, installationComplete ? 'ready' : 'draft', Date.now(), runId.trim())
      if (numberOf(result.changes) !== 1) throw new Error('TeamRun 不存在')
      this.bumpRevision()
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  recordInstallation(batch: AgentRegistrationBatch): void {
    const workspaceId = batch.workspaceId.trim()
    const runId = batch.runId.trim()
    if (!workspaceId || !runId || !batch.agents.length) throw new Error('Agent 安装批次不完整')

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const run = this.database.prepare(
        'SELECT id FROM team_runs WHERE id = ? AND workspace_id = ?'
      ).get(runId, workspaceId)
      if (!run) throw new Error('Agent 安装批次不属于当前团队工作区')

      const expectedSlots = this.database.prepare(`
        SELECT s.id, s.channel_id, r.capabilities_json
        FROM agent_slots s
        JOIN team_roles r ON r.id = s.role_id
        WHERE s.run_id = ?
        ORDER BY s.slot_order ASC
      `).all(runId) as SqliteRow[]
      if (batch.agents.length < expectedSlots.length || expectedSlots.some((slot) => {
        const agent = batch.agents.find((candidate) => candidate.channelId === String(slot.channel_id))
        if (!agent) return true
        const expected = stringArrayOf(slot.capabilities_json).sort()
        const actual = [...new Set(agent.capabilities.map((value) => value.trim()).filter(Boolean))].sort()
        return JSON.stringify(expected) !== JSON.stringify(actual)
      })) {
        throw new Error('Agent 安装批次与当前 Team 角色或通道拓扑不一致')
      }

      const existingBindings = this.database.prepare(`
        SELECT slot_id, channel_id, agent_session_id, generation
        FROM runtime_bindings
        WHERE run_id = ?
        ORDER BY channel_id ASC
      `).all(runId) as SqliteRow[]
      const existingBySlot = new Map(existingBindings.map((binding) => [String(binding.slot_id), binding]))
      const topologyAlreadyInstalled = existingBindings.length === expectedSlots.length && expectedSlots.every((slot) => {
        const binding = existingBySlot.get(String(slot.id))
        if (!binding || String(binding.channel_id) !== String(slot.channel_id)) return false
        const agent = batch.agents.find((candidate) => candidate.channelId === String(slot.channel_id))
        if (!agent) return false
        const expected = stringArrayOf(slot.capabilities_json).sort()
        const actual = [...new Set(agent.capabilities.map((value) => value.trim()).filter(Boolean))].sort()
        return JSON.stringify(expected) === JSON.stringify(actual)
      })
      const installedAt = Date.now()
      if (topologyAlreadyInstalled) {
        const generations = [...new Set(existingBindings.map((binding) => String(binding.generation)))]
        const canRefreshRegistrations = generations.length === 1 && existingBindings.every((binding) => (
          String(binding.agent_session_id) === `${workspaceId}:ch-${String(binding.channel_id)}:${String(binding.generation)}`
        ))
        if (canRefreshRegistrations) {
          replaceWorkspaceAgentRegistrations(this.database, {
            workspaceId,
            runId,
            generation: generations[0]!,
            agents: expectedSlots.map((slot) => {
              const binding = existingBySlot.get(String(slot.id))!
              return {
                agentSessionId: String(binding.agent_session_id),
                runtimeId: `${workspaceId}:ch-${String(slot.channel_id)}`,
                workspaceId,
                channelId: String(slot.channel_id),
                generation: generations[0]!,
                runId,
                capabilities: stringArrayOf(slot.capabilities_json)
              }
            })
          }, installedAt)
        }
        // 相同拓扑重复安装必须是幂等刷新：保留 runtime_bindings 的 generation、
        // launch_status、composer 绑定和 check_in 证据，避免把仍在轮询的 Cursor 会话误杀。
        this.database.prepare(`
          UPDATE team_runs
          SET status = CASE WHEN length(trim(goal)) > 0 THEN 'ready' ELSE 'draft' END,
              updated_at = ?, launched_at = NULL
          WHERE id = ? AND status IN ('draft', 'ready')
        `).run(installedAt, runId)
        this.bumpRevision(workspaceId)
        this.database.exec('COMMIT')
        return
      }

      replaceWorkspaceAgentRegistrations(this.database, batch)

      this.database.prepare('DELETE FROM runtime_bindings WHERE run_id = ?').run(runId)
      const insertBinding = this.database.prepare(`
        INSERT INTO runtime_bindings (
          id, workspace_id, run_id, slot_id, channel_id, agent_session_id, generation,
          installed_at, launch_status, launch_command_id, launch_detail,
          acknowledged_at, last_check_in_at, last_check_in_note, composer_binding_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'not_started', NULL, '', NULL, NULL, '', ?)
      `)
      for (const slot of expectedSlots) {
        const agent = batch.agents.find((candidate) => candidate.channelId === String(slot.channel_id))
        if (!agent) throw new Error(`CH-${slot.channel_id} 缺少已注册运行时`)
        insertBinding.run(
          `runtime-binding:${agent.agentSessionId}`,
          workspaceId,
          runId,
          String(slot.id),
          agent.channelId,
          agent.agentSessionId,
          agent.generation,
          installedAt,
          agent.generation
        )
      }
      // 安装批次只把「尚未启动」的 run 归位到 ready/draft；launching/running 等
      // 已启动状态必须保留——否则启动标记被抹掉后 team_check_in 永久拒绝（白名单
      // 不含 ready），而消息通道不校验 run 状态照常工作，形成状态撕裂。
      this.database.prepare(`
        UPDATE team_runs
        SET status = CASE WHEN length(trim(goal)) > 0 THEN 'ready' ELSE 'draft' END,
            updated_at = ?, launched_at = NULL
        WHERE id = ? AND status IN ('draft', 'ready')
      `).run(installedAt, runId)
      this.bumpRevision(workspaceId)
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  recordComposerBinding(input: {
    runId: string
    slotId: string
    generation: string
    bindingKey: string
    composerId: string
    method: ComposerBindingMethod
    at: number
  }): boolean {
    const runId = input.runId.trim()
    const slotId = input.slotId.trim()
    const generation = input.generation.trim()
    const bindingKey = input.bindingKey.trim()
    const composerId = input.composerId.trim()
    if (
      !runId ||
      !slotId ||
      !generation ||
      !COMPOSER_BINDING_KEY_PATTERN.test(bindingKey) ||
      !COMPOSER_ID_PATTERN.test(composerId)
    ) {
      throw new Error('Cursor Composer 绑定参数无效')
    }
    if (!COMPOSER_BINDING_METHODS.has(input.method)) throw new Error('Cursor Composer 绑定方式无效')
    if (!Number.isFinite(input.at) || input.at <= 0) throw new Error('Cursor Composer 绑定时间无效')

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const binding = this.database.prepare(`
        SELECT composer_id, generation, composer_binding_key
        FROM runtime_bindings
        WHERE run_id = ? AND slot_id = ?
      `).get(runId, slotId) as SqliteRow | undefined
      if (
        !binding ||
        String(binding.generation) !== generation ||
        String(binding.composer_binding_key) !== bindingKey
      ) {
        this.database.exec('ROLLBACK')
        return false
      }
      const currentComposerId = optionalString(binding.composer_id)
      if (currentComposerId && currentComposerId !== composerId) {
        this.database.exec('ROLLBACK')
        return false
      }
      const conflict = this.database.prepare(`
        SELECT slot_id FROM runtime_bindings
        WHERE run_id = ? AND composer_id = ? AND slot_id <> ?
      `).get(runId, composerId, slotId) as SqliteRow | undefined
      if (conflict) {
        this.database.exec('ROLLBACK')
        return false
      }
      const result = this.database.prepare(`
        UPDATE runtime_bindings
        SET composer_id = ?, composer_bound_at = ?, composer_binding_method = ?
        WHERE run_id = ? AND slot_id = ? AND generation = ?
          AND composer_binding_key = ? AND composer_id IS NULL
      `).run(composerId, input.at, input.method, runId, slotId, generation, bindingKey)
      if (numberOf(result.changes) === 0) {
        this.database.exec('ROLLBACK')
        return false
      }
      this.bumpRevision()
      this.database.exec('COMMIT')
      return true
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  resolveAgentRuntimeIdentity(identityKey: string, runId = ''): AgentAuthorizationIdentity {
    const normalizedIdentityKey = identityKey.trim()
    const normalizedRunId = runId.trim()
    const row = this.database.prepare(`
      SELECT ar.agent_session_id, ar.run_id, b.slot_id, s.is_solo, r.template_key, r.capabilities_json,
        tr.acting_lead_slot_id, lead.capabilities_json AS lead_capabilities_json
      FROM agent_registrations ar
      JOIN runtime_bindings b
        ON b.agent_session_id = ar.agent_session_id AND b.run_id = ar.run_id
      JOIN agent_slots s ON s.id = b.slot_id AND s.run_id = b.run_id
      JOIN team_roles r ON r.id = s.role_id AND r.run_id = b.run_id
      JOIN team_runs tr ON tr.id = b.run_id
      LEFT JOIN team_roles lead ON lead.run_id = b.run_id AND lead.template_key = 'lead'
      WHERE (ar.runtime_id = ? OR ar.agent_session_id = ?)
        AND (? = '' OR ar.run_id = ?) AND ar.revoked_at IS NULL
      ORDER BY ar.installed_at DESC LIMIT 1
    `).get(normalizedIdentityKey, normalizedIdentityKey, normalizedRunId, normalizedRunId) as SqliteRow | undefined
    if (!row) {
      const registered = this.database.prepare(`
        SELECT 1 FROM agent_registrations
        WHERE (runtime_id = ? OR agent_session_id = ?)
          AND (? = '' OR run_id = ?) AND revoked_at IS NULL
      `).get(normalizedIdentityKey, normalizedIdentityKey, normalizedRunId, normalizedRunId)
      throw new TaskPoolError(
        registered ? 'standby_not_assigned' : 'agent_not_authorized',
        registered
          ? '当前通道处于备用状态，尚未接替任何 AgentSlot'
          : '当前 Agent generation 未注册或已被撤销'
      )
    }
    if (numberOf(row.is_solo) === 1) {
      throw new TaskPoolError(
        'solo_channel',
        '当前通道是独立席位，不参与团队协作；请直接通过 check_messages / record_reply 与用户沟通'
      )
    }
    return {
      agentSessionId: String(row.agent_session_id),
      runId: String(row.run_id),
      slotId: String(row.slot_id),
      capabilities: effectiveCapabilities(row)
    }
  }

  /**
   * 统一通道服务器（S3-1）按 channelId 实时解析当前活动 TeamRun 内的身份：
   * server 进程长驻、不携带 run 级 env，团队换届无需重写 Cursor 配置。
   * 语义对齐 resolveAgentRuntimeIdentity：已注册未接替 → standby_not_assigned；
   * 未注册 → agent_not_authorized。
   */
  resolveChannelAgentIdentity(channelId: string): AgentAuthorizationIdentity {
    const normalizedChannelId = String(channelId).trim()
    const state = this.loadTeamControl()
    const activeRun = state.activeWorkspaceId
      ? state.runs
        .filter((run) => run.workspaceId === state.activeWorkspaceId)
        .sort((left, right) => right.createdAt - left.createdAt)[0]
      : undefined
    if (!activeRun) {
      throw new TaskPoolError('agent_not_authorized', '当前没有活动 TeamRun，通道身份无法解析')
    }
    const row = this.database.prepare(`
      SELECT ar.agent_session_id, ar.run_id, b.slot_id, s.is_solo, r.template_key, r.capabilities_json,
        tr.acting_lead_slot_id, lead.capabilities_json AS lead_capabilities_json
      FROM agent_registrations ar
      JOIN runtime_bindings b
        ON b.agent_session_id = ar.agent_session_id AND b.run_id = ar.run_id
      JOIN agent_slots s ON s.id = b.slot_id AND s.run_id = b.run_id
      JOIN team_roles r ON r.id = s.role_id AND r.run_id = b.run_id
      JOIN team_runs tr ON tr.id = b.run_id
      LEFT JOIN team_roles lead ON lead.run_id = b.run_id AND lead.template_key = 'lead'
      WHERE ar.run_id = ? AND ar.channel_id = ? AND ar.revoked_at IS NULL
      ORDER BY ar.installed_at DESC LIMIT 1
    `).get(activeRun.id, normalizedChannelId) as SqliteRow | undefined
    if (!row) {
      // P0-2：run 收尾撤销注册是「轮次归档」，不是授权故障。曾注册到本轮的
      // 通道在 run 结束后调用 team_* 工具，必须得到「本轮已结束 + 如何恢复」
      // 的指引，而不是不可恢复的「未注册」硬错（2026-09-01 事故：Agent 被误判
      // 离线触发自动收尾后，工具调用全部报授权错误且无法恢复）。run_completed
      // 经 refreshIdentity 直接传播为工具结果（与 solo_channel 同模式）；
      // check_messages / record_reply 等通信工具不经身份解析，不受影响。
      if (activeRun.status === 'completed') {
        const archived = this.database.prepare(`
          SELECT 1 FROM agent_registrations
          WHERE run_id = ? AND channel_id = ?
        `).get(activeRun.id, normalizedChannelId)
        if (archived) {
          throw new TaskPoolError(
            'run_completed',
            `本轮 TeamRun 已结束，CH-${normalizedChannelId} 的团队身份已随轮次归档（非授权故障，重试无效）。`
              + '请停止调用 team_* 工具；如需同步最终结论请用 record_reply，之后用 check_messages 静默待命，'
              + '新一轮 TeamRun 启动后团队身份会自动恢复。'
          )
        }
      }
      const registered = this.database.prepare(`
        SELECT 1 FROM agent_registrations
        WHERE run_id = ? AND channel_id = ? AND revoked_at IS NULL
      `).get(activeRun.id, normalizedChannelId)
      throw new TaskPoolError(
        registered ? 'standby_not_assigned' : 'agent_not_authorized',
        registered
          ? '当前通道处于备用状态，尚未接替任何 AgentSlot'
          : `CH-${normalizedChannelId} 未注册到当前 TeamRun`
      )
    }
    if (numberOf(row.is_solo) === 1) {
      throw new TaskPoolError(
        'solo_channel',
        `CH-${normalizedChannelId} 是独立席位，不参与团队协作；请直接通过 check_messages / record_reply 与用户沟通`
      )
    }
    return {
      agentSessionId: String(row.agent_session_id),
      runId: String(row.run_id),
      slotId: String(row.slot_id),
      capabilities: effectiveCapabilities(row)
    }
  }

  listAgentRegistrations(runId: string): AgentRegistration[] {
    return (this.database.prepare(`
      SELECT agent_session_id, runtime_id, workspace_id, channel_id, generation, run_id, capabilities_json
      FROM agent_registrations
      WHERE run_id = ? AND revoked_at IS NULL
      ORDER BY CAST(channel_id AS INTEGER), channel_id
    `).all(runId.trim()) as SqliteRow[]).map((row) => ({
      agentSessionId: String(row.agent_session_id),
      runtimeId: optionalString(row.runtime_id),
      workspaceId: String(row.workspace_id),
      channelId: String(row.channel_id),
      generation: String(row.generation),
      runId: String(row.run_id),
      capabilities: stringArrayOf(row.capabilities_json)
    }))
  }

  rebindSlotToStandby(input: {
    failoverId: string
    runId: string
    slotId: string
    expectedAgentSessionId: string
    replacementAgentSessionId: string
    reason: string
    detectedAt: number
    bindingKey: string
    checkpointId?: string
  }): TeamFailoverRebindResult {
    const failoverId = input.failoverId.trim()
    const runId = input.runId.trim()
    const slotId = input.slotId.trim()
    const expectedAgentSessionId = input.expectedAgentSessionId.trim()
    const replacementAgentSessionId = input.replacementAgentSessionId.trim()
    if (!failoverId || !runId || !slotId || !expectedAgentSessionId || !replacementAgentSessionId) {
      throw new Error('接替换绑参数不完整')
    }
    if (!COMPOSER_BINDING_KEY_PATTERN.test(input.bindingKey.trim())) {
      throw new Error('接替绑定键无效')
    }

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.database.prepare(`
        SELECT b.workspace_id, b.channel_id, b.agent_session_id, r.name AS role_name,
               r.capabilities_json
        FROM runtime_bindings b
        JOIN agent_slots s ON s.id = b.slot_id AND s.run_id = b.run_id
        JOIN team_roles r ON r.id = s.role_id AND r.run_id = b.run_id
        WHERE b.run_id = ? AND b.slot_id = ?
      `).get(runId, slotId) as SqliteRow | undefined
      if (!current || String(current.agent_session_id) !== expectedAgentSessionId) {
        throw new TaskPoolError('failover_stale_binding', 'AgentSlot 已被其他运行时接替，忽略迟到的掉线事件')
      }
      const replacement = this.database.prepare(`
        SELECT workspace_id, channel_id, generation
        FROM agent_registrations
        WHERE agent_session_id = ? AND run_id = ? AND revoked_at IS NULL
      `).get(replacementAgentSessionId, runId) as SqliteRow | undefined
      if (!replacement || String(replacement.workspace_id) !== String(current.workspace_id)) {
        throw new TaskPoolError('standby_not_registered', '备用通道没有当前 TeamRun 的有效 MCP 注册')
      }
      const occupied = this.database.prepare(`
        SELECT slot_id FROM runtime_bindings
        WHERE run_id = ? AND agent_session_id = ?
      `).get(runId, replacementAgentSessionId)
      if (occupied) throw new TaskPoolError('standby_already_assigned', '备用通道已被其他职责占用')

      const at = input.detectedAt
      this.database.prepare(`
        UPDATE agent_registrations SET revoked_at = ?
        WHERE agent_session_id = ? AND run_id = ? AND revoked_at IS NULL
      `).run(at, expectedAgentSessionId, runId)
      this.database.prepare(`
        UPDATE agent_registrations SET capabilities_json = ?
        WHERE agent_session_id = ? AND run_id = ? AND revoked_at IS NULL
      `).run(String(current.capabilities_json), replacementAgentSessionId, runId)
      const updated = this.database.prepare(`
        UPDATE runtime_bindings
        SET id = ?, channel_id = ?, agent_session_id = ?, generation = ?, installed_at = ?,
            launch_status = 'sending', launch_command_id = NULL,
            launch_detail = '备用 Agent 正在接替职责', acknowledged_at = NULL,
            last_check_in_at = NULL, last_check_in_note = '', composer_binding_key = ?,
            composer_id = NULL, composer_bound_at = NULL, composer_binding_method = NULL
        WHERE run_id = ? AND slot_id = ? AND agent_session_id = ?
      `).run(
        `runtime-binding:${replacementAgentSessionId}`,
        String(replacement.channel_id),
        replacementAgentSessionId,
        String(replacement.generation),
        at,
        input.bindingKey.trim(),
        runId,
        slotId,
        expectedAgentSessionId
      )
      if (numberOf(updated.changes) !== 1) {
        throw new TaskPoolError('failover_stale_binding', '接替时 AgentSlot 绑定已经变化')
      }
      this.database.prepare(`
        UPDATE agent_slots SET channel_id = ?, updated_at = ? WHERE id = ? AND run_id = ?
      `).run(String(replacement.channel_id), at, slotId, runId)
      this.database.prepare(`
        INSERT INTO team_failovers (
          id, workspace_id, run_id, slot_id, role_name,
          from_channel_id, from_agent_session_id, to_channel_id, to_agent_session_id,
          status, reason, checkpoint_id, message_id, task_ids_json,
          detected_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting_for_agent', ?, ?, NULL, '[]', ?, ?, NULL)
      `).run(
        failoverId,
        String(current.workspace_id),
        runId,
        slotId,
        String(current.role_name),
        String(current.channel_id),
        expectedAgentSessionId,
        String(replacement.channel_id),
        replacementAgentSessionId,
        normalizedNote(input.reason),
        input.checkpointId?.trim() || null,
        at,
        at
      )
      this.database.prepare(`
        UPDATE team_runs SET status = 'attention', updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(at, runId)
      this.bumpRevision()
      this.database.exec('COMMIT')
      return {
        record: this.listFailovers(runId).find((record) => record.id === failoverId)!,
        bindingKey: input.bindingKey.trim()
      }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  rebindSlotFromMember(input: {
    failoverId: string
    runId: string
    slotId: string
    donorSlotId: string
    expectedAgentSessionId: string
    replacementAgentSessionId: string
    reason: string
    detectedAt: number
    bindingKey: string
    checkpointId?: string
  }): TeamFailoverRebindResult {
    const failoverId = input.failoverId.trim()
    const runId = input.runId.trim()
    const slotId = input.slotId.trim()
    const donorSlotId = input.donorSlotId.trim()
    const expectedAgentSessionId = input.expectedAgentSessionId.trim()
    const replacementAgentSessionId = input.replacementAgentSessionId.trim()
    if (!failoverId || !runId || !slotId || !donorSlotId || slotId === donorSlotId
      || !expectedAgentSessionId || !replacementAgentSessionId) {
      throw new Error('手动交接换绑参数不完整')
    }
    if (!COMPOSER_BINDING_KEY_PATTERN.test(input.bindingKey.trim())) throw new Error('交接绑定键无效')

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const bindingRow = (targetSlotId: string): SqliteRow | undefined => this.database.prepare(`
        SELECT b.*, s.avatar_id, r.name AS role_name, r.capabilities_json
        FROM runtime_bindings b
        JOIN agent_slots s ON s.id = b.slot_id AND s.run_id = b.run_id
        JOIN team_roles r ON r.id = s.role_id AND r.run_id = b.run_id
        WHERE b.run_id = ? AND b.slot_id = ?
      `).get(runId, targetSlotId) as SqliteRow | undefined
      const current = bindingRow(slotId)
      const donor = bindingRow(donorSlotId)
      if (!current || String(current.agent_session_id) !== expectedAgentSessionId) {
        throw new TaskPoolError('failover_stale_binding', '待交接 AgentSlot 已被其他运行时接替')
      }
      if (!donor || String(donor.agent_session_id) !== replacementAgentSessionId) {
        throw new TaskPoolError('handoff_candidate_changed', '候选 Agent 的运行身份已经变化')
      }
      const replacement = this.database.prepare(`
        SELECT workspace_id FROM agent_registrations
        WHERE agent_session_id = ? AND run_id = ? AND revoked_at IS NULL
      `).get(replacementAgentSessionId, runId) as SqliteRow | undefined
      if (!replacement || String(replacement.workspace_id) !== String(current.workspace_id)) {
        throw new TaskPoolError('handoff_candidate_revoked', '候选 Agent 已失效，不能交接')
      }
      const conflict = this.database.prepare(`
        SELECT 1 FROM team_failovers
        WHERE run_id = ? AND status = 'waiting_for_agent' AND slot_id IN (?, ?)
      `).get(runId, slotId, donorSlotId)
      if (conflict) throw new TaskPoolError('handoff_in_progress', '相关角色已经处于交接中')

      const at = input.detectedAt
      const temporaryId = `runtime-binding:handoff-temp:${failoverId}`
      const temporaryAgent = `handoff-temp:${failoverId}`
      this.database.prepare('UPDATE agent_slots SET channel_id = NULL WHERE run_id = ? AND id IN (?, ?)')
        .run(runId, slotId, donorSlotId)
      this.database.prepare(`
        UPDATE runtime_bindings SET id = ?, agent_session_id = ?
        WHERE run_id = ? AND slot_id = ? AND agent_session_id = ?
      `).run(temporaryId, temporaryAgent, runId, slotId, expectedAgentSessionId)
      this.database.prepare(`
        UPDATE runtime_bindings
        SET id = ?, channel_id = ?, agent_session_id = ?, generation = ?, installed_at = ?,
            launch_status = 'failed', launch_command_id = NULL,
            launch_detail = '原运行时已离线；在线 Agent 已迁移到其他职责',
            acknowledged_at = NULL, last_check_in_at = NULL, last_check_in_note = '',
            composer_binding_key = ?, composer_id = NULL, composer_bound_at = NULL,
            composer_binding_method = NULL
        WHERE run_id = ? AND slot_id = ? AND agent_session_id = ?
      `).run(
        String(current.id), String(current.channel_id), expectedAgentSessionId,
        String(current.generation), at, String(current.composer_binding_key),
        runId, donorSlotId, replacementAgentSessionId
      )
      this.database.prepare(`
        UPDATE runtime_bindings
        SET id = ?, channel_id = ?, agent_session_id = ?, generation = ?, installed_at = ?,
            launch_status = 'sending', launch_command_id = NULL,
            launch_detail = '用户手动交接，等待新角色确认', acknowledged_at = NULL,
            last_check_in_at = NULL, last_check_in_note = '', composer_binding_key = ?,
            composer_id = NULL, composer_bound_at = NULL, composer_binding_method = NULL
        WHERE run_id = ? AND slot_id = ? AND agent_session_id = ?
      `).run(
        String(donor.id), String(donor.channel_id), replacementAgentSessionId,
        String(donor.generation), at, input.bindingKey.trim(),
        runId, slotId, temporaryAgent
      )
      this.database.prepare(`
        UPDATE agent_slots SET channel_id = ?, avatar_id = ?, updated_at = ? WHERE run_id = ? AND id = ?
      `).run(String(donor.channel_id), String(donor.avatar_id), at, runId, slotId)
      this.database.prepare(`
        UPDATE agent_slots SET channel_id = ?, avatar_id = ?, updated_at = ? WHERE run_id = ? AND id = ?
      `).run(String(current.channel_id), String(current.avatar_id), at, runId, donorSlotId)
      this.database.prepare(`
        UPDATE agent_registrations SET revoked_at = ?
        WHERE agent_session_id = ? AND run_id = ? AND revoked_at IS NULL
      `).run(at, expectedAgentSessionId, runId)
      this.database.prepare(`
        UPDATE agent_registrations SET capabilities_json = ?
        WHERE agent_session_id = ? AND run_id = ? AND revoked_at IS NULL
      `).run(String(current.capabilities_json), replacementAgentSessionId, runId)
      this.database.prepare(`
        INSERT INTO team_failovers (
          id, workspace_id, run_id, slot_id, role_name,
          from_channel_id, from_agent_session_id, to_channel_id, to_agent_session_id,
          status, reason, checkpoint_id, message_id, task_ids_json,
          detected_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting_for_agent', ?, ?, NULL, '[]', ?, ?, NULL)
      `).run(
        failoverId, String(current.workspace_id), runId, slotId, String(current.role_name),
        String(current.channel_id), expectedAgentSessionId, String(donor.channel_id),
        replacementAgentSessionId, normalizedNote(input.reason),
        input.checkpointId?.trim() || null, at, at
      )
      this.database.prepare(`
        UPDATE team_runs SET status = 'attention', updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(at, runId)
      this.bumpRevision()
      this.database.exec('COMMIT')
      return {
        record: this.listFailovers(runId).find((record) => record.id === failoverId)!,
        bindingKey: input.bindingKey.trim()
      }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  attachFailoverContext(input: {
    failoverId: string
    checkpointId?: string
    messageId: string
    taskIds: string[]
    at: number
  }): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.database.prepare(`
        UPDATE team_failovers
        SET checkpoint_id = ?, message_id = ?, task_ids_json = ?, updated_at = ?
        WHERE id = ? AND status = 'waiting_for_agent'
      `).run(
        input.checkpointId ?? null,
        input.messageId.trim(),
        JSON.stringify([...new Set(input.taskIds.map((id) => id.trim()).filter(Boolean))]),
        input.at,
        input.failoverId.trim()
      )
      if (numberOf(result.changes) !== 1) throw new Error('接替记录不存在或状态已结束')
      this.bumpRevision()
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  updateFailoverStatus(input: {
    failoverId: string
    status: 'completed' | 'failed'
    reason?: string
    at: number
  }): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.database.prepare(
        'SELECT run_id FROM team_failovers WHERE id = ?'
      ).get(input.failoverId.trim()) as SqliteRow | undefined
      if (!row) throw new Error('接替记录不存在')
      this.database.prepare(`
        UPDATE team_failovers
        SET status = ?, reason = CASE WHEN ? = '' THEN reason ELSE ? END,
            updated_at = ?, completed_at = ?
        WHERE id = ? AND status = 'waiting_for_agent'
      `).run(
        input.status,
        input.reason?.trim() ?? '',
        normalizedNote(input.reason ?? ''),
        input.at,
        input.at,
        input.failoverId.trim()
      )
      if (input.status === 'completed') {
        const pending = this.database.prepare(`
          SELECT COUNT(*) AS count FROM team_failovers
          WHERE run_id = ? AND status = 'waiting_for_agent'
        `).get(String(row.run_id)) as SqliteRow
        if (numberOf(pending.count) === 0) {
          this.database.prepare(`
            UPDATE team_runs SET status = 'running', updated_at = ?
            WHERE id = ? AND status = 'attention'
          `).run(input.at, String(row.run_id))
        }
      }
      this.bumpRevision()
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  listFailovers(runId: string): TeamFailoverRecord[] {
    return (this.database.prepare(`
      SELECT * FROM team_failovers WHERE run_id = ?
      ORDER BY detected_at DESC, id DESC
    `).all(runId.trim()) as SqliteRow[]).map(failoverFromRow)
  }

  completeRun(runId: string, at: number): boolean {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const normalizedRunId = runId.trim()
      const result = this.database.prepare(`
        UPDATE team_runs SET status = 'completed', acting_lead_slot_id = NULL, updated_at = ?
        WHERE id = ? AND status IN ('launching', 'running', 'attention', 'paused')
      `).run(at, normalizedRunId)
      if (numberOf(result.changes) > 0) {
        this.database.prepare(`
          UPDATE agent_registrations SET revoked_at = ?
          WHERE run_id = ? AND revoked_at IS NULL
        `).run(at, normalizedRunId)
        this.database.prepare(`
          UPDATE runtime_bindings
          SET launch_status = 'failed', launch_detail = '本轮所有 Agent 已离线，TeamRun 自动结束'
          WHERE run_id = ?
        `).run(normalizedRunId)
        this.bumpRevision()
      }
      this.database.exec('COMMIT')
      return numberOf(result.changes) > 0
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  setActingLead(input: { runId: string; slotId: string | null; at: number }): boolean {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const normalizedRunId = input.runId.trim()
      const normalizedSlotId = input.slotId?.trim() ?? null
      if (normalizedSlotId) {
        const slot = this.database.prepare(`
          SELECT s.id FROM agent_slots s
          JOIN team_roles r ON r.id = s.role_id
          WHERE s.id = ? AND s.run_id = ? AND COALESCE(s.is_solo, 0) = 0
        `).get(normalizedSlotId, normalizedRunId) as SqliteRow | undefined
        if (!slot) throw new TaskPoolError('acting_lead_slot_not_found', '目标 AgentSlot 不属于当前 TeamRun')
      }
      const result = this.database.prepare(`
        UPDATE team_runs SET acting_lead_slot_id = ?, updated_at = ?
        WHERE id = ? AND status IN ('launching', 'running', 'attention')
      `).run(normalizedSlotId, input.at, normalizedRunId)
      if (numberOf(result.changes) !== 1) {
        throw new TaskPoolError('acting_lead_run_inactive', '只有运行中的 TeamRun 可以设置临时主控')
      }
      this.bumpRevision()
      this.database.exec('COMMIT')
      return true
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  beginLaunch(runId: string, at: number, bindingKey: string): void {
    const normalizedBindingKey = bindingKey.trim()
    if (!COMPOSER_BINDING_KEY_PATTERN.test(normalizedBindingKey)) {
      throw new Error('Cursor 会话启动绑定键无效')
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.database.prepare(`
        UPDATE team_runs
        SET status = 'launching', launched_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('ready', 'attention') AND length(trim(goal)) > 0
      `).run(at, at, runId.trim())
      if (numberOf(result.changes) !== 1) throw new Error('TeamRun 尚未达到可启动状态')
      this.database.prepare(`
        UPDATE runtime_bindings
        SET launch_status = 'not_started', launch_command_id = NULL, launch_detail = '',
            acknowledged_at = NULL, last_check_in_at = NULL, last_check_in_note = '',
            composer_binding_key = ?, composer_id = NULL, composer_bound_at = NULL,
            composer_binding_method = NULL
        WHERE run_id = ?
      `).run(normalizedBindingKey, runId.trim())
      this.bumpRevision()
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 幂等推进 run 到 launching（仅状态，不重置 bindings）：
   * 供会话创建路径在投递启动提示前调用，保证 Agent 收到提示时 check_in 必被接纳。
   * 与 beginLaunch 的差别：不轮换 composer_binding_key、不清除既有 composer 绑定，
   * 因此不会打断已在线会话。已是 launching/running/attention 等状态时为空操作。
   */
  ensureRunLaunching(runId: string, at: number): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        UPDATE team_runs
        SET status = 'launching', launched_at = COALESCE(launched_at, ?), updated_at = ?
        WHERE id = ? AND status IN ('ready', 'draft') AND length(trim(goal)) > 0
      `).run(at, at, runId.trim())
      this.bumpRevision()
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  recordLaunchDelivery(input: {
    runId: string
    slotId: string
    status: 'sending' | 'delivered' | 'uncertain' | 'failed'
    commandId?: string
    detail: string
  }): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.database.prepare(`
        UPDATE runtime_bindings
        SET
          launch_status = CASE
            WHEN launch_status = 'acknowledged' THEN 'acknowledged'
            ELSE ?
          END,
          launch_command_id = COALESCE(?, launch_command_id),
          launch_detail = CASE
            WHEN launch_status = 'acknowledged' THEN launch_detail
            ELSE ?
          END
        WHERE run_id = ? AND slot_id = ?
      `).run(
        input.status,
        input.commandId ?? null,
        input.detail.trim().slice(0, 2_000),
        input.runId,
        input.slotId
      )
      if (numberOf(result.changes) !== 1) throw new Error('RuntimeBinding 不存在')
      const binding = this.database.prepare(`
        SELECT launch_status FROM runtime_bindings WHERE run_id = ? AND slot_id = ?
      `).get(input.runId, input.slotId) as SqliteRow
      if (
        binding.launch_status !== 'acknowledged' &&
        (input.status === 'failed' || input.status === 'uncertain')
      ) {
        this.database.prepare(`
          UPDATE team_runs SET status = 'attention', updated_at = ? WHERE id = ?
        `).run(Date.now(), input.runId)
      }
      this.bumpRevision()
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  recordAgentCheckIn(identity: AgentAuthorizationIdentity, note: string): AgentCheckInReceipt {
    const at = Date.now()
    let row: SqliteRow | undefined
    this.database.exec('BEGIN IMMEDIATE')
    try {
      row = this.database.prepare(`
        SELECT b.workspace_id, b.run_id, b.slot_id, r.name AS role_name, tr.status AS run_status
        FROM runtime_bindings b
        JOIN agent_slots s ON s.id = b.slot_id
        JOIN team_roles r ON r.id = s.role_id
        JOIN team_runs tr ON tr.id = b.run_id
        WHERE b.agent_session_id = ? AND b.run_id = ?
      `).get(identity.agentSessionId, identity.runId) as SqliteRow | undefined
      if (!row) {
        throw new TaskPoolError('runtime_binding_missing', '当前 Agent 没有有效的外置 Team RuntimeBinding')
      }
      if (!['launching', 'attention', 'running'].includes(String(row.run_status))) {
        // 自愈：会话创建路径（AgentSessionLauncher）只投递启动提示、不推进 run 状态，
        // Agent 收到提示即 check_in。只要 run 已具备目标，就原地推进到 launching，
        // 保证任何投递路径下 check_in 都不会被状态机误拒（team_run_not_launched）。
        // 无目标（draft 且 goal 为空）时依旧拒绝——此时不该存在有效的启动提示。
        const healed = this.database.prepare(`
          UPDATE team_runs
          SET status = 'launching', launched_at = COALESCE(launched_at, ?), updated_at = ?
          WHERE id = ? AND status IN ('ready', 'draft') AND length(trim(goal)) > 0
        `).run(at, at, identity.runId)
        if (numberOf(healed.changes) !== 1) {
          throw new TaskPoolError('team_run_not_launched', '当前 TeamRun 尚未启动，不能提前确认 Agent')
        }
      }

      const updated = this.database.prepare(`
        UPDATE runtime_bindings
        SET launch_status = 'acknowledged', acknowledged_at = ?, last_check_in_at = ?, last_check_in_note = ?
        WHERE agent_session_id = ? AND run_id = ?
      `).run(at, at, normalizedNote(note), identity.agentSessionId, identity.runId)
      if (numberOf(updated.changes) !== 1) {
        throw new TaskPoolError('runtime_binding_missing', '当前 Agent RuntimeBinding 已失效')
      }

      const totals = this.database.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN launch_status = 'acknowledged' THEN 1 ELSE 0 END) AS acknowledged
        FROM runtime_bindings b
        JOIN agent_slots s ON s.id = b.slot_id AND s.run_id = b.run_id
        WHERE b.run_id = ? AND COALESCE(s.is_solo, 0) = 0
      `).get(identity.runId) as SqliteRow
      if (numberOf(totals.total) > 0 && numberOf(totals.total) === numberOf(totals.acknowledged)) {
        this.database.prepare(`
          UPDATE team_runs
          SET status = 'running', updated_at = ?
          WHERE id = ? AND status IN ('launching', 'attention')
        `).run(at, identity.runId)
      }
      this.bumpRevision()
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }

    return {
      workspaceId: String(row!.workspace_id),
      runId: String(row!.run_id),
      slotId: String(row!.slot_id),
      roleName: String(row!.role_name),
      acknowledgedAt: at
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close()
  }

  private bumpRevision(activeWorkspaceId?: string): void {
    if (activeWorkspaceId !== undefined) {
      this.database.prepare(`
        UPDATE team_control_meta
        SET revision = revision + 1, active_workspace_id = ?, updated_at = ?
        WHERE id = 1
      `).run(activeWorkspaceId, Date.now())
      return
    }
    this.database.prepare(`
      UPDATE team_control_meta SET revision = revision + 1, updated_at = ? WHERE id = 1
    `).run(Date.now())
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS team_control_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        active_workspace_id TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        goal TEXT NOT NULL,
        template_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        launched_at INTEGER,
        acting_lead_slot_id TEXT
      );

      CREATE TABLE IF NOT EXISTS team_roles (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        role_key TEXT NOT NULL,
        template_key TEXT NOT NULL,
        name TEXT NOT NULL,
        mission TEXT NOT NULL,
        instructions TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        skills_json TEXT NOT NULL,
        accent TEXT NOT NULL,
        role_order INTEGER NOT NULL,
        UNIQUE (run_id, role_key)
      );

      CREATE TABLE IF NOT EXISTS agent_slots (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL REFERENCES team_roles(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        avatar_id TEXT NOT NULL,
        channel_id TEXT,
        is_solo INTEGER NOT NULL DEFAULT 0,
        slot_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_slot_model_selections (
        slot_id TEXT PRIMARY KEY REFERENCES agent_slots(id) ON DELETE CASCADE,
        selection_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_bindings (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        slot_id TEXT NOT NULL UNIQUE REFERENCES agent_slots(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL UNIQUE,
        generation TEXT NOT NULL,
        installed_at INTEGER NOT NULL,
        launch_status TEXT NOT NULL,
        launch_command_id TEXT,
        launch_detail TEXT NOT NULL,
        acknowledged_at INTEGER,
        last_check_in_at INTEGER,
        last_check_in_note TEXT NOT NULL,
        composer_binding_key TEXT NOT NULL,
        composer_id TEXT,
        composer_bound_at INTEGER,
        composer_binding_method TEXT
      );

      CREATE TABLE IF NOT EXISTS team_failovers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        slot_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
        role_name TEXT NOT NULL,
        from_channel_id TEXT NOT NULL,
        from_agent_session_id TEXT NOT NULL,
        to_channel_id TEXT,
        to_agent_session_id TEXT,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        checkpoint_id TEXT,
        message_id TEXT,
        task_ids_json TEXT NOT NULL,
        detected_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_slots_run_channel
      ON agent_slots(run_id, channel_id) WHERE channel_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_team_runs_workspace ON team_runs(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_runtime_bindings_run ON runtime_bindings(run_id, channel_id);
      CREATE INDEX IF NOT EXISTS idx_team_failovers_run ON team_failovers(run_id, detected_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_team_failovers_waiting_slot
      ON team_failovers(run_id, slot_id) WHERE status = 'waiting_for_agent';

      INSERT OR IGNORE INTO team_control_meta (
        id, schema_version, revision, active_workspace_id, updated_at
      ) VALUES (1, ${TEAM_SCHEMA_VERSION}, 0, NULL, 0);
    `)
    ensureAgentRegistrationsSchema(this.database)
    const meta = this.database.prepare(
      'SELECT schema_version FROM team_control_meta WHERE id = 1'
    ).get() as SqliteRow
    let databaseVersion = numberOf(meta.schema_version)
    if (databaseVersion === 1) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.exec('ALTER TABLE runtime_bindings ADD COLUMN composer_id TEXT')
        this.database.exec('ALTER TABLE runtime_bindings ADD COLUMN composer_bound_at INTEGER')
        this.database.exec('ALTER TABLE runtime_bindings ADD COLUMN composer_binding_method TEXT')
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(2, Date.now())
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
        this.database.exec('ALTER TABLE runtime_bindings ADD COLUMN composer_binding_key TEXT')
        this.database.exec(`
          UPDATE runtime_bindings SET composer_binding_key = generation
          WHERE composer_binding_key IS NULL OR length(trim(composer_binding_key)) = 0
        `)
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(3, Date.now())
        this.database.exec('COMMIT')
        databaseVersion = 3
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion === 3) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        if (!tableHasColumn(this.database, 'team_roles', 'template_key')) {
          this.database.exec("ALTER TABLE team_roles ADD COLUMN template_key TEXT NOT NULL DEFAULT ''")
        }
        if (!tableHasColumn(this.database, 'team_roles', 'skills_json')) {
          this.database.exec("ALTER TABLE team_roles ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'")
        }
        if (!tableHasColumn(this.database, 'agent_slots', 'avatar_id')) {
          this.database.exec("ALTER TABLE agent_slots ADD COLUMN avatar_id TEXT NOT NULL DEFAULT 'devops'")
        }
        this.database.exec(`
          UPDATE team_roles
          SET template_key = CASE
            WHEN role_key = 'lead' THEN 'lead'
            WHEN role_key = 'builder' THEN 'builder'
            WHEN role_key = 'reviewer' THEN 'reviewer'
            WHEN role_key LIKE 'specialist-%' THEN 'specialist'
            ELSE role_key
          END
          WHERE length(trim(template_key)) = 0
        `)
        this.database.exec(`
          UPDATE agent_slots
          SET avatar_id = CASE
            WHEN role_id IN (SELECT id FROM team_roles WHERE template_key = 'lead') THEN 'lead'
            WHEN role_id IN (SELECT id FROM team_roles WHERE template_key = 'builder') THEN 'architect'
            WHEN role_id IN (SELECT id FROM team_roles WHERE template_key = 'reviewer') THEN 'reviewer'
            ELSE avatar_id
          END
        `)
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(4, Date.now())
        this.database.exec('COMMIT')
        databaseVersion = 4
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion === 4) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(5, Date.now())
        this.database.exec('COMMIT')
        databaseVersion = 5
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion === 5) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        if (!tableHasColumn(this.database, 'team_runs', 'acting_lead_slot_id')) {
          this.database.exec('ALTER TABLE team_runs ADD COLUMN acting_lead_slot_id TEXT')
        }
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(6, Date.now())
        this.database.exec('COMMIT')
        databaseVersion = 6
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion === 6) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        if (!tableHasColumn(this.database, 'agent_slots', 'is_solo')) {
          this.database.exec('ALTER TABLE agent_slots ADD COLUMN is_solo INTEGER NOT NULL DEFAULT 0')
        }
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(7, Date.now())
        this.database.exec('COMMIT')
        databaseVersion = 7
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion !== TEAM_SCHEMA_VERSION) {
      throw new Error(`团队控制数据库版本不兼容：${databaseVersion}，当前支持 ${TEAM_SCHEMA_VERSION}`)
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_runtime_bindings_run_composer
      ON runtime_bindings(run_id, composer_id) WHERE composer_id IS NOT NULL;
    `)
    const repaired = this.database.prepare(`
      UPDATE team_runs SET status = 'draft', updated_at = ?
      WHERE status = 'ready' AND length(trim(goal)) = 0
    `).run(Date.now())
    if (numberOf(repaired.changes) > 0) this.bumpRevision()
  }
}
