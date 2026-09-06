export interface ChannelWaitBinding {
  channelId: string
  communicationServerName: string
}

/**
 * 工具返回后的待命动作说明：只说"现在做什么"。静默规则、终止条件等协议细则由
 * 服务器说明承担，不在每次工具结果里重复。
 */
export function buildChannelWaitInstruction(binding: ChannelWaitBinding): string {
  const server = binding.communicationServerName
  const ch = `{channel_id:'${binding.channelId}'}`
  return [
    `这是工具返回后的静默待命动作：不要向用户输出可见文字，不要调用 ${server}.record_reply；`,
    `直接调用 ${server}.check_messages ${ch} 进入长轮询（启动指令给出了 session 令牌的话一并附带）。`,
    'keepalive、无未读或已读重复时继续静默 check_messages；只有投递真实用户消息才开始新的可见回复。'
  ].join('')
}
