import type { McpServer } from '@modelcontextprotocol/server'
import { readFileSync } from 'node:fs'
import * as z from 'zod/v4'
import type { ChannelMessageService } from '../application/channel-message-service'
import { CHANNEL_ATTACHMENT_MAX_FILE_BYTES } from '../domain/channel-message'
import {
  buildAttachmentManifest,
  buildDeliverySuffix,
  buildKeepaliveText,
  buildMergedNote,
  buildSilentDeliverySuffix,
  buildTurnNote
} from '../domain/channel-delivery-policy'
import type { MessageAttachment } from '../domain/conversation-entry'

export interface ChannelCommunicationDeps {
  /** 单服务器按 channel_id 解析通道消息服务。 */
  serviceFor(channelId: string): ChannelMessageService
  workspacePath?: string
  keepaliveTimeoutMs?: number
}

type ToolTextContent = { type: 'text'; text: string }
type ToolImageContent = { type: 'image'; data: string; mimeType: string }
type ToolContent = ToolTextContent | ToolImageContent
type ToolResult = { content: ToolContent[]; isError?: boolean }

const CHANNEL_ATTACHMENT_MAX_INLINE_FILE_BYTES = 512 * 1024
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.bash',
  '.bat',
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.env',
  '.go',
  '.h',
  '.hpp',
  '.htm',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.log',
  '.md',
  '.mdx',
  '.mjs',
  '.py',
  '.rs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh'
])

export function toolJson(payload: Record<string, unknown>, isError = false): ToolResult & { structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {})
  }
}

function attachmentBytes(attachment: MessageAttachment): Buffer | undefined {
  if (attachment.data) return Buffer.from(String(attachment.data), 'base64')
  if (attachment.path) return readFileSync(attachment.path)
  return undefined
}

function extensionOf(name: string): string {
  const match = name.toLowerCase().match(/(\.[a-z0-9]+)$/)
  return match?.[1] ?? ''
}

function isTextLikeAttachment(attachment: MessageAttachment): boolean {
  const mimeType = String(attachment.mimeType || '').toLowerCase()
  return mimeType.startsWith('text/')
    || mimeType === 'application/json'
    || mimeType === 'application/javascript'
    || mimeType === 'application/typescript'
    || mimeType === 'application/xml'
    || mimeType === 'application/x-ndjson'
    || TEXT_ATTACHMENT_EXTENSIONS.has(extensionOf(attachment.name))
}

interface InlineFileText {
  text: string
  textFileCount: number
  binaryFileCount: number
  omittedFileCount: number
}

function inlineFileText(attachments?: MessageAttachment[]): InlineFileText {
  if (!attachments?.length) {
    return { text: '', textFileCount: 0, binaryFileCount: 0, omittedFileCount: 0 }
  }
  const chunks: string[] = []
  let textFileCount = 0
  let binaryFileCount = 0
  let omittedFileCount = 0
  for (const attachment of attachments) {
    const mimeType = String(attachment.mimeType || 'application/octet-stream')
    if (mimeType.startsWith('image/')) continue
    try {
      const bytes = attachmentBytes(attachment)
      if (!bytes?.length || bytes.length > CHANNEL_ATTACHMENT_MAX_INLINE_FILE_BYTES) {
        omittedFileCount += 1
        continue
      }
      if (isTextLikeAttachment(attachment)) {
        textFileCount += 1
        chunks.push(`\n\n【附件: ${attachment.name}】\n${bytes.toString('utf8')}`)
      } else {
        binaryFileCount += 1
        chunks.push(`\n\n【二进制附件: ${attachment.name} (${mimeType})，Base64 如下】\n${bytes.toString('base64')}`)
      }
    } catch {
      omittedFileCount += 1
    }
  }
  return { text: chunks.join(''), textFileCount, binaryFileCount, omittedFileCount }
}

function inlineImageContentBlocks(attachments?: MessageAttachment[]): ToolImageContent[] {
  if (!attachments?.length) return []
  const blocks: ToolImageContent[] = []
  for (const attachment of attachments) {
    const mimeType = String(attachment.mimeType || '')
    if (!mimeType.startsWith('image/')) continue
    try {
      const bytes = attachmentBytes(attachment)
      if (!bytes?.length || bytes.length > CHANNEL_ATTACHMENT_MAX_FILE_BYTES) continue
      blocks.push({
        type: 'image',
        data: bytes.toString('base64'),
        mimeType
      })
    } catch {
      // 文本清单仍保留路径；图片块读取失败时让 Agent 明确按清单路径核对或要求重发。
    }
  }
  return blocks
}

