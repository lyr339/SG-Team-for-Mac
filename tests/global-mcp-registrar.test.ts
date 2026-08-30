import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reconcileGlobalChannelServers } from '../src/infrastructure/cursor/global-mcp-registrar'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qunshu-global-mcp-'))
  const configPath = join(root, '.cursor', 'mcp.json')
  const command = join(root, 'Electron')
  const server = join(root, 'index.mjs')
  const database = join(root, 'task-pool.sqlite3')
  mkdirSync(join(root, '.cursor'), { recursive: true })
  writeFileSync(command, '')
  writeFileSync(server, '')
  writeFileSync(database, '')
  return { root, configPath, command, server, database }
}

function inputOf(files: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  return {
    command: files.command,
    serverPath: files.server,
    databasePath: files.database,
    channelCount: 2,
    configPath: files.configPath,
    ...extra
  }
}

describe('global mcp registrar', () => {
  it('creates the native SG Team entry and preserves unrelated servers', () => {
    const files = fixture()
    writeFileSync(files.configPath, JSON.stringify({
      mcpServers: { 'zhimo-mcp': { command: 'zhimo' } }
    }))
    const result = reconcileGlobalChannelServers(inputOf(files))
    expect(result.changed).toBe(true)
    expect(result.serverNames).toEqual(['SG Team'])
    const config = JSON.parse(readFileSync(files.configPath, 'utf8'))
    expect(config.mcpServers['zhimo-mcp']).toEqual({ command: 'zhimo' })
    expect(config.mcpServers['SG Team']).toMatchObject({
      command: files.command,
      args: [files.server],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        SG_TEAM_SERVER_ROLE: 'unified'
      }
    })
    // 幂等：二次调用无变更
    expect(reconcileGlobalChannelServers(inputOf(files)).changed).toBe(false)
  })

  it('strips legacy dual-era entries on reconcile', () => {
    const files = fixture()
    writeFileSync(files.configPath, JSON.stringify({
      mcpServers: {
        'qt-ch-1': { command: 'old-team' },
        'qtwx-mcp-1': { command: 'old-channel' },
        'qingtian-team-ch-2': { command: 'ancient' },
        'qunshu': { command: 'old-unified' },
        'qunshu-ch-9': { command: 'stale' }
      }
    }))
    reconcileGlobalChannelServers(inputOf(files))
    const config = JSON.parse(readFileSync(files.configPath, 'utf8'))
    expect(Object.keys(config.mcpServers)).toEqual(['SG Team'])
  })

  it('refuses malformed global config without touching it', () => {
    const files = fixture()
    writeFileSync(files.configPath, '{ broken')
    expect(() => reconcileGlobalChannelServers(inputOf(files))).toThrowError(/已停止注册/)
    expect(readFileSync(files.configPath, 'utf8')).toBe('{ broken')
  })
})
