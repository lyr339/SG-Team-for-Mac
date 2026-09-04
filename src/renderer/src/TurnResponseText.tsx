import { useRef } from 'react'
import { normalizeEscapedNewlines, type ConversationEntry } from '../../domain/conversation-entry'
import { sanitizeModelDisplayText } from '../../domain/model-output-sanitizer'
import type { LiveAgentResponseState } from '../../shared/desktop-api'
import { ClampedMessage } from './ClampedMessage'
import { MessageContent } from './MessageContent'
import { useStreamingText } from './use-streaming-text'

/**
 * 直播正文与落库正文进入播放器前走同一条规范化管线：两者本来经不同净化路径
 *（CDP 文本 sanitizeModelDisplayText / 落库 normalizeEscapedNewlines + trim），
 * 若不对齐，封口那一帧的正文会不再是已显示文本的前缀，被播放器判成整体替换而跳全文。
 */
export function responseFeedText(text: string): string {
  return normalizeEscapedNewlines(sanitizeModelDisplayText(text).text).trim()
}

export interface TurnResponseTextProps {
  /** 统一回合身份（turn:<outboundId>）：直播→封口期间播放器缓冲不重置。 */
  turnKey: string
  /** Cursor 原生流式正文（responding 阶段）。 */
  live?: LiveAgentResponseState
  /** 已落库回复（sealed 阶段）。 */
  reply?: ConversationEntry
}

/**
 * 回合正文（阶段 G / RC-8）：同一个组件实例贯穿 responding → sealed。
 *
 * - 直播中挂载：经共享播放器匀速打字；record_reply 落库只是把目标切到落库正文
 *   并标记 done，尾部继续播完——不再因为行组件替换而瞬间补齐全文；
 * - 挂载即已封口（历史水合 / 切换会话回来）：直接全文并保留长文折叠。
 */
export function TurnResponseText({ turnKey, live, reply }: TurnResponseTextProps): React.JSX.Element | null {
  const historical = useRef(reply !== undefined && live === undefined)
  const text = reply ? responseFeedText(reply.text) : live ? responseFeedText(live.text) : ''
  const done = reply !== undefined || live?.status === 'complete'
  // firstFrameDoneFull：冷启动/切回会话时直接看到已完成的正文（首帧即 done）；
  // 直播中挂载（首帧 streaming 或尚无正文）之后到达的 complete 仍走播放器尾部。
  const visible = useStreamingText(
    { id: turnKey, text, done },
    { immediate: historical.current, firstFrameDoneFull: true }
  )
  if (historical.current) {
    return reply?.text ? <ClampedMessage text={reply.text} /> : null
  }
  if (!text) return null
  const streaming = live?.status === 'streaming' && reply === undefined
  const playing = streaming || visible.length < text.length
  return (
    <div
      className={`live-agent-response${playing ? ' is-playing' : ''}${reply ? ' is-sealed' : ''}`}
      aria-live="polite"
      aria-label={playing ? 'Cursor Agent 正在实时生成' : undefined}
    >
      {visible ? <MessageContent text={visible} className="live-agent-response__text" /> : null}
      {playing ? <span className="live-agent-response__caret" aria-hidden="true" /> : null}
    </div>
  )
}
