import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CursorMcpInstaller } from '../src/infrastructure/cursor/cursor-mcp-installer'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sg-team-installer-'))
  const workspace = join(root, 'workspace')
  const command = join(root, 'Electron')
  const server = join(root, 'index.mjs')
  const database = join(root, 'task-pool.sqlite3')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(command, '')
  writeFileSync(server, '')
  writeFileSync(database, '')
  return { root, workspace, command, server, database }
}

function channel(channelId: string, capabilities: string[] = []) {
  return { channelId, slotId: `slot-${channelId}`, capabilities }
}

describe('CursorMcpInstaller', () => {
  it('registers one agent identity per channel and never touches the workspace mcp.json', () => {
    const files = fixture()
    const cursorDirectory = join(files.workspace, '.cursor')
    const configPath = join(cursorDirectory, 'mcp.json')
    mkdirSync(cursorDirectory, { recursive: true })
    const original = `${JSON.stringify({ customSetting: true, mcpServers: { github: { command: 'github-mcp' } } }, null, 2)}\n`
    writeFileSync(configPath, original)

    const result = new CursorMcpInstaller().install({
      workspacePath: files.workspace,
      channels: [
        channel('1', ['coordination', 'planning']),
        channel('2', ['code', 'architecture'])
      ],
      command: files.command,
      serverPath: files.server,
      databasePath: files.database,
      runId: 'team-run-main',
      generation: 'generation123'
    })

    // 用户自己的工作区配置原样保留：SG Team 只依赖全局原生条目。
    expect(readFileSync(configPath, 'utf8')).toBe(original)
    expect(result.configPath).toBe(configPath)
    expect(result.backupPath).toBeUndefined()
    expect(result.restartRequired).toBe(false)
    expect(result.serverNames).toEqual(['SG Team'])
    expect(result.registrations.agents.map((agent) => agent.agentSessionId)).toEqual([
      `${result.workspaceId}:ch-1:generation123`,
      `${result.workspaceId}:ch-2:generation123`
    ])
    expect(result.registrations.agents.map((agent) => agent.capabilities)).toEqual([
      ['coordination', 'planning'],
      ['code', 'architecture']
    ])
  })

  it('does not create a .cursor directory in a workspace that never had one', () => {
    const files = fixture()
    const result = new CursorMcpInstaller().install({
      workspacePath: files.workspace,
      channels: [channel('2', ['code', 'architecture'])],
      command: files.command,
      serverPath: files.server,
      databasePath: files.database,
      runId: 'team-run-main',
      generation: 'generation123'
    })
    expect(existsSync(join(files.workspace, '.cursor'))).toBe(false)
    expect(result.serverNames).toEqual(['SG Team'])
    expect(result.registrations.agents.map((agent) => agent.channelId)).toEqual(['2'])
  })

  it('deduplicates repeated channels', () => {
    const files = fixture()
    const result = new CursorMcpInstaller().install({
      workspacePath: files.workspace,
      channels: [channel('1'), channel('1')],
      command: files.command,
      serverPath: files.server,
      databasePath: files.database,
      runId: 'team-run-main',
      generation: 'generation123'
    })
    expect(result.registrations.agents.map((agent) => agent.channelId)).toEqual(['1'])
  })

  it('registers an explicitly listed unassigned channel as standby', () => {
    // 通道集合由调用方（TeamControl 的 runtimeChannels）权威决定：
    // 显式列入的未分配通道按备用通道登记，与既有稳定通道语义一致。
    const files = fixture()
    const result = new CursorMcpInstaller().install({
      workspacePath: files.workspace,
      channels: [channel('1'), { channelId: '5', capabilities: [] }],
      command: files.command,
      serverPath: files.server,
      databasePath: files.database,
      runId: 'team-run-main',
      generation: 'generation123'
    })
    expect(result.registrations.agents.map((agent) => agent.channelId)).toEqual(['1', '5'])
  })

  it('rejects invalid channel identifiers instead of silently skipping them', () => {
    const files = fixture()
    expect(() => new CursorMcpInstaller().install({
      workspacePath: files.workspace,
      channels: [channel('../2', ['code', 'architecture'])],
      command: files.command,
      serverPath: files.server,
      databasePath: files.database,
      runId: 'team-run-main'
    })).toThrowError(/通道号无效/)
  })

  it('propagates activation failures', () => {
    const files = fixture()
    expect(() => new CursorMcpInstaller().install({
      workspacePath: files.workspace,
      channels: [channel('1', ['code', 'architecture'])],
      command: files.command,
      serverPath: files.server,
      databasePath: files.database,
      runId: 'team-run-main',
      generation: 'generation123',
      activateAgents: () => {
        throw new Error('database unavailable')
      }
    })).toThrowError(/database unavailable/)
  })

  it('activates the installed generation in SQLite and revokes it on reinstall', () => {
    const files = fixture()
    const repository = new SqliteTaskPoolRepository(files.database)
    const installer = new CursorMcpInstaller()
    const install = (generation: string, runId = 'team-run-main') => installer.install({
      workspacePath: files.workspace,
      channels: [channel('2', ['code', 'architecture'])],
      command: files.command,
      serverPath: files.server,
      databasePath: files.database,
      runId,
      generation,
      activateAgents: (batch) => repository.replaceWorkspaceAgentRegistrations(batch)
    })

    const first = install('generation123')
    expect(() => repository.assertAgentAuthorized({
      agentSessionId: first.registrations.agents[0]!.agentSessionId,
      runId: 'team-run-main',
      capabilities: ['code', 'architecture']
    })).not.toThrow()

    const second = install('generation456', 'team-run-next')
    expect(second.restartRequired).toBe(false)
    expect(() => repository.assertAgentAuthorized({
      agentSessionId: first.registrations.agents[0]!.agentSessionId,
      runId: 'team-run-main',
      capabilities: ['code']
    })).toThrowError(/已被撤销/)
    expect(() => repository.assertAgentAuthorized({
      agentSessionId: second.registrations.agents[0]!.agentSessionId,
      runId: 'team-run-next',
      capabilities: ['architecture']
    })).not.toThrow()
    repository.close()
  })
})
