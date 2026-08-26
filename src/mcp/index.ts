import { isAbsolute } from 'node:path'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { TaskAgentService } from '../application/task-agent-service'
import { SqliteTaskPoolRepository } from '../infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamControlRepository } from '../infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamCollaborationRepository } from '../infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { TeamCollaborationAgentService } from '../application/team-collaboration-agent-service'
import { SqliteTeamMemoryRepository } from '../infrastructure/team-memory/sqlite-team-memory-repository'
import { TeamMemoryAgentService } from '../application/team-memory-agent-service'
import { SqliteChannelMessageRepository } from '../infrastructure/channel-messages/sqlite-channel-message-repository'
import { ChannelMessageService } from '../application/channel-message-service'
import { buildTeamRoleBriefing } from '../domain/team-control'
import { TaskPoolError } from '../domain/task-pool'
import { createUnifiedChannelServer } from './unified-channel-server'
import type { TeamChannelRuntime } from './team-tools'

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim() ?? ''
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

function databasePathOf(): string {
  const databasePath = requiredEnvironment('QINGTIAN_TEAM_DB')
  if (!isAbsolute(databasePath)) throw new Error('QINGTIAN_TEAM_DB 必须是绝对路径')
  return databasePath
}

/**
 * 群枢单一 MCP 服务器进程（S4）：
 * 一条「qunshu」条目承载团队工具 + 通信保活四工具，channel_id 区分通道；
 * 运行时按通道懒加载缓存，身份每次调用前实时解析（团队换届零配置重写）。
 */
async function serveUnified(databasePath: string): Promise<void> {
  const workspacePath = process.env.QINGTIAN_WORKSPACE_PATH?.trim() || undefined
  const repository = new SqliteTaskPoolRepository(databasePath)
  const teamRepository = new SqliteTeamControlRepository(databasePath)
  const collaborationRepository = new SqliteTeamCollaborationRepository(databasePath)
  const memoryRepository = new SqliteTeamMemoryRepository(databasePath)
  const channelRepository = new SqliteChannelMessageRepository(databasePath)

  const runtimes = new Map<string, TeamChannelRuntime>()
  const channelServices = new Map<string, ChannelMessageService>()

  const runtimeFor = (channelId: string): TeamChannelRuntime => {
    const cached = runtimes.get(channelId)
    if (cached) return cached
    const standbyIdentity = {
      agentSessionId: `qunshu:ch-${channelId}:standby`,
      runId: 'runtime-unassigned',
      slotId: `standby-slot:${channelId}`,
      capabilities: [] as string[]
    }
    const service = new TaskAgentService(repository, standbyIdentity, repository, teamRepository)
    const collaboration = new TeamCollaborationAgentService(
      collaborationRepository,
      { ...standbyIdentity },
      service
    )
    const memory = new TeamMemoryAgentService(
      memoryRepository,
      collaborationRepository,
      collaboration.identity
    )
    const runtime: TeamChannelRuntime = { service, collaboration, memory, controlRepository: teamRepository }
    runtimes.set(channelId, runtime)
    return runtime
  }

  // 工具调用即活性证据；身份换届在调用间实时生效，无需重启进程。
  const refreshIdentity = (channelId: string): void => {
    try {
      channelRepository.touchPresence(channelId, { lastSeenAt: Date.now() })
    } catch (error) {
      process.stderr.write(`[qunshu-mcp] presence 刷新失败：${error instanceof Error ? error.message : String(error)}\n`)
    }
    const runtime = runtimeFor(channelId)
    const identity = teamRepository.resolveChannelAgentIdentity(channelId)
    Object.assign(runtime.service.identity, identity)
    if (runtime.collaboration) Object.assign(runtime.collaboration.identity, identity)
  }

  const briefingFor = (channelId: string): string | undefined => {
    const runtime = runtimeFor(channelId)
    const identity = runtime.service.identity
    const state = teamRepository.loadTeamControl()
    const run = state.runs.find((candidate) => candidate.id === identity.runId)
    const slot = state.slots.find((candidate) => candidate.runId === identity.runId && candidate.id === identity.slotId)
    const role = slot
      ? state.roles.find((candidate) => candidate.runId === identity.runId && candidate.id === slot.roleId)
      : undefined
    const binding = state.bindings.find((candidate) => candidate.runId === identity.runId && candidate.slotId === identity.slotId)
    if (!run || !slot || !role || !binding) return undefined
    return buildTeamRoleBriefing({ run, role, slot, binding })
  }

  const channelServiceFor = (channelId: string): ChannelMessageService => {
    const cached = channelServices.get(channelId)
    if (cached) return cached
    const service = new ChannelMessageService(channelRepository)
    channelServices.set(channelId, service)
    return service
  }

  const handle = serveStdio(() => createUnifiedChannelServer({
    runtimeFor,
    channelServiceFor,
    refreshIdentity: (channelId) => {
      try {
        refreshIdentity(channelId)
      } catch (error) {
        // 未注册/未接替属正常待机：保留 standby 身份，由调用时围栏拒绝业务操作。
        if (!(error instanceof TaskPoolError)
          || (error.code !== 'standby_not_assigned' && error.code !== 'agent_not_authorized')) {
          throw error
        }
      }
    },
    briefingFor,
    workspacePath
  }), {
    onerror: (error) => process.stderr.write(`[qunshu-mcp] ${error.stack ?? error.message}\n`)
  })

  process.stderr.write('[qunshu-mcp] ready unified\n')

  let closing = false
  async function shutdown(): Promise<void> {
    if (closing) return
    closing = true
    try {
      await handle.close()
    } finally {
      channelRepository.close()
      memoryRepository.close()
      collaborationRepository.close()
      teamRepository.close()
      repository.close()
    }
  }
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
}

// 遗留角色名（team/channel，双条目时代条目）收敛到统一服务器。
const role = process.env.QINGTIAN_SERVER_ROLE?.trim() || 'unified'
if (role === 'unified' || role === 'team' || role === 'channel') {
  await serveUnified(databasePathOf())
} else {
  throw new Error(`QINGTIAN_SERVER_ROLE 无效：${role}`)
}
