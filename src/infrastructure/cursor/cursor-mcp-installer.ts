import { existsSync, realpathSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { AgentRegistrationBatch } from '../../application/agent-authorization'
import { SG_TEAM_MCP_SERVER_ID } from '../../domain/channel-message'
import { workspaceIdentityOf } from './workspace-identity'

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
  activateAgents?: (batch: AgentRegistrationBatch) => void
}

export interface CursorMcpInstallResult {
  workspacePath: string
  workspaceId: string
  generation: string
  serverNames: string[]
  registrations: AgentRegistrationBatch
}

function safeGeneration(value?: string): string {
  const generation = (value?.trim() || randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '')
  if (generation.length < 8 || generation.length > 80) throw new Error('generation 无效')
  return generation
}

/**
 * 把一批通道接入 Cursor：校验运行环境、为每个通道生成 Agent 注册身份并激活。
 * Cursor 侧只有启动时注册器写入的全局「SG Team」原生条目，这里不再改写任何 mcp.json。
 */
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
    const agents: AgentRegistrationBatch['agents'] = []
    for (const channel of channels) {
      const channelId = String(channel.channelId).trim()
      const capabilities = [...new Set(channel.capabilities.map((value) => value.trim()).filter(Boolean))]
      if (capabilities.length > 32 || capabilities.some((value) => value.length > 80)) {
        throw new Error(`CH-${channelId} 能力配置超出限制`)
      }
      agents.push({
        agentSessionId: `${workspaceId}:ch-${channelId}:${generation}`,
        runtimeId: `${workspaceId}:ch-${channelId}`,
        workspaceId,
        channelId,
        generation,
        runId: input.runId.trim(),
        capabilities
      })
    }
    if (!agents.length) throw new Error('当前没有可接入的拾光通道')
    const registrations: AgentRegistrationBatch = {
      workspaceId,
      generation,
      runId: input.runId.trim(),
      agents
    }
    input.activateAgents?.(registrations)

    return {
      workspacePath,
      workspaceId,
      generation,
      serverNames: [SG_TEAM_MCP_SERVER_ID],
      registrations
    }
  }
}