const channelSchema = {
  channel_id: z.string().regex(/^\d+$/)
    .describe('群枢分配给当前 Agent 的通道号（如 "2"），启动指令中声明，每次调用必传')
}

/**
 * record_reply 过程区块契约（process v1）：与 domain/conversation-entry.ts 的
 * ProcessBlock 完全同构，主进程透出为 ConversationEntry.processBlocks 供前端展示。
 */
const processBlockSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tool'),
    id: z.string().min(1).max(120),
    toolName: z.string().min(1).max(160),
    toolKind: z.enum(['command', 'read', 'search', 'edit', 'write', 'mcp', 'todo', 'other']).optional()
      .describe('工具分组（图标/动作名由渲染层按组决定），缺省 other'),
    summary: z.string().max(300).optional()
      .describe('工具调用摘要（文件路径 / 命令行 / 关键词）'),
    input: z.record(z.string(), z.unknown()).optional()
      .describe('工具输入参数明细（JSON 可序列化）'),
    output: z.string().max(4_000).optional()
      .describe('工具执行输出摘要（超长由 Agent 侧截断）'),
    status: z.enum(['running', 'done', 'failed']),
    error: z.string().max(2_000).optional()
      .describe('status=failed 时的错误信息')
  }),
  z.object({
    kind: z.literal('thinking'),
    id: z.string().min(1).max(120),
    text: z.string().min(1).max(4_000),
    status: z.enum(['running', 'done'])
  }),
  z.object({
    kind: z.literal('command'),
    id: z.string().min(1).max(120),
    command: z.string().min(1).max(500),
    output: z.string().max(4_000),
    exitCode: z.number().int().optional(),
    status: z.enum(['running', 'done', 'failed'])
  })
])

/**
 * 通道通信四工具（check_messages / record_reply / qingtian / wait_messages）。
 * 工具名与参数契约对齐 qingtian-v2 插件（追加 channel_id 以适配单服务器）；
 * 队列与活性落群枢 SQLite，主进程直写直读。
 */
