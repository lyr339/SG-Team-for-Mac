import { describe, expect, it } from 'vitest'
import {
  buildDeliverySuffix,
  buildReplySyncRequiredMessage,
  buildSilentDeliverySuffix
} from '../src/domain/channel-delivery-policy'
import { buildChannelWaitInstruction } from '../src/domain/channel-wait-policy'
import { buildUnifiedServerInstructions } from '../src/mcp/team-tools'

describe('channel protocol policy text', () => {
  it('does not instruct agents to record a reply when they only keep polling', () => {
    const instruction = buildChannelWaitInstruction({
      channelId: '1',
      communicationServerName: 'qunshu'
    })

    expect(instruction).toContain('工具返回后的静默待命动作')
    expect(instruction).toContain('直接调用 qunshu.check_messages')
    expect(instruction).toContain('不要向用户输出可见文字')
    expect(instruction).not.toContain('先用 qunshu.record_reply')
  })

  it('keeps first and later delivery suffixes explicit about silent keepalive handling', () => {
    const first = buildDeliverySuffix({
      isFirstDelivery: true,
      workspacePath: '/workspace/alpha',
      channelId: '1'
    })
    const later = buildDeliverySuffix({ isFirstDelivery: false, channelId: '1' })

    for (const text of [first, later]) {
      expect(text).toContain('处理真实用户消息并输出可见回复后')
      expect(text).toContain('没有输出用户可见回复时，不要为了“继续等待”而 record_reply')
      expect(text).toContain('keepalive、无未读或已读重复时必须静默续等')
    }
  })

  it('keeps unified MCP server instructions silent on keepalive and read duplicates', () => {
    const instructions = buildUnifiedServerInstructions()

    expect(instructions).toContain('每次真实用户可见回复后必须 record_reply')
    expect(instructions).toContain('团队内部通知只用 team_* 回执处理')
    expect(instructions).toContain('keepalive、无未读或已读重复时必须静默续等')
    expect(instructions).toContain('也不要 record_reply')
    expect(instructions).toContain('内部通知不会触发该守门')
  })

  it('keeps silent internal notifications out of the user-visible reply protocol', () => {
    const instruction = buildSilentDeliverySuffix({ channelId: '2' })

    expect(instruction).toContain('内部协作通知协议')
    expect(instruction).toContain('不是用户可见对话')
    expect(instruction).toContain('team_read_message')
    expect(instruction).toContain('team_respond_message')
    expect(instruction).toContain('不要调用 record_reply')
    expect(instruction).not.toContain('持续对话协议')
  })

  it('keeps reply-sync recovery limited to the explicit need-sync error path', () => {
    const message = buildReplySyncRequiredMessage(false)

    expect(message).toContain('上一轮用户消息已经处理')
    expect(message).toContain('请立即调用 record_reply')
    expect(message).toContain('不要重新回答用户')
  })
})
