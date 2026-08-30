import { formatFileSize } from '../shared/format-file-size'
import type { MessageAttachment } from './conversation-entry'

/**
 * 通道投递协议文本（一体化 S1）。
 *
 * check_messages 投递时拼接的系统后缀：Agent 侧保活行为与该协议文本
 * 形成稳定契约；2026-08 起工具名统一为 check_messages（旧 qingtian /
 * wait_messages 别名已移除，依赖旧别名的会话需重开后生效新协议）。
 */

export interface ChannelDeliveryContext {
  /** 是否本进程首次投递（完整协议说明只在首次出现）。 */
  isFirstDelivery: boolean
  /** 工作区路径（首投时以引用行展示）。 */
  workspacePath?: string
  /** 通道号（首投时展示 SG Team 通道名）。 */
  channelId: string
}

const CALL_REMINDER = [
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '【真实用户消息处理完后进入 check_messages 待命】',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '- 思考、工具调用与输出由拾光直接读取 Cursor 原生会话事件；不要额外复述或上报过程',
  '- 处理真实用户消息并输出可见回复后，先 record_reply 同步完整可见回复，再调用 check_messages 待命',
  '- 没有输出用户可见回复时，不要为了“继续等待”而 record_reply',
  '- 不要用文字说「我会继续循环」代替调用 —— 那样本回合就结束了，用户端会看到对话中断',
  '- Every user-visible reply must be synced once with record_reply({ content: "the same full reply you just showed the user" }) before calling check_messages again, otherwise SG Team cannot restore the session reliably after a disconnect.',
  '- check_messages 返回 keepalive、无未读或已读重复时必须静默续等（keepalive 形如 <sg_team_keepalive/>）：不要向用户输出“继续等待/已读过/继续轮询”等可见回复，也不要 record_reply；直接再次调用 check_messages 静默待命。',
  '- 不要使用终端、Shell、Node 脚本或本地命令来调用 MCP；必须使用 Cursor 原生 MCP 工具调用',
  '- 这是长连接协议，不是一次性查询；未收到用户「停止/退出」时一律继续轮询'
].join('\n')

/**
 * 构建投递消息的系统后缀。首次投递附完整「持续对话协议」说明，
 * 后续投递只附精简的调用提醒。
 */
export function buildDeliverySuffix(context: ChannelDeliveryContext): string {
  if (!context.isFirstDelivery) return `\n${CALL_REMINDER}`
  const lines = [
    '',
    '---',
    '## 持续对话协议',
    ''
  ]
  if (context.workspacePath) lines.push(`> 工作区：${context.workspacePath}`)
  if (context.channelId) lines.push(`> 当前通道：SG Team · CH-${context.channelId}`)
  lines.push(
    '',
    '这是一条来自拾光的用户消息，系统正处于「持续对话」工作模式：',
    '',
    '1. 用户消息通过 check_messages（SG Team · 拾光）按顺序送达，每次调用获取一条',
    '2. 你在 Cursor 窗口按平时的风格正常回答用户即可',
    '3. 回答完毕后调用 record_reply({ content:"完整可见回复" }) 同步正文，再调用 check_messages（SG Team · 拾光）等待下一条；思考与工具过程由拾光直接读取 Cursor 原生会话事件',
    '4. 用文字描述「我会继续循环」而不再实际调用工具 = 本回合终止，用户端会中断对话',
    '5. check_messages 返回 keepalive、无未读或已读重复时必须静默续等：不要写可见消息，不要 record_reply',
    '6. 不要打开终端、Shell、Node 脚本或本地命令来调用 MCP；只使用 Cursor 原生 MCP 工具调用',
    '',
    '（本协议说明仅在首次送达时出现，后续消息会简化提示。）',
    CALL_REMINDER
  )
  return lines.join('\n')
}

/** 内部协作通知投递后缀：只驱动 team_* 回执，不进入用户可见回复协议。 */
export function buildSilentDeliverySuffix(context: Pick<ChannelDeliveryContext, 'channelId'>): string {
  return [
    '',
    '---',
    '【内部协作通知协议】',
    `- 这是 CH-${context.channelId} 的团队内部调度通知，不是用户可见对话。`,
    '- 按通知里的 messageId 调用 team_read_message；directive/question 处理后用 team_respond_message 建立关联回应。',
    '- 不要向用户输出可见文字，不要调用 record_reply；处理完直接调用 check_messages 静默待命。',
    '- 只有 check_messages 明确投递真实用户消息，或服务端返回 need_reply_sync 时，才进入用户可见回复同步流程。'
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
