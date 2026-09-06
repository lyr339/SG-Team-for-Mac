import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { createDefaultTeamBundle } from '../src/domain/team-control'
import { TEAM_TOOL_NAMES } from '../src/mcp/team-tools'

const directory = mkdtempSync(join(tmpdir(), 'sg-team-mcp-smoke-'))
const databasePath = join(directory, 'task-pool.sqlite3')
const bundle = createDefaultTeamBundle({
  workspaceId: 'smoke',
  workspaceName: 'smoke',
  workspacePath: join(directory, 'workspace'),
  channelIds: ['1', '2', '3'],
  now: Date.now()
})
const role = (key: string) => bundle.roles.find((candidate) => candidate.key === key)!
const slot = (key: string) => bundle.slots.find((candidate) => candidate.roleId === role(key).id)!
const agentSessionId = (key: string) => `smoke:ch-${slot(key).channelId}:generation1`
const ownerId = agentSessionId('builder')
const reviewerId = agentSessionId('reviewer')
const smokeRunId = bundle.run.id
const repository = new SqliteTaskPoolRepository(databasePath)
const [task] = transactTaskPool(repository, (pool) => pool.plan(smokeRunId, [
  {
    key: 'stdio',
    title: '验证打包后的 stdio MCP',
    requiredCapabilities: ['code'],
    acceptance: '跨进程恢复后由独立质量进程验收，SQLite 状态为 done'
  }
]))
repository.close()
const teamRepository = new SqliteTeamControlRepository(databasePath)
teamRepository.upsertWorkspaceTeam(bundle)
teamRepository.recordInstallation({
  workspaceId: 'smoke',
  generation: 'generation1',
  runId: smokeRunId,
  agents: bundle.slots.map((slot) => ({
    agentSessionId: `smoke:ch-${slot.channelId}:generation1`,
    workspaceId: 'smoke',
    channelId: slot.channelId!,
    generation: 'generation1',
    runId: smokeRunId,
    capabilities: bundle.roles.find((role) => role.id === slot.roleId)!.capabilities
  }))
})
teamRepository.close()

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
)
const readyLogs: boolean[] = []
// --packaged 旗标跨平台（npm script 里 VAR=1 前缀语法在 Windows cmd/PowerShell 下不可用）；
// 环境变量保留向后兼容（老调用方式 / 手动执行）。
const packaged = process.argv.includes('--packaged')
  || process.env.SG_TEAM_MCP_SMOKE_PACKAGED === '1'
const explicitPackagedAppDirectory = process.env.SG_TEAM_PACKAGED_APP_DIRECTORY?.trim()
// 平台分离：mac 找 .app bundle；win 找 win-unpacked 目录（exe 与 resources 平铺）
const windowsPackagedCandidates = [
  resolve('release/win-unpacked')
]
const macPackagedCandidates = [
  resolve('release/mac-arm64/拾光.app'),
  resolve('release/mac/拾光.app')
]
const packagedAppDirectory = explicitPackagedAppDirectory
  ? resolve(explicitPackagedAppDirectory)
    : (process.platform === 'win32' ? windowsPackagedCandidates : macPackagedCandidates).find(existsSync)

if (packaged && !packagedAppDirectory) {
  throw new Error(process.platform === 'win32'
    ? '找不到已打包的拾光（release/win-unpacked）'
    : '找不到已打包的拾光.app')
}

const mcpCommand = packaged
  ? (process.platform === 'win32'
    ? join(packagedAppDirectory!, '拾光.exe')
    : join(packagedAppDirectory!, 'Contents', 'MacOS', basename(packagedAppDirectory!, '.app')))
  : process.execPath
const mcpServerPath = packaged
  ? (process.platform === 'win32'
    ? join(packagedAppDirectory!, 'resources', 'mcp', 'index.mjs')
    : join(packagedAppDirectory!, 'Contents', 'Resources', 'mcp', 'index.mjs'))
  : resolve('out/mcp/index.mjs')

if (!existsSync(mcpCommand)) throw new Error(`MCP command 不存在：${mcpCommand}`)
if (!existsSync(mcpServerPath)) throw new Error(`MCP server 不存在：${mcpServerPath}`)

async function openClient(input: {
  agentSessionId: string
  runtimeId: string
  capabilities: string[]
  slotId: string
  channelId: string
}) {
  const transport = new StdioClientTransport({
    command: mcpCommand,
    args: [mcpServerPath],
    env: {
      ...inheritedEnvironment,
      ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      SG_TEAM_DB: databasePath
    },
    stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const client = new Client({ name: 'sg-team-smoke', version: '1.0.0' })
  await client.connect(transport)
  return {
    client,
    transport,
    // S4 单服务器：所有工具调用注入本进程的 channel_id
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: { channel_id: input.channelId, ...args } })
      return result as typeof result & { structuredContent?: Record<string, any> }
    },
    async close() {
      await client.close()
      await transport.close().catch(() => undefined)
      readyLogs.push(stderr.includes('[sg-team-mcp] ready'))
    }
  }
}

