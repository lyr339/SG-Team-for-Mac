import { formatFileSize } from '../shared/format-file-size'
import type { MessageAttachment } from './conversation-entry'

/**
 * 通道投递协议文本（一体化 S1）。
 *
 * check_messages 投递时拼接的系统后缀：Agent 侧保活行为与该协议文本
 * 形成稳定契约；工具名只有 check_messages / record_reply 两个，不再提供别名。
 */

export interface ChannelDeliveryContext {
  /** 是否本进程首次投递（完整协议说明只在首次出现）。 */
  isFirstDelivery: boolean
  /** 工作区路径（首投时以引用行展示）。 */
  workspacePath?: string
  /** 通道号（首投时展示 SG Team 通道名）。 */
  channelId: string
}

/**
 * 真实用户消息投递后缀的标题行。除了给 Agent 的协议提醒，它还是 Cursor 过程观察器
 * 判定「这次 check_messages 投递了用户可见消息」的正面证据：其后的 thinking 是
 * 业务思考而非轮询余波（keepalive 返回体、内部协作通知、need_reply_sync 都不含它）。
 */
export const CHANNEL_USER_DELIVERY_MARKER = '【真实用户消息处理完后进入 check_messages 待命】'

/**
 * 每次投递都带的两行提醒：只覆盖"这一轮结束时做什么"。协议全文在服务器说明与首次
 * 投递里各出现一次，不在每条消息后重复。
 */
const CALL_REMINDER = [
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  CHANNEL_USER_DELIVERY_MARKER,
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '- 处理真实用户消息并输出可见回复后，先 record_reply 同步同一份完整回复，再 check_messages 待命；没有输出用户可见回复时，不要为了“继续等待”而 record_reply',
  '- check_messages 返回 keepalive、无未读或已读重复时必须静默续等：不输出可见回复、不 record_reply、不用文字说“继续循环”代替调用'
].join('\n')

/** 构建投递消息的系统后缀。首次投递附「持续对话协议」，后续投递只附两行提醒。 */
export function buildDeliverySuffix(context: ChannelDeliveryContext): string {
  if (!context.isFirstDelivery) return `\n${CALL_REMINDER}`
  const ch = `channel_id:'${context.channelId}'`
  const lines = ['', '---', '## 持续对话协议', '']
  if (context.workspacePath) lines.push(`> 工作区：${context.workspacePath}`)
  if (context.channelId) lines.push(`> 当前通道：SG Team · CH-${context.channelId}`)
  lines.push(
    '',
    '这是一条来自拾光的用户消息。用户消息经 check_messages 按顺序送达，每次一条；你在 Cursor 里按平时的风格回答即可。',
    `回答完毕后调用 record_reply({ ${ch}, content:"完整可见回复" }) 同步正文，再调用 check_messages({ ${ch} }) 等待下一条；思考与工具过程由拾光直接读取 Cursor 原生会话事件，不用复述。`,
    '静默规则、会话围栏与终止条件以 SG Team 服务器说明为准；本说明只在首次送达出现。',
    CALL_REMINDER
  )
  return lines.join('\n')
}

/** 内部协作通知投递后缀：只驱动 team_message 回执，不进入用户可见回复协议。 */
export function buildSilentDeliverySuffix(context: Pick<ChannelDeliveryContext, 'channelId'>): string {
  return [
    '',
    '---',
    `【内部协作通知协议】这是 CH-${context.channelId} 的团队内部调度通知，不是用户可见对话。`,
    '按通知里的 messageId 调用 team_message({action:\'read\', messageId})；directive/question 处理后用 team_message({action:\'respond\', messageId, content}) 建立关联回应。',
    '不要向用户输出可见文字，不要调用 record_reply；处理完直接 check_messages 静默待命。'
  ].join('\n')
}

/** keepalive 返回体（Agent 静默续等契约标记）。 */
export function buildKeepaliveText(round: number): string {
  return `<sg_team_keepalive n="${round}"/>`
}

/** 同内容连发合并注记。 */
export function buildMergedNote(mergedCount: number): string {
  return mergedCount > 1
    ? `\n\n[注：用户在短时间内连续发送了 ${mergedCount} 次相同内容，已合并为一条]`
    : ''
}

