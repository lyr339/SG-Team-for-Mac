import { McpServer } from '@modelcontextprotocol/server'
import type { ChannelMessageService } from '../application/channel-message-service'
import { QUNSHU_MCP_SERVER_NAME } from '../domain/channel-message'
import {
  registerChannelCommunicationTools
} from './channel-communication-tools'
import {
  buildUnifiedServerInstructions,
  registerTeamTools,
  type TeamChannelRuntime
} from './team-tools'

export interface UnifiedChannelServerOptions {
  /** 按 channel_id 懒加载/缓存团队运行时（未注册通道抛授权错误）。 */
  runtimeFor(channelId: string): TeamChannelRuntime
  /** 按 channel_id 解析通道消息服务。 */
  channelServiceFor(channelId: string): ChannelMessageService
  refreshIdentity?: (channelId: string) => void
  /** team_check_in 返回的角色简报（S4 底层注入）。 */
  briefingFor?: (channelId: string) => string | undefined
  workspacePath?: string
  /** keepalive 返回前的空队列等待时长；测试可注入短值，生产用默认 60s。 */
  keepaliveTimeoutMs?: number
}

/**
 * 群枢单一 MCP 服务器（S4）：Cursor 面板只出现一条原生条目「qunshu」，
 * 团队工具与通信保活四工具同服，全部以 channel_id 参数区分通道；
 * 角色权限按每次调用的通道身份围栏校验（暴露超集、调用时收口）。
 */
export function createUnifiedChannelServer(options: UnifiedChannelServerOptions): McpServer {
  const server = new McpServer(
    { name: QUNSHU_MCP_SERVER_NAME, version: '1.0.0' },
    { instructions: buildUnifiedServerInstructions() }
  )
  registerTeamTools(server, {
    runtimeFor: options.runtimeFor,
    refreshIdentity: options.refreshIdentity,
    briefingFor: options.briefingFor,
    exposeAllRoleTools: true
  })
  registerChannelCommunicationTools(server, {
    serviceFor: options.channelServiceFor,
    workspacePath: options.workspacePath,
    keepaliveTimeoutMs: options.keepaliveTimeoutMs
  })
  return server
}
