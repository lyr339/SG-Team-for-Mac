import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { AgentRegistrationBatch } from '../../application/agent-authorization'
import { SG_TEAM_MCP_SERVER_ID } from '../../domain/channel-message'
import { workspaceIdentityOf } from './workspace-identity'

const ENTRY_PREFIX = 'qt-ch-'
const LEGACY_ENTRY_PREFIX = 'qingtian-team-ch-'
const CHANNEL_ENTRY_PREFIX = 'qtwx-mcp-'
/** S3-1 旧统一条目前缀，仅用于清理。 */
const UNIFIED_ENTRY_PREFIX = 'qunshu-ch-' // 双条目时代遗留前缀，仅用于清理

export interface CursorMcpChannel {
  channelId: string
  slotId?: string
  capabilities: string[]
}

export interface CursorMcpInstallInput {
  workspacePath: string
  channels: CursorMcpChannel[]
  command: string
  serverPath: string
  databasePath: string
  runId: string
  generation?: string
  registrationMode?: 'project-config' | 'global'
  activateAgents?: (batch: AgentRegistrationBatch) => void
}

export interface CursorMcpInstallResult {
  ok: true
  workspacePath: string
  workspaceId: string
  configPath: string
  backupPath?: string
  generation: string
  serverNames: string[]
  registrations: AgentRegistrationBatch
  restartRequired: boolean
}

type McpConfig = {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

function safeGeneration(value?: string): string {
  const generation = (value?.trim() || randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '')
  if (generation.length < 8 || generation.length > 80) throw new Error('generation 无效')
  return generation
}

function readConfig(configPath: string): McpConfig {
  if (!existsSync(configPath)) return {}
  const raw = readFileSync(configPath, 'utf8')
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('根节点必须是对象')
    }
    if (parsed.mcpServers !== undefined && (
      !parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)
    )) {
      throw new Error('mcpServers 必须是对象')
    }
    return parsed as McpConfig
  } catch (error) {
    throw new Error(`现有 mcp.json 不是合法 JSON，已停止安装：${String(error)}`)
  }
}

interface JsonReplacement {
  path: string
  content: string
  mode: number
  backupPath?: string
  temporaryPath: string
  replaced: boolean
}

function prepareReplacement(path: string, content: string): JsonReplacement {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  let mode = 0o600
  let backupPath: string | undefined
  if (existsSync(path)) {
    mode = statSync(path).mode & 0o777
    backupPath = join(directory, `${basename(path)}.shiguang-backup-${Date.now()}-${randomUUID().slice(0, 8)}`)
    copyFileSync(path, backupPath)
  }
  return {
    path,
    content,
    mode,
    backupPath,
    temporaryPath: join(directory, `.${basename(path)}.${randomUUID()}.tmp`),
    replaced: false
  }
}

function replaceJsonFiles(
  replacements: JsonReplacement[],
  activate: () => void
): void {
  try {
    for (const replacement of replacements) {
      writeFileSync(replacement.temporaryPath, replacement.content, {
        encoding: 'utf8',
        mode: replacement.mode
      })
    }
    for (const replacement of replacements) {
      renameSync(replacement.temporaryPath, replacement.path)
      replacement.replaced = true
    }
    activate()
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const replacement of [...replacements].reverse()) {
      try {
        if (existsSync(replacement.temporaryPath)) unlinkSync(replacement.temporaryPath)
        if (!replacement.replaced) continue
        if (replacement.backupPath) {
          const restorePath = join(dirname(replacement.path), `.${basename(replacement.path)}.${randomUUID()}.restore`)
          copyFileSync(replacement.backupPath, restorePath)
          renameSync(restorePath, replacement.path)
        } else if (existsSync(replacement.path)) {
          unlinkSync(replacement.path)
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], 'Agent 注册失败，且配置回滚失败')
    }
    throw error
  }
}