/** 轮次与队列深度后缀。 */
export function buildTurnNote(turnCount: number, remainingQueue: number): string {
  return `\n\n[轮次 #${turnCount} · 队列剩余 ${remainingQueue} 条]`
}

/**
 * 附件投递清单（追加在消息原文之后、系统后缀之前）：
 * 图片按 MCP image 内容块随 check_messages 直接交给 Agent；非图片小文件按插件兼容格式
 * 内联进文本，清单只作为文件名/路径核对与大文件兜底。
 */
export function buildAttachmentManifest(
  attachments?: MessageAttachment[],
  options: {
    inlineImageCount?: number
    inlineTextFileCount?: number
    inlineBinaryFileCount?: number
    omittedFileCount?: number
  } = {}
): string {
  if (!attachments?.length) return ''
  const lines = ['', '---', `【用户随消息附带 ${attachments.length} 个附件】`]
  if (options.inlineImageCount) {
    lines.push(`已将 ${options.inlineImageCount} 个图片附件作为本次 MCP image 内容块直接附加；请优先基于图片内容判断，路径只用于核对原文件。若上下文中没有实际收到图像内容块（部分客户端不透传 MCP image），必须改用下方路径读取原图后再判断，禁止脱离原图凭对话上下文猜测图片内容。`)
  }
  const inlineFiles = (options.inlineTextFileCount ?? 0) + (options.inlineBinaryFileCount ?? 0)
  if (inlineFiles) {
    const parts = [
      options.inlineTextFileCount ? `${options.inlineTextFileCount} 个文本附件` : '',
      options.inlineBinaryFileCount ? `${options.inlineBinaryFileCount} 个二进制附件 Base64` : ''
    ].filter(Boolean)
    lines.push(`已在上方内联 ${parts.join('、')}；请优先基于内联内容判断。`)
  }
  if (options.omittedFileCount) {
    lines.push(`${options.omittedFileCount} 个非图片附件超过内联限制或读取失败，只保留原文件路径；需要时请按路径读取。`)
  }
  attachments.forEach((attachment, index) => {
    const head = `[附件 ${index + 1}] ${attachment.name}（${attachment.mimeType} · ${formatFileSize(attachment.size)}）`
    lines.push(attachment.path
      ? `${head} → 原文件路径：${attachment.path}`
      : `${head} → 仅元信息（内容未随消息传输）`)
  })
  return lines.join('\n')
}

/**
 * 存储瞬断文案：拾光桌面端启停时 SQLite 短暂锁住，或磁盘异常。retryable 时明确
 * 这不是围栏终止，让 Agent 原样重试；连续多次才请用户介入。
 */
export function buildStorageUnavailableMessage(input: { detail: string; retryable: boolean; failures: number }): string {
  if (input.retryable) {
    return [
      `拾光消息存储暂时不可用（${input.detail}）。`,
      '这不是会话围栏终止，也不需要用户处理：等待约 5 秒后原样重新调用同一工具（check_messages 续等 / record_reply 补同步），不要输出可见回复。'
    ].join('')
  }
  return [
    `拾光消息存储已连续 ${input.failures} 次不可用（${input.detail}）。`,
    '请停止自动重试，用一句话向用户说明拾光通道暂时不可用，然后等待用户处理。'
  ].join('')
}

/** 回复同步守门拒绝文案（对齐插件 need_reply_sync 指引）。 */
export function buildReplySyncRequiredMessage(groupChat: boolean): string {
  if (groupChat) {
    return [
      '上一轮群聊消息已经处理，但你还没有把群内可见完整回复同步到 SG Team。',
      '请先补同步，再继续调用 check_messages()。',
      '如果确实无法走流式，请至少调用 record_reply({ content:"你刚刚已经给用户的完整回复", groupId:"当前群组" }) 兜底归档。',
      '不要重新回答用户，不要开始新任务；只补同步上一轮已输出的完整正文。'
    ].join('\n')
  }
  return [
    '上一轮用户消息已经处理，但你还没有把刚刚写给用户的完整回复同步到 SG Team。',
    '请立即调用 record_reply({ content:"你刚刚已经输出给用户的完整回复" })，然后再调用 check_messages()。',
    '不要重新回答用户，不要改写内容，不要开始新任务；只补同步上一轮完整正文。'
  ].join('\n')
}
