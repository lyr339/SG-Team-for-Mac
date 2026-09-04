// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import type { LiveAgentResponseState, LiveProcessState } from '../src/shared/desktop-api'
import { SessionWorkspace } from '../src/renderer/src/SessionWorkspace'

const session: AgentSession = {
  id: 'session-1', channelId: '1', generation: 1, displayName: 'CH-1', roleName: '独立席',
  status: 'running', currentTask: '', queueDepth: 0, connectionPhase: 'processing',
  online: true, connected: true, waiting: false, deliveryMode: 'queued', workingFiles: [], healthEvidence: []
}

const user: ConversationEntry = {
  id: 'outbox:u1', channelId: '1', role: 'user', source: 'desktop', text: '请解释这段代码',
  timestamp: 1_000_000, deliveredAt: 1_000_050, status: 'complete'
}

const finalText = '这段代码把消息按投递时间切成回合，再把过程块锚定到对应回合上。'

function render(root: Root, props: {
  entries: ConversationEntry[]
  liveProcess?: LiveProcessState
  liveAgentResponse?: LiveAgentResponseState
  session?: Partial<AgentSession>
}): void {
  act(() => {
    root.render(
      <SessionWorkspace
        session={{ ...session, ...props.session }}
        entries={props.entries}
        onSend={async () => {}}
        onBack={() => {}}
        draft=""
        onDraftChange={() => {}}
        attachments={[]}
        onAttachmentsChange={() => {}}
        liveProcess={props.liveProcess}
        liveAgentResponse={props.liveAgentResponse}
      />
    )
  })
}

describe('Agent 回合行身份贯穿 responding → sealed（阶段 F/G，§8.5-1 / §8.5-3）', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    delete (window as { matchMedia?: unknown }).matchMedia
    vi.useRealTimers()
  })

  const agentRow = (): HTMLElement | null => container.querySelector('.chat-row--agent')
  const responseText = (): string => container.querySelector('.live-agent-response')?.textContent ?? ''

  const thoughtText = '先读懂分段边界：投递时间是开放边界，回复落库时间是关闭边界，两者之间的过程块归本回合，之后的属于传输空档。'
  const thoughtBody = (): string => container.querySelector('.cursor-native-thought__body')?.textContent ?? ''

  it('keeps the same DOM node and never shortens the visible text when record_reply lands', () => {
    const process: LiveProcessState = {
      turn: 'cursor:t1', startedAt: 1_000_100, updatedAt: 1_000_400, generating: true,
      blocks: [{ kind: 'thinking', id: 'cursor-th:1', text: thoughtText, status: 'done', startedAt: 1_000_100 }]
    }
    // responding：正文流式到达一半
    render(root, {
      entries: [user],
      liveProcess: process,
      liveAgentResponse: {
        id: 'bubble-1', channelId: '1', text: finalText.slice(0, 12), status: 'streaming',
        startedAt: 1_000_300, updatedAt: 1_000_400
      }
    })
    const liveRow = agentRow()
    expect(liveRow).not.toBeNull()
    expect(liveRow?.className).toContain('live-process-row')
    const processCard = container.querySelector('.cursor-native-process')
    expect(processCard).not.toBeNull()
    act(() => { vi.advanceTimersByTime(300) })
    const midway = responseText()
    expect(midway.length).toBeGreaterThan(0)
    // 直播中的 Thinking 正文（新到即 done）同样在播放，且尚未播完。
    const thoughtMidway = thoughtBody()
    expect(thoughtMidway.length).toBeGreaterThan(0)
    expect(thoughtMidway.length).toBeLessThan(thoughtText.length)

    // sealed：回复落库（含封口过程），直播过程与正文流从快照撤下
    render(root, {
      entries: [user, {
        id: 'reply:r1', channelId: '1', role: 'assistant', source: 'cursor', text: finalText,
        timestamp: 1_000_900, status: 'complete', replyToEntryId: 'outbox:u1', turn: 'cursor:t1:virtual:outbox:u1',
        processBlocks: [{ kind: 'thinking', id: 'cursor-th:1', text: thoughtText, status: 'done', startedAt: 1_000_100, completedAt: 1_000_900 }]
      }],
      session: { status: 'waiting', waiting: true, connectionPhase: 'waiting' }
    })
    const sealedRow = agentRow()
    // 同一 DOM 节点：行、过程卡都没有被卸载重建。
    expect(sealedRow).toBe(liveRow)
    expect(container.querySelector('.cursor-native-process')).toBe(processCard)
    expect(sealedRow?.className).not.toContain('live-process-row')
    // Thinking 正文不因 live 翻 false 跳全文：播放模式在挂载时已锁定，尾部继续播完。
    const thoughtAtSeal = thoughtBody()
    expect(thoughtAtSeal.length).toBeGreaterThanOrEqual(thoughtMidway.length)
    expect(thoughtAtSeal.length).toBeLessThan(thoughtText.length)
    // 正文没有瞬间跳全文：落库那一帧可见文本 ≥ 之前，且仍短于全文，随后匀速播完。
    const atSeal = responseText()
    expect(atSeal.length).toBeGreaterThanOrEqual(midway.length)
    expect(atSeal.length).toBeLessThan(finalText.length)
    let previous = atSeal.length
    for (let round = 0; round < 40; round += 1) {
      act(() => { vi.advanceTimersByTime(50) })
      const current = responseText().length
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
      if (responseText() === finalText) break
    }
    expect(responseText()).toBe(finalText)
    expect(thoughtBody()).toBe(thoughtText)
    // 播完后进入静止：无光标、无「实时」标记；操作栏（复制/引用）已出现。
    expect(container.querySelector('.live-agent-response__caret')).toBeNull()
    expect(container.textContent).toContain('复制')
    expect(container.textContent).toContain('引用')
    // 本会话内看着流出来的正文不再事后折叠（用户气泡的折叠容器不在此列）。
    expect(sealedRow?.querySelector('.clamped-message')).toBeNull()
  })

  it('hydrates an already sealed reply with the full text and clamp affordance at once', () => {
    render(root, {
      entries: [user, {
        id: 'reply:r1', channelId: '1', role: 'assistant', source: 'cursor', text: finalText,
        timestamp: 1_000_900, status: 'complete', replyToEntryId: 'outbox:u1'
      }],
      session: { status: 'waiting', waiting: true, connectionPhase: 'waiting' }
    })
    expect(agentRow()?.querySelector('.clamped-message')?.textContent).toBe(finalText)
    expect(container.querySelector('.live-agent-response')).toBeNull()
  })
})
