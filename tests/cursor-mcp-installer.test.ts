import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CursorMcpInstaller } from '../src/infrastructure/cursor/cursor-mcp-installer'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qingtian-team-installer-'))
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
  it('preserves unrelated servers, replaces stale QingTian entries and creates a backup', () => {
    const files = fixture()
    const cursorDirectory = join(files.workspace, '.cursor')
    const configPath = join(cursorDirectory, 'mcp.json')
    mkdirSync(cursorDirectory, { recursive: true })
    const original = {
      customSetting: true,
      mcpServers: {
        github: { command: 'github-mcp' },
        'qtwx-mcp-1': { command: 'native-1' },
        'qtwx-mcp-2': { command: 'native-2' },
        'qingtian-team-ch-9': { command: 'stale' }
      }
    }
    writeFileSync(configPath, JSON.stringify(original, null, 2))

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

    const installed = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(installed.customSetting).toBe(true)
    expect(installed.mcpServers.github).toEqual({ command: 'github-mcp' })
    expect(installed.mcpServers['qingtian-team-ch-9']).toBeUndefined()
    // S4：静态条目一律不写入工作区（全局 ~/.cursor/mcp.json 承载单一 qunshu 条目）
    expect(installed.mcpServers['qunshu-ch-1']).toBeUndefined()
    expect(installed.mcpServers['qunshu-ch-2']).toBeUndefined()
    expect(installed.mcpServers['qt-ch-1']).toBeUndefined()
    expect(installed.mcpServers['qtwx-mcp-1']).toBeUndefined()
    expect(installed.mcpServers['qtwx-mcp-2']).toBeUndefined()
    expect(result.serverNames).toEqual(['qunshu'])
    expect(result.registrations.agents.map((agent) => agent.agentSessionId)).toEqual([
      `${result.workspaceId}:ch-1:generation123`,
      `${result.workspaceId}:ch-2:generation123`
    ])
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true)
    expect(JSON.parse(readFileSync(result.backupPath!, 'utf8'))).toEqual(original)
  })

  it('deduplicates channels when the paired native channel already exists', () => {
    const files = fixture()
    const cursorDirectory = join(files.workspace, '.cursor')
    mkdirSync(cursorDirectory, { recursive: true })
    writeFileSync(join(cursorDirectory, 'mcp.json'), JSON.stringify({
      mcpServers: { 'qtwx-mcp-1': { command: 'native-1' } }
    }))
    const result = new CursorMcpInstaller().install({
      workspacePath: files.workspace,
      channels: [
        channel('1'),
        channel('1')
      ],
      command: files.command,
      serverPath: files.server,
      databasePath: files.database,
      runId: 'team-run-main',
      generation: 'generation123'
    })
    expect(result.serverNames).toEqual(['qunshu'])
    expect(result.backupPath).toBeDefined()
    expect(existsSync(join(files.workspace, '.cursor', 'mcp.json'))).toBe(true)
  })

  it('installs a stable channel runtime without baking in a TeamRun or AgentSlot', () => {
    const files = fixture()
    const cursorDirectory = join(files.workspace, '.cursor')
    mkdirSync(cursorDirectory, { recursive: true })
    writeFileSync(join(cursorDirectory, 'mcp.json'), JSON.stringify({
      mcpServers: { 'qtwx-mcp-3': { command: 'native-3' } }
    }))
    const result = new CursorMcpInstaller().install({
      workspacePath: files.workspace,
      channels: [{ channelId: '3', capabilities: ['code', 'qa'] }],
      command: files.command,
      serverPath: files.server,
      databasePath: files.database,
      runId: 'team-run-main',
      generation: 'generation123'
    })
    const installed = JSON.parse(readFileSync(result.configPath, 'utf8'))
    expect(result.serverNames).toEqual(['qunshu'])
    expect(installed.mcpServers['qunshu-ch-3']).toBeUndefined()
    expect(installed.mcpServers['qunshu']).toBeUndefined()
  })

  it('global mode cleans workspace static entries and keeps registration idempotent', () => {
    const files = fixture()
    const cursorDirectory = join(files.workspace, '.cursor')
    const configPath = join(cursorDirectory, 'mcp.json')
    mkdirSync(cursorDirectory, { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      customSetting: true,
      mcpServers: {
        github: { command: 'github-mcp' },
        'qtwx-mcp-1': { command: 'native-1' },
        'qtwx-mcp-2': { command: 'native-2' },
        'qingtian-team-ch-1': { command: 'legacy-project-registration' },
        'qunshu-ch-9': { command: 'stale-unified' }
      }
    }))
    const installer = new CursorMcpInstaller()
    const install = () => installer.install({
      workspacePath: files.workspace,
      channels: [channel('1'), channel('2')],
      command: files.command,
      serverPath: files.server,
      databasePath: files.database,
      runId: 'team-run-main',
      generation: 'generation123',
      registrationMode: 'global'
    })

    const first = install()
    const project = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(project.customSetting).toBe(true)
    expect(project.mcpServers.github).toEqual({ command: 'github-mcp' })
    // global 模式：工作区静态条目全部让位（全局 mcp.json 拥有 qunshu-ch-N）
    expect(project.mcpServers['qtwx-mcp-1']).toBeUndefined()
    expect(project.mcpServers['qunshu-ch-9']).toBeUndefined()
    expect(Object.keys(project.mcpServers).some((name) => (
      name.startsWith('qingtian-team-ch-') || name.startsWith('qt-ch-') || name.startsWith('qtwx-mcp-') || name.startsWith('qunshu-ch-')
    ))).toBe(false)
    expect(first.serverNames).toEqual(['qunshu'])
    expect(first.restartRequired).toBe(true)
    expect(first.backupPath && existsSync(first.backupPath)).toBe(true)
    expect(install().restartRequired).toBe(false)
  })

  it('retains an inactive stable channel without forcing another Cursor reload', () => {
    const files = fixture()
    const cursorDirectory = join(files.workspace, '.cursor')
    mkdirSync(cursorDirectory, { recursive: true })
    writeFileSync(join(cursorDirectory, 'mcp.json'), JSON.stringify({
      mcpServers: {
        'qtwx-mcp-1': { command: 'native-1' },
        'qtwx-mcp-2': { command: 'native-2' }
      }
    }))
    const installer = new CursorMcpInstaller()
    const install = (channels: ReturnType<typeof channel>[]) => installer.install({
      workspacePath: files.workspace,
      channels,
      command: files.command,
      serverPath: files.server,
      databasePath: files.database,
      runId: 'team-run-main',
      generation: 'generation123'
    })
    expect(install([channel('1'), channel('2')]).restartRequired).toBe(true)
    const reduced = install([channel('1')])
    // 清理完成后配置稳定：缩减通道不再触发工作区配置变更
    expect(reduced.restartRequired).toBe(false)
  })

  it('installs the communication channel even when no plugin entry ever existed', () => {
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
    const installed = JSON.parse(readFileSync(result.configPath, 'utf8'))
    expect(installed.mcpServers['qunshu-ch-2']).toBeUndefined()
    expect(result.serverNames).toEqual(['qunshu'])
  })

  it('installs an explicitly listed unassigned channel as standby (takeover era)', () => {
    // 一体化后安装器不再以「插件 qtwx 条目是否存在」推断通道归属：
    // 通道集合由调用方（TeamControl 的 runtimeChannels）权威决定，
    // 显式列入的未分配通道按备用通道安装，与既有稳定通道语义一致。
    const files = fixture()
    const cursorDirectory = join(files.workspace, '.cursor')
    mkdirSync(cursorDirectory, { recursive: true })
    writeFileSync(join(cursorDirectory, 'mcp.json'), JSON.stringify({
      mcpServers: {
        'qtwx-mcp-1': { command: 'native-1' },
        'qingtian-team-ch-5': { command: 'stale-5' }
      }
    }))
    const result = new CursorMcpInstaller().install({
      workspacePath: files.workspace,
      channels: [channel('1'), { channelId: '5', capabilities: [] }],
      command: files.command,
      serverPath: files.server,
      databasePath: files.database,
      runId: 'team-run-main',
      generation: 'generation123',
      registrationMode: 'global'
    })
    expect(result.serverNames).toEqual(['qunshu'])
    expect(result.registrations.agents.map((agent) => agent.channelId)).toEqual(['1', '5'])
    // 不写工作区静态条目
    const project = JSON.parse(readFileSync(result.configPath, 'utf8'))
    expect(project.mcpServers['qunshu-ch-5']).toBeUndefined()
    expect(project.mcpServers['qunshu']).toBeUndefined()
  })

  it('refuses malformed existing JSON without changing it', () => {
    const files = fixture()
    const cursorDirectory = join(files.workspace, '.cursor')
    const configPath = join(cursorDirectory, 'mcp.json')
    mkdirSync(cursorDirectory, { recursive: true })
    writeFileSync(configPath, '{ broken json')

    expect(() => new CursorMcpInstaller().install({
      workspacePath: files.workspace,
      channels: [channel('1', ['coordination', 'planning'])],
      command: files.command,
      serverPath: files.server,
      databasePath: files.database,
      runId: 'team-run-main',
      generation: 'generation123'
    })).toThrowError(/已停止安装/)
    expect(readFileSync(configPath, 'utf8')).toBe('{ broken json')
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

  it('restores the original config if activating the agent generation fails', () => {
    const files = fixture()
    const cursorDirectory = join(files.workspace, '.cursor')
    const configPath = join(cursorDirectory, 'mcp.json')
    mkdirSync(cursorDirectory, { recursive: true })
    const original = `${JSON.stringify({
      mcpServers: {
        existing: { command: 'safe' },
        'qtwx-mcp-1': { command: 'native-1' }
      }
    }, null, 2)}\n`
    writeFileSync(configPath, original)

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
    expect(readFileSync(configPath, 'utf8')).toBe(original)
  })

  it('activates the installed generation in SQLite and revokes it on reinstall', () => {
    const files = fixture()
    const cursorDirectory = join(files.workspace, '.cursor')
    mkdirSync(cursorDirectory, { recursive: true })
    writeFileSync(join(cursorDirectory, 'mcp.json'), JSON.stringify({
      mcpServers: { 'qtwx-mcp-2': { command: 'native-2' } }
    }))
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
