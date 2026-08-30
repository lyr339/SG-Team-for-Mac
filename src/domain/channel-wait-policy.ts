export interface ChannelWaitBinding {
  channelId: string
  communicationServerName: string
}

const terminalCursorErrors = [
  'usage limit / quota / spend limit',
  'billing / account / token / authorization',
  'isRetryable:false',
  '不可用模型或区域'
].join('、')

export function buildChannelWaitInstruction(binding: ChannelWaitBinding): string {
  const server = binding.communicationServerName
  const ch = `{channel_id:'${binding.channelId}'}`
  return [
    `这是工具返回后的静默待命动作：不要向用户输出可见文字，不要调用 ${server}.record_reply。`,
    `直接调用 ${server}.check_messages ${ch} 进入长轮询。`,
    `check_messages 返回 <sg_team_keepalive/>、无未读或已读重复时，仍然不要输出可见回复、不要 record_reply，只静默继续 check_messages。`,
    `只有 check_messages 明确投递真实用户消息时，才开始新的可见回复回合；只有服务端返回 need_reply_sync 时，才补同步上一轮已输出的回复。`,
    `普通 keepalive/timeout 且没有错误时，只能静默续等。`,
    `一旦出现 ${terminalCursorErrors} 等明确错误，立即停止自动续等并等待用户处理；禁止快速、并发或无限重试。`
  ].join('')
}