export function registerChannelCommunicationTools(
  server: McpServer,
  deps: ChannelCommunicationDeps
): void {
  const runCheck = async (
    channelId: string,
    input: { reply?: string },
    signal: AbortSignal
  ): Promise<ToolResult> => {
    const service = deps.serviceFor(channelId)
    const result = await service.checkMessages({
      channelId,
      reply: input.reply,
      signal,
      keepaliveTimeoutMs: deps.keepaliveTimeoutMs
    })
    switch (result.type) {
      case 'delivered': {
        const suffix = result.message.silent
          ? buildSilentDeliverySuffix({ channelId })
          : buildDeliverySuffix({
              isFirstDelivery: result.deliveredCount === 1,
              workspacePath: deps.workspacePath,
              channelId
            })
        const imageBlocks = inlineImageContentBlocks(result.message.attachments)
        const fileText = inlineFileText(result.message.attachments)
        const text = result.message.text
          + fileText.text
          + buildAttachmentManifest(result.message.attachments, {
              inlineImageCount: imageBlocks.length,
              inlineTextFileCount: fileText.textFileCount,
              inlineBinaryFileCount: fileText.binaryFileCount,
              omittedFileCount: fileText.omittedFileCount
            })
          + buildMergedNote(result.mergedCount)
          + suffix
          + buildTurnNote(result.turnCount, result.remainingQueue)
        return { content: [{ type: 'text' as const, text }, ...imageBlocks] }
      }
      case 'keepalive':
        return { content: [{ type: 'text' as const, text: buildKeepaliveText(result.round) }] }
      case 'reply_sync_required':
        return toolJson({
          ok: false,
          needReplySync: true,
          message: result.message
        }, true)
      case 'stopped':
        return {
          content: [{ type: 'text' as const, text: '[system] check_messages 等待被取消，结束本轮。' }],
          isError: true
        }
    }
  }

  server.registerTool(
    'check_messages',
    {
      title: '检查新消息',
      description: '长轮询等待并获取下一条用户消息；返回 <qingtian_keepalive/> 表示正常在岗，静默继续调用即可。只有收到 need_reply_sync 时才补 record_reply。',
      inputSchema: z.object(channelSchema).extend({
        reply: z.string().max(100_000).optional()
      }),
      annotations: { readOnlyHint: false, idempotentHint: false }
    },
    async ({ channel_id, reply }, ctx) => runCheck(channel_id, { reply }, ctx.mcpReq.signal)
  )

  server.registerTool(
    'record_process',
    {
      title: '流式上报过程区块',
      description: '把本轮正在执行的过程区块（工具调用 / 思考 / 命令执行）实时同步到群枢，软件界面随即将其渲染为进行中的过程流。按 block.id upsert：同一区块先报 running、完成后用同 id 再报 done/failed 即翻转状态。turn 为回合标识（每轮用户消息自定一个 uuid 并贯穿本轮）；回合收尾的 record_reply 带同 turn 即归档整批过程事件。',
      inputSchema: z.object(channelSchema).extend({
        turn: z.string().min(1).max(120)
          .describe('回合标识：本轮用户消息的唯一 id（自定 uuid），同一轮内所有过程块共用'),
        block: processBlockSchema
          .describe('过程区块：工具调用 / 思考 / 命令执行（与 record_reply 的 process 契约一致）')
      }),
      annotations: { readOnlyHint: false, idempotentHint: true }
    },
    async ({ channel_id, turn, block }) => {
      try {
        const service = deps.serviceFor(channel_id)
        const event = service.recordProcess({ channelId: channel_id, turn, block })
        return toolJson({
          ok: true,
          entry: {
            type: 'process_event',
            channelId: event.channelId,
            turn: event.turn,
            blockId: event.blockId,
            status: event.block.status
          }
        })
      } catch (error) {
        return toolJson({
          ok: false,
          code: 'record_process_failed',
          message: error instanceof Error ? error.message : String(error)
        }, true)
      }
    }
  )

  server.registerTool(
    'record_reply',
    {
      title: '同步完整可见回复',
      description: '把刚刚展示给用户的完整回复正文归档到群枢；每次用户可见回复后必须调用一次，再进入下一轮等待。可通过 process 字段顺带归档本轮过程区块（工具调用 / 思考 / 命令执行），群枢会话时间线将随消息一并展示；若本轮用 record_process 流式上报过过程，带上同一 turn 即可归档整批过程事件。注意：process 直带只是兜底归档，不能替代过程中的 record_process 流式上报——未流式上报的回合界面只能在回复落地后整批显示（用户视角即断流），此时返回会带 streamingWarning 提醒。',
      inputSchema: z.object(channelSchema).extend({
        content: z.string().min(1).max(100_000),
        title: z.string().max(200).optional(),
        groupId: z.string().max(100).optional(),
        taskId: z.string().max(100).optional(),
        files: z.array(z.string().max(500)).max(32).optional(),
        process: z.array(processBlockSchema).max(200).optional()
          .describe('本轮回复的过程区块（可选）：工具调用 / 思考 / 命令执行，随回复一并归档展示'),
        turn: z.string().min(1).max(120).optional()
          .describe('流式过程回合标识（可选）：与本轮 record_process 上报的 turn 一致，落地即归档整批过程事件')
      }),
      annotations: { readOnlyHint: false, idempotentHint: false }
    },
    async ({ channel_id, content, title, groupId, taskId, files, process, turn }) => {
      try {
        const service = deps.serviceFor(channel_id)
        const reply = service.recordReply({ channelId: channel_id, content, title, groupId, taskId, files, process, turn })
        const streamingWarning = (reply as { streamingWarning?: string }).streamingWarning
        return toolJson({
          ok: true,
          entry: {
            type: 'agent_reply',
            channelId: reply.channelId,
            title: reply.title ?? null,
            createdAt: reply.createdAt,
            processBlocks: reply.process?.length ?? 0
          },
          messageId: reply.id,
          ...(streamingWarning ? { streamingWarning } : {})
        })
      } catch (error) {
        return toolJson({
          ok: false,
          code: 'record_reply_failed',
          message: error instanceof Error ? error.message : String(error)
        }, true)
      }
    }
  )

  const waitDescription = '等待并获取下一条晴天桥接消息。keepalive/无未读时静默继续等待，不要输出可见回复；只有处理真实用户消息并展示回复后才 record_reply；不要用终端或脚本调用 MCP。'

  server.registerTool(
    'qingtian',
    {
      title: '晴天',
      description: waitDescription,
      inputSchema: z.object(channelSchema),
      annotations: { readOnlyHint: false, idempotentHint: false }
    },
    async ({ channel_id }, ctx) => runCheck(channel_id, {}, ctx.mcpReq.signal)
  )

  server.registerTool(
    'wait_messages',
    {
      title: '等待消息',
      description: waitDescription,
      inputSchema: z.object(channelSchema),
      annotations: { readOnlyHint: false, idempotentHint: false }
    },
    async ({ channel_id }, ctx) => runCheck(channel_id, {}, ctx.mcpReq.signal)
  )
}