export class CursorMcpInstaller {
  install(input: CursorMcpInstallInput): CursorMcpInstallResult {
    if (!isAbsolute(input.workspacePath)) throw new Error('工作区路径必须是绝对路径')
    if (!isAbsolute(input.command)) throw new Error('MCP command 必须是绝对路径')
    if (!isAbsolute(input.serverPath)) throw new Error('MCP serverPath 必须是绝对路径')
    if (!isAbsolute(input.databasePath)) throw new Error('任务数据库路径必须是绝对路径')
    if (!existsSync(input.workspacePath) || !statSync(input.workspacePath).isDirectory()) {
      throw new Error('工作区目录不存在')
    }
    if (!existsSync(input.command)) throw new Error('MCP command 不存在')
    if (!existsSync(input.serverPath)) throw new Error('MCP server 构建产物不存在')
    if (!input.runId.trim()) throw new Error('runId 不能为空')

    for (const channel of input.channels) {
      if (!/^\d+$/.test(String(channel.channelId).trim())) throw new Error(`通道号无效：${channel.channelId}`)
      if (channel.slotId !== undefined && !channel.slotId.trim()) {
        throw new Error(`CH-${channel.channelId} 的 AgentSlot 无效`)
      }
      if (!Array.isArray(channel.capabilities)) throw new Error(`CH-${channel.channelId} 能力配置无效`)
    }
    const channels = [...new Map(input.channels.map((channel) => [String(channel.channelId).trim(), channel])).values()]
    if (!channels.length) throw new Error('当前没有可安装的拾光通道')

    const workspacePath = realpathSync(input.workspacePath)
    const workspaceId = workspaceIdentityOf(workspacePath).id
    const generation = safeGeneration(input.generation)
    const cursorDirectory = join(workspacePath, '.cursor')
    const configPath = join(cursorDirectory, 'mcp.json')
    const registrationMode = input.registrationMode ?? 'project-config'
    mkdirSync(cursorDirectory, { recursive: true })
    const config = readConfig(configPath)
    const existingServers = config.mcpServers && typeof config.mcpServers === 'object'
      ? { ...config.mcpServers }
      : {}
    for (const name of Object.keys(existingServers)) {
      // 双条目时代（qt-ch-N + qtwx-mcp-N）及更早的遗留条目一律清除：
      // SG Team 取代它们，迁移期不允许同名/异名僵尸 server 并存。
      if (
        name.startsWith(LEGACY_ENTRY_PREFIX)
        || name.startsWith(CHANNEL_ENTRY_PREFIX)
        || name.startsWith(ENTRY_PREFIX)
        || name.startsWith(UNIFIED_ENTRY_PREFIX)
      ) {
        delete existingServers[name]
        continue
      }
    }

    const serverNames: string[] = []
    const agents: AgentRegistrationBatch['agents'] = []
    for (const channel of channels) {
      const channelId = String(channel.channelId).trim()
      const capabilities = [...new Set(channel.capabilities.map((value) => value.trim()).filter(Boolean))]
      if (capabilities.length > 32 || capabilities.some((value) => value.length > 80)) {
        throw new Error(`CH-${channelId} 能力配置超出限制`)
      }
      const agentSessionId = `${workspaceId}:ch-${channelId}:${generation}`
      const runtimeId = `${workspaceId}:ch-${channelId}`
      agents.push({
        agentSessionId,
        runtimeId,
        workspaceId,
        channelId,
        generation,
        runId: input.runId.trim(),
        capabilities
      })
    }
    if (!agents.length) throw new Error('当前没有可接入的拾光通道')
    // S4：Cursor 全局只有一条「SG Team」原生条目（启动时注册器写入）。
    serverNames.push(SG_TEAM_MCP_SERVER_ID)
    const registrations: AgentRegistrationBatch = {
      workspaceId,
      generation,
      runId: input.runId.trim(),
      agents
    }

    const nextConfig: McpConfig = { ...config, mcpServers: existingServers }
    const configChanged = JSON.stringify(config) !== JSON.stringify(nextConfig)
    const replacements: JsonReplacement[] = []
    if (configChanged) {
      replacements.push(prepareReplacement(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`))
    }
    replaceJsonFiles(replacements, () => input.activateAgents?.(registrations))
    const configReplacement = replacements.find((replacement) => replacement.path === configPath)

    return {
      ok: true,
      workspacePath,
      workspaceId,
      configPath,
      backupPath: configReplacement?.backupPath,
      generation,
      serverNames,
      registrations,
      // 全局载体由 Cursor 原生监听；重载仅在迁移工作区遗留静态条目时需要。
      restartRequired: configChanged
    }
  }
}
