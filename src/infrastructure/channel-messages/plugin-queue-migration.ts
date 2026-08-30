import { existsSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SqliteChannelMessageRepository } from './sqlite-channel-message-repository'

const MAX_QUEUE_FILE_BYTES = 2 * 1024 * 1024
const MAX_IMPORT_MESSAGES = 200
const MAX_IMPORT_TEXT_CHARS = 100_000

function pluginQueueRoot(): string {
  return join(homedir(), '.cursor', 'qingtian-runtime', 'messages')
}

export interface PluginQueueMigrationResult {
  channelId: string
  imported: number
  skipped: boolean
  detail: string
}

/**
 * 一次性迁移 qingtian-v2 插件文件队列中的未读消息（一体化 S1 切换前排空）。
 *
 * 插件队列位于 ~/.cursor/qingtian-runtime/messages/s/<channelId>/messages.json。
 * 接管 qtwx-mcp-N 后插件 server 不再被调用，存量消息必须迁入拾光 SQLite
 * （channel_outbox），否则用户已发送但未投递的消息会永久滞留。
 * 迁移成功后原文件改名归档，保证幂等（重复执行不会二次导入）。
 */
export function migratePluginQueueFile(
  repository: SqliteChannelMessageRepository,
  channelId: string,
  queueRoot = pluginQueueRoot()
): PluginQueueMigrationResult {
  const normalizedChannel = String(channelId).trim()
  if (!/^\d+$/.test(normalizedChannel)) {
    return { channelId: normalizedChannel, imported: 0, skipped: true, detail: '通道号无效' }
  }
  const queuePath = join(queueRoot, 's', normalizedChannel, 'messages.json')
  if (!existsSync(queuePath)) {
    return { channelId: normalizedChannel, imported: 0, skipped: true, detail: '无插件队列文件' }
  }

  let messages: unknown[]
  try {
    const raw = readFileSync(queuePath, 'utf8')
    if (raw.length > MAX_QUEUE_FILE_BYTES) throw new Error('队列文件过大')
    const parsed = JSON.parse(raw) as { messages?: unknown }
    messages = Array.isArray(parsed?.messages) ? parsed.messages : []
  } catch (error) {
    return {
      channelId: normalizedChannel,
      imported: 0,
      skipped: true,
      detail: `插件队列读取失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!messages.length) {
    return { channelId: normalizedChannel, imported: 0, skipped: true, detail: '插件队列为空' }
  }

  let imported = 0
  for (const candidate of messages.slice(0, MAX_IMPORT_MESSAGES)) {
    const record = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : undefined
    const text = typeof record?.text === 'string' ? record.text.trim() : ''
    if (!text || text.length > MAX_IMPORT_TEXT_CHARS) continue
    const timestamp = typeof record?.timestamp === 'number' && Number.isFinite(record.timestamp)
      ? record.timestamp
      : Date.now()
    try {
      repository.enqueueOutbound(normalizedChannel, text, timestamp)
      imported += 1
    } catch {
      // 队列上限等约束失败时停止导入，剩余消息保留在归档文件中人工处置
      break
    }
  }

  try {
    renameSync(queuePath, `${queuePath}.sg-team-migrated-${Date.now()}`)
  } catch (error) {
    return {
      channelId: normalizedChannel,
      imported,
      skipped: false,
      detail: `已导入 ${imported} 条，但插件队列归档失败（存在重复导入风险）：${error instanceof Error ? error.message : String(error)}`
    }
  }
  return {
    channelId: normalizedChannel,
    imported,
    skipped: false,
    detail: imported > 0 ? `已迁移 ${imported} 条未读消息` : '无可迁移消息'
  }
}