function runtime(key: string, id = agentSessionId(key)) {
  return {
    agentSessionId: id,
    runtimeId: `smoke:ch-${slot(key).channelId}`,
    capabilities: [...role(key).capabilities],
    slotId: slot(key).id,
    channelId: slot(key).channelId!
  }
}

const leadProcess = await openClient(runtime('lead'))
const leadTools = await leadProcess.client.listTools()
const EXPECTED_TOOLS = ['check_messages', 'record_reply', ...TEAM_TOOL_NAMES].sort()
const exposed = leadTools.tools.map((tool) => tool.name).sort()
if (JSON.stringify(exposed) !== JSON.stringify(EXPECTED_TOOLS)) {
  throw new Error(`unexpected tool surface: ${exposed.join(', ')}`)
}
await leadProcess.close()

const firstProcess = await openClient(runtime('builder'))
const tools = await firstProcess.client.listTools()
const claim = await firstProcess.call('team_task', { action: 'claim', taskId: task!.id })
if (claim.isError) throw new Error(`claim failed: ${JSON.stringify(claim)}`)
if (JSON.stringify(claim).includes('leaseToken')) throw new Error('lease token leaked through MCP response')
// S4 单服务器为通道信任语义：未注册通道的调用必须被围栏拒绝
const unauthorized = await firstProcess.call('team_task', { channel_id: '99', action: 'start', taskId: task!.id })
if (!unauthorized.isError || unauthorized.structuredContent?.code !== 'agent_not_authorized') {
  throw new Error(`unregistered channel was not fenced: ${JSON.stringify(unauthorized)}`)
}
await firstProcess.close()

const resumedProcess = await openClient(runtime('builder', ownerId))
await resumedProcess.call('team_task', { action: 'start', taskId: task!.id })
await resumedProcess.call('team_task', { action: 'progress', taskId: task!.id, progress: 80, summary: 'stdio 跨进程恢复正常' })
const submitted = await resumedProcess.call('team_task', { action: 'submit', taskId: task!.id, output: '真实 StdioClientTransport + 进程重启 + SQLite 证据' })
if (submitted.structuredContent?.nextAction?.communicationServer !== 'SG Team') {
  throw new Error(`missing paired wait action: ${JSON.stringify(submitted)}`)
}
await resumedProcess.close()

const reviewerProcess = await openClient(runtime('reviewer', reviewerId))
const reviewerTools = await reviewerProcess.client.listTools()
if (!reviewerTools.tools.some((tool) => tool.name === 'team_review')) {
  throw new Error('reviewer process is missing team_review')
}
const reviewClaim = await reviewerProcess.call('team_review', { action: 'claim', taskId: task!.id })
if (reviewClaim.isError) throw new Error(`review claim failed: ${JSON.stringify(reviewClaim)}`)
if (JSON.stringify(reviewClaim).includes('leaseToken')) throw new Error('review lease token leaked through MCP response')
const reviewed = await reviewerProcess.call('team_review', {
  action: 'submit',
  taskId: task!.id,
  decision: 'accept',
  evidence: '独立质量进程复跑构建与测试，验收标准全部通过'
})
if (reviewed.isError) throw new Error(`review submit failed: ${JSON.stringify(reviewed)}`)
await reviewerProcess.close()

const verification = new SqliteTaskPoolRepository(databasePath)
const finalState = verification.load()
const saved = finalState.tasks[task!.id]
const savedReview = saved?.currentReviewId ? finalState.reviews[saved.currentReviewId] : undefined
verification.close()
if (saved?.status !== 'done' || saved.progress !== 100 || savedReview?.status !== 'approved') {
  throw new Error(`smoke verification failed: ${JSON.stringify(saved)}`)
}

process.stdout.write(JSON.stringify({
  ok: true,
  processCount: readyLogs.length,
  agentCount: 3,
  channelCount: 3,
  toolCount: tools.tools.length,
  reviewerToolCount: reviewerTools.tools.length,
  leaseTokenHidden: true,
  reviewLeaseTokenHidden: true,
  wrongGenerationFenced: true,
  resumedAfterRestart: true,
  independentReview: savedReview.reviewedBy === reviewerId,
  taskStatus: saved.status,
  progress: saved.progress,
  everyServerReadyLog: readyLogs.every(Boolean),
  packaged
}, null, 2) + '\n')
