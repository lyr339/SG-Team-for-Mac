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
import {
  buildSessionRetiredText,
  evaluateSessionFence,
  type ChannelSessionOwnership,
  type SessionFenceVerdict
} from '../domain/session-fence'

export interface ChannelCommunicationDeps {
  /** 单服务器按 channel_id 解析通道消息服务。 */
  serviceFor(channelId: string): ChannelMessageService
  /**
   * 会话围栏：解析通道在当前活动 run 内的归属（缺省 = 不围栏，全部放行）。
   * 调用携带 session 令牌时才校验；不携带保持旧语义。
   */
  ownershipFor?(channelId: string): ChannelSessionOwnership | undefined
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

function deliveredContentBlocks(input: {
  messageText: string
  attachments?: MessageAttachment[]
  imageBlocks: ToolImageContent[]
  fileText: InlineFileText
  mergedCount: number
  suffix: string
  turnCount: number
  remainingQueue: number
}): ToolContent[] {
  // 投递形态对齐 qingtian-v2 插件（已验证 Cursor 可正确透传）：
  // 全部文本合并为单个前导 text 块，image 块固定排在末尾；
  // 文本与图片交错（text,image,text…）会导致部分客户端丢失图片块。
  const userText = input.messageText.trim()
  const textParts: string[] = []
  if (userText) {
    textParts.push(userText)
  } else if (input.imageBlocks.length) {
    textParts.push('用户发送了图片附件：若上下文中已收到随附的图像内容块，直接基于图片分析；若没有收到（部分客户端不透传 MCP image），必须先按下方附件清单中的原文件路径用 Read 读取原图后再分析，禁止凭对话上下文猜测图片内容。')
  }
  const attachmentText = input.fileText.text
    + buildAttachmentManifest(input.attachments, {
        inlineImageCount: input.imageBlocks.length,
        inlineTextFileCount: input.fileText.textFileCount,
        inlineBinaryFileCount: input.fileText.binaryFileCount,
        omittedFileCount: input.fileText.omittedFileCount
      })
  if (attachmentText.trim()) {
    textParts.push(attachmentText.trim())
  }
  const protocolText = buildMergedNote(input.mergedCount)
    + input.suffix
    + buildTurnNote(input.turnCount, input.remainingQueue)
  if (protocolText.trim()) {
    textParts.push(protocolText.trim())
  }
  const blocks: ToolContent[] = []
  if (textParts.length) blocks.push({ type: 'text', text: textParts.join('\n\n') })
  blocks.push(...input.imageBlocks)
  return blocks.length ? blocks : [{ type: 'text', text: input.suffix.trimStart() }]
}

const channelSchema = {
  channel_id: z.string().regex(/^\d+$/)
    .describe('拾光分配给当前 Agent 的通道号（如 "2"），启动指令中声明，每次调用必传'),
  session: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/).optional()
    .describe('启动指令给出的会话令牌（session）；给出后每次调用都要附带，用于区分同一通道上的新旧会话。启动指令未给出时省略')
}

/**
 * 通道通信仅保留 check_messages / record_reply；过程流由 Cursor 原生 CDP 事件提供。
 * 队列与活性落拾光 SQLite，主进程直写直读。
 */
export function registerChannelCommunicationTools(
  server: McpServer,
  deps: ChannelCommunicationDeps
): void {
  // 围栏在任何 presence 写入之前判定：被拒绝的旧会话不得刷新新席位的心跳。
  // 归属查询异常 = 无法判定 → 放行（fail-open）：围栏只在证据确凿时拒绝。
  const fence = (channelId: string, session: string | undefined): SessionFenceVerdict => {
    if (!deps.ownershipFor || !session) return { status: 'legacy' }
    try {
      return evaluateSessionFence(deps.ownershipFor(channelId), session)
    } catch (error) {
      process.stderr.write(`[sg-team-mcp] 会话归属解析失败，围栏放行：${error instanceof Error ? error.message : String(error)}\n`)
      return { status: 'legacy' }
    }
  }

  const runCheck = async (
    channelId: string,
    input: { reply?: string; session?: string },
    signal: AbortSignal
  ): Promise<ToolResult> => {
    const verdict = fence(channelId, input.session)
    if (verdict.status === 'retired') {
      return { content: [{ type: 'text' as const, text: buildSessionRetiredText({ channelId, reason: verdict.reason }) }] }
    }
    const service = deps.serviceFor(channelId)
    const result = await service.checkMessages({
      channelId,
      reply: input.reply,
      // 围栏已放行的令牌继续下传：保持位消息（会话交接「等待新会话」）按令牌投递。
      session: input.session,
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
        return {
          content: deliveredContentBlocks({
            messageText: result.message.text,
            attachments: result.message.attachments,
            imageBlocks,
            fileText,
            mergedCount: result.mergedCount,
            suffix,
            turnCount: result.turnCount,
            remainingQueue: result.remainingQueue
          })
        }
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
      description: '长轮询等待并获取下一条用户消息；返回 <sg_team_keepalive/> 表示正常在岗，静默继续调用即可。只有收到 need_reply_sync 时才补 record_reply。',
      inputSchema: z.object(channelSchema).extend({
        reply: z.string().max(100_000).optional()
      }),
      annotations: { readOnlyHint: false, idempotentHint: false }
    },
    async ({ channel_id, reply, session }, ctx) => runCheck(channel_id, { reply, session }, ctx.mcpReq.signal)
  )


  server.registerTool(
    'record_reply',
    {
      title: '同步完整可见回复',
      description: '把刚刚展示给用户的完整回复正文归档到拾光；每次用户可见回复后必须调用一次，再进入下一轮等待。过程流由拾光直接读取 Cursor 原生内存事件，本工具不接收过程数据。',
      inputSchema: z.object(channelSchema).extend({
        content: z.string().min(1).max(100_000),
        title: z.string().max(200).optional(),
        groupId: z.string().max(100).optional(),
        taskId: z.string().max(100).optional(),
        files: z.array(z.string().max(500)).max(32).optional()
      }),
      annotations: { readOnlyHint: false, idempotentHint: false }
    },
    async ({ channel_id, session, content, title, groupId, taskId, files }) => {
      const verdict = fence(channel_id, session)
      if (verdict.status === 'retired') {
        return toolJson({
          ok: false,
          code: 'session_retired',
          message: buildSessionRetiredText({ channelId: channel_id, reason: verdict.reason })
        }, true)
      }
      try {
        const service = deps.serviceFor(channel_id)
        const reply = service.recordReply({ channelId: channel_id, content, title, groupId, taskId, files })
        return toolJson({
          ok: true,
          entry: {
            type: 'agent_reply',
            channelId: reply.channelId,
            title: reply.title ?? null,
            visible: reply.visible !== false,
            createdAt: reply.createdAt
          },
          messageId: reply.id
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
}
