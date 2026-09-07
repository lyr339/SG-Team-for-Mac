import { describe, expect, it } from 'vitest'
import {
  buildDeliverySuffix,
  buildReplySyncRequiredMessage,
  buildSilentDeliverySuffix,
  buildStorageUnavailableMessage
} from '../src/domain/channel-delivery-policy'
import { buildChannelWaitInstruction } from '../src/domain/channel-wait-policy'
import { buildUnifiedServerInstructions } from '../src/mcp/team-tools'

describe('channel protocol policy text', () => {
  it('does not instruct agents to record a reply when they only keep polling', () => {
    const instruction = buildChannelWaitInstruction({
      channelId: '1',
      communicationServerName: 'SG Team'
    })

    expect(instruction).toContain('工具返回后的静默待命动作')
    expect(instruction).toContain('直接调用 SG Team.check_messages')
    expect(instruction).toContain('不要向用户输出可见文字')
    expect(instruction).not.toContain('先用 SG Team.record_reply')
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
    expect(instructions).toContain('团队内部通知只用 team_message 回执处理')
    // 工具面收敛后的对象划分说明：模型据此在 7 个团队工具里选对象，再选 action/view。
    expect(instructions).toContain('team_tasks 看任务（view）')
    expect(instructions).toContain('team_run 运行与主控（action）')
    expect(instructions).toContain('keepalive、无未读或已读重复时必须静默续等')
    expect(instructions).toContain('也不要 record_reply')
    expect(instructions).toContain('内部通知不会触发该守门')
  })

  it('tells agents that a desktop restart is not a stop, and how to ride out transport / storage blips', () => {
    const instructions = buildUnifiedServerInstructions()
    const rule = instructions.split('\n').find((line) => line.startsWith('瞬断续接：'))!

    expect(rule).toContain('拾光桌面端退出或重启不会中断本会话')
    expect(rule).toContain('MCP 进程由 Cursor 托管')
    expect(rule).toContain('transport closed')
    expect(rule).toContain('storage_unavailable')
    expect(rule).toContain('这不是围栏终止')
    expect(rule).toContain('原样重试同一调用')
    expect(rule).toContain('record_reply 先补同步，再 check_messages 续等')
    expect(rule).toContain('连续 3 次仍失败')
    // 围栏终止与额度/授权错误的「不要重试」规则保持原样，瞬断规则不覆盖它们。
    expect(instructions).toContain('收到「会话围栏」终止指令即停止轮询并结束，不要重试')
    expect(instructions).toContain('usage limit / quota / billing / authorization / isRetryable:false')

    expect(buildStorageUnavailableMessage({ detail: 'database is locked', retryable: true, failures: 1 }))
      .toContain('这不是会话围栏终止')
    expect(buildStorageUnavailableMessage({ detail: 'disk I/O error', retryable: false, failures: 3 }))
      .toContain('请停止自动重试')
  })

  it('keeps silent internal notifications out of the user-visible reply protocol', () => {
    const instruction = buildSilentDeliverySuffix({ channelId: '2' })

    expect(instruction).toContain('内部协作通知协议')
    expect(instruction).toContain('不是用户可见对话')
    expect(instruction).toContain("team_message({action:'read', messageId})")
    expect(instruction).toContain("team_message({action:'respond', messageId, content})")
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
