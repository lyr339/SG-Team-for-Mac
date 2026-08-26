import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migratePluginQueueFile } from '../src/infrastructure/channel-messages/plugin-queue-migration'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qingtian-plugin-migration-'))
  const queueRoot = join(root, 'messages')
  const repository = new SqliteChannelMessageRepository(join(root, 'channel.sqlite3'))
  return { root, queueRoot, repository }
}

function writePluginQueue(queueRoot: string, channelId: string, messages: unknown[]): string {
  const directory = join(queueRoot, 's', channelId)
  mkdirSync(directory, { recursive: true })
  const queuePath = join(directory, 'messages.json')
  writeFileSync(queuePath, JSON.stringify({ messages }))
  return queuePath
}

describe('migratePluginQueueFile', () => {
  it('imports pending plugin queue messages and archives the file idempotently', () => {
    const { queueRoot, repository } = fixture()
    try {
      const queuePath = writePluginQueue(queueRoot, '1', [
        { text: '插件时代的未读一', timestamp: 1_000 },
        { text: '插件时代的未读二', timestamp: 2_000 },
        { text: '   ', timestamp: 3_000 },
        'garbage'
      ])
      const result = migratePluginQueueFile(repository, '1', queueRoot)
      expect(result).toMatchObject({ channelId: '1', imported: 2, skipped: false })
      expect(repository.listPendingOutbound('1').map((message) => message.text)).toEqual([
        '插件时代的未读一',
        '插件时代的未读二'
      ])
      expect(repository.listPendingOutbound('1').map((message) => message.createdAt)).toEqual([1_000, 2_000])
      expect(existsSync(queuePath)).toBe(false)
      // 幂等：再次执行不再导入
      const again = migratePluginQueueFile(repository, '1', queueRoot)
      expect(again).toMatchObject({ imported: 0, skipped: true })
      expect(repository.countPendingOutbound('1')).toBe(2)
    } finally {
      repository.close()
    }
  })

  it('skips channels without a plugin queue file', () => {
    const { queueRoot, repository } = fixture()
    try {
      const result = migratePluginQueueFile(repository, '7', queueRoot)
      expect(result).toMatchObject({ channelId: '7', imported: 0, skipped: true })
    } finally {
      repository.close()
    }
  })

  it('refuses invalid channel ids and broken queue files without throwing', () => {
    const { queueRoot, repository } = fixture()
    try {
      expect(migratePluginQueueFile(repository, '../1', queueRoot).skipped).toBe(true)
      const queuePath = writePluginQueue(queueRoot, '2', [])
      writeFileSync(queuePath, '{ broken')
      const result = migratePluginQueueFile(repository, '2', queueRoot)
      expect(result).toMatchObject({ imported: 0, skipped: true })
      expect(result.detail).toContain('读取失败')
    } finally {
      repository.close()
    }
  })
})
