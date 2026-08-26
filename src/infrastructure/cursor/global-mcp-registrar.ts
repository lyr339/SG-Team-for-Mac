import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { QUNSHU_MCP_SERVER_NAME } from '../../domain/channel-message'

/** 全局注册的通道上限默认值；S4 统一服务器实际只注册单一 qunshu 条目。 */
export const GLOBAL_CHANNEL_COUNT = 4

const LEGACY_PREFIXES = ['qingtian-team-ch-', 'qt-ch-', 'qtwx-mcp-', 'qunshu-ch-']

export interface GlobalChannelRegistrationInput {
  command: string
  serverPath: string
  databasePath: string
  channelCount?: number
  /** 测试可注入临时路径；生产默认 ~/.cursor/mcp.json。 */
  configPath?: string
}

export interface GlobalChannelRegistrationResult {
  changed: boolean
  configPath: string
  serverNames: string[]
}

export function globalMcpConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json')
}

type McpConfig = {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
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
    throw new Error(`现有全局 mcp.json 不是合法 JSON，已停止注册：${String(error)}`)
  }
}

/**
 * 全局 ~/.cursor/mcp.json 原生条目注册（S3-2，zhimo 同款载体）：
 * 启动时幂等 upsert qunshu-ch-1..N 统一服务器条目，Cursor 面板原生渲染
 * （无 extension- 前缀）；同时清理双条目时代的遗留静态条目。
 * 用户自有服务器（如 zhimo-mcp）原样保留；仅在变更时备份并原子写入。
 */
export function reconcileGlobalChannelServers(input: GlobalChannelRegistrationInput): GlobalChannelRegistrationResult {
  if (!isAbsolute(input.command)) throw new Error('MCP command 必须是绝对路径')
  if (!isAbsolute(input.serverPath)) throw new Error('MCP serverPath 必须是绝对路径')
  if (!isAbsolute(input.databasePath)) throw new Error('任务数据库路径必须是绝对路径')
  const channelCount = input.channelCount ?? GLOBAL_CHANNEL_COUNT
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 16) {
    throw new Error('全局通道数无效')
  }

  const configPath = input.configPath ?? globalMcpConfigPath()
  const config = readConfig(configPath)
  const servers = config.mcpServers && typeof config.mcpServers === 'object'
    ? { ...config.mcpServers }
    : {}

  // S4：单一原生条目「qunshu」，通道由工具参数 channel_id 区分。
  const desired = new Map<string, unknown>()
  desired.set(QUNSHU_MCP_SERVER_NAME, {
    command: input.command,
    args: [input.serverPath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      QINGTIAN_TEAM_DB: input.databasePath,
      QINGTIAN_SERVER_ROLE: 'unified'
    }
  })
  const serverNames = [QUNSHU_MCP_SERVER_NAME]

  let changed = false
  for (const name of Object.keys(servers)) {
    const legacy = LEGACY_PREFIXES.some((prefix) => name.startsWith(prefix))
    const staleUnified = name.startsWith('qunshu-ch-') && !desired.has(name)
    if (legacy || staleUnified) {
      delete servers[name]
      changed = true
    }
  }
  for (const [name, entry] of desired) {
    if (JSON.stringify(servers[name]) !== JSON.stringify(entry)) {
      servers[name] = entry
      changed = true
    }
  }
  if (!changed) return { changed: false, configPath, serverNames }

  const next: McpConfig = { ...config, mcpServers: servers }
  mkdirSync(dirname(configPath), { recursive: true })
  let backupPath: string | undefined
  let mode = 0o600
  if (existsSync(configPath)) {
    mode = statSync(configPath).mode & 0o777
    backupPath = join(dirname(configPath), `${basename(configPath)}.qunshu-backup-${Date.now()}-${randomUUID().slice(0, 8)}`)
    copyFileSync(configPath, backupPath)
  }
  const temporaryPath = join(dirname(configPath), `.${basename(configPath)}.${randomUUID()}.tmp`)
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode })
  renameSync(temporaryPath, configPath)
  return { changed: true, configPath, serverNames }
}
