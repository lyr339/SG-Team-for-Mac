/**
 * 一体化 S3-1 统一通道 MCP 冒烟（真实 stdio + 构建产物）：
 * - unified 角色（SG Team 单条目）：通信三工具 + 团队工具同服，
 *   投递/守门/同步/再投递全链路，身份按 channelId 实时解析；
 * - 活性钩子：团队工具调用同样刷新通道 presence（S2 红利保留）。
 *
 * 运行：npm run build:mcp 之后 npx tsx scripts/verify-channel-mcp.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { createDefaultTeamBundle } from '../src/domain/team-control'

const directory = mkdtempSync(join(tmpdir(), 'qingtian-channel-mcp-smoke-'))
const databasePath = join(directory, 'task-pool.sqlite3')
const mcpServerPath = resolve('out/mcp/index.mjs')

const bundle = createDefaultTeamBundle({
  workspaceId: 'smoke',
  workspaceName: 'smoke',
  workspacePath: join(directory, 'workspace'),
  channelIds: ['1'],
  now: Date.now()
})
const teamRepository = new SqliteTeamControlRepository(databasePath)
teamRepository.upsertWorkspaceTeam(bundle)
teamRepository.recordInstallation({
  workspaceId: 'smoke',
  generation: 'generation1',
  runId: bundle.run.id,
  agents: bundle.slots.map((slot) => ({
    agentSessionId: `smoke:ch-${slot.channelId}:generation1`,
    workspaceId: 'smoke',
    channelId: slot.channelId!,
    generation: 'generation1',
    runId: bundle.run.id,
    capabilities: bundle.roles.find((role) => role.id === slot.roleId)!.capabilities
  }))
})
teamRepository.close()
// 触发任务池库结构创建（与生产同库）
new SqliteTaskPoolRepository(databasePath).close()

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
)

async function openUnifiedClient(channelId: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerPath],
    env: {
      ...inheritedEnvironment,
      SG_TEAM_DB: databasePath,
      SG_TEAM_SERVER_ROLE: 'unified',
      SG_TEAM_WORKSPACE_PATH: join(directory, 'workspace')
    },
    stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
  const client = new Client({ name: 'sg-team-channel-smoke', version: '1.0.0' })
  await client.connect(transport)
  return {
    client,
    stderr: () => stderr,
    async close() {
      await client.close()
      await transport.close().catch(() => undefined)
    }
  }
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? '')
    .join('\n')
}

// ── 统一服务器：通信三工具 + 团队工具同服 ────────────────────────────
const repository = new SqliteChannelMessageRepository(databasePath)
repository.enqueueOutbound('1', '冒烟：请审查统一通道服务器', 1_000)

const channel = await openUnifiedClient('1')
const toolNames = (await channel.client.listTools()).tools.map((tool) => tool.name).sort()
for (const expected of ['check_messages', 'record_reply', 'team_check_in', 'team_list_mine']) {
  if (!toolNames.includes(expected)) throw new Error(`统一服务器缺少工具 ${expected}：${toolNames}`)
}

// ── 投递 → 守门 → 同步 → 再投递 ─────────────────────────────────────
const delivered = await channel.client.callTool({ name: 'check_messages', arguments: { channel_id: '1' } }, { timeout: 10_000 })
if (delivered.isError) throw new Error(`投递失败：${textOf(delivered)}`)
const deliveredText = textOf(delivered)
if (!deliveredText.includes('冒烟：请审查统一通道服务器')) throw new Error('投递正文缺失')
if (!deliveredText.includes('持续对话协议')) throw new Error('首投协议后缀缺失')
if (!deliveredText.includes('SG Team · CH-1')) throw new Error('统一服务器名未进入投递后缀')
if (!deliveredText.includes('[轮次 #1 · 队列剩余 0 条]')) throw new Error('轮次后缀缺失')

repository.enqueueOutbound('1', '第二条消息', 2_000)
const fenced = await channel.client.callTool({ name: 'check_messages', arguments: { channel_id: '1' } }, { timeout: 10_000 })
if (!fenced.isError) throw new Error('回复同步守门未生效')
const fencedPayload = JSON.parse(textOf(fenced)) as { needReplySync?: boolean }
if (fencedPayload.needReplySync !== true) throw new Error(`守门返回结构异常：${textOf(fenced)}`)

const recorded = await channel.client.callTool({
  name: 'record_reply',
  arguments: { channel_id: '1', content: '冒烟回复：审查完成，无阻塞问题。' }
}, { timeout: 10_000 })
if (recorded.isError) throw new Error(`record_reply 失败：${textOf(recorded)}`)
if ((recorded.structuredContent as { ok?: boolean })?.ok !== true) throw new Error('record_reply 未返回 ok')

const second = await channel.client.callTool({ name: 'check_messages', arguments: { channel_id: '1' } }, { timeout: 10_000 })
if (second.isError || !textOf(second).includes('第二条消息')) {
  throw new Error(`守门放行后投递失败：${textOf(second)}`)
}

const presence = repository.getPresence('1')
if (!presence || presence.deliveredCount !== 2 || presence.turnCount < 3) {
  throw new Error(`presence 计数异常：${JSON.stringify(presence)}`)
}
if (Date.now() - presence.lastSeenAt > 10_000) throw new Error('presence 心跳未刷新')
await channel.close()
if (!channel.stderr().includes('[sg-team-mcp] ready unified')) {
  throw new Error(`统一服务器就绪日志缺失：${channel.stderr()}`)
}

// ── 团队工具同服：调用刷新通道 presence（S2 活性钩子保留）────────────
// refreshIdentity 先于业务校验执行——即使业务拒绝（TeamRun 未启动），
// 活性也必须已刷新（工具被调用本身即 Agent 存活证据）。
const before = Date.now() - 60_000
repository.touchPresence('1', { lastSeenAt: before })
const team = await openUnifiedClient('1')
await team.client.callTool({ name: 'team_check_in', arguments: { channel_id: '1' } }, { timeout: 10_000 })
await team.close()
const touched = repository.getPresence('1')
if (!touched || touched.lastSeenAt <= before) {
  throw new Error('统一服务器团队工具调用未刷新通道 presence')
}
repository.close()

process.stdout.write(JSON.stringify({
  ok: true,
  unifiedTools: toolNames,
  deliveredWithProtocolSuffix: true,
  unifiedServerNameInSuffix: true,
  replySyncGateEnforced: true,
  recordReplyReleased: true,
  secondDeliveryOk: true,
  presenceHeartbeatFresh: true,
  teamToolCallRefreshesPresence: true
}, null, 2) + '\n')
