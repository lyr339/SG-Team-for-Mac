// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry, ProcessBlock } from '../src/domain/conversation-entry'
import type { LiveAgentResponseState, LiveProcessState } from '../src/shared/desktop-api'
import { ProcessTurnCard } from '../src/renderer/src/ProcessTurnCard'
import { SessionWorkspace } from '../src/renderer/src/SessionWorkspace'
import { TurnResponseText } from '../src/renderer/src/TurnResponseText'

/**
 * 切换会话进入一个正在生成的回合：会话视图按 channelId 重新挂载，卡片挂载时已经
 * 写完的 Thinking 与已经流出的正文曾被从空串重放成"打字机"，看起来像回合重新发生
 * 了一次。打字机只能表达观看者到来之后发生的事：挂载时已存在的文字落位，之后到达
 * 的才播放。
 */
const session: AgentSession = {
  id: 'session-2', channelId: '2', generation: 1, displayName: 'CH-2', roleName: '独立席',
  status: 'running', currentTask: '', queueDepth: 0, connectionPhase: 'processing',
  online: true, connected: true, waiting: false, deliveryMode: 'queued', workingFiles: [], healthEvidence: []
}

const user: ConversationEntry = {
  id: 'outbox:u2', channelId: '2', role: 'user', source: 'desktop', text: '继续实现第二个会话的任务',
  timestamp: 1_000_000, deliveredAt: 1_000_050, status: 'complete'
}

interface ThinkingBlock extends Extract<ProcessBlock, { kind: 'thinking' }> { text: string }

const thinking = (id: string, text: string, status: 'running' | 'done' = 'done'): ThinkingBlock => ({
  kind: 'thinking', id, text, status, startedAt: 1_000_100, ...(status === 'done' ? { completedAt: 1_000_400 } : {})
})

const response = (text: string, status: LiveAgentResponseState['status'] = 'streaming'): LiveAgentResponseState => ({
  id: 'bubble-2', channelId: '2', text, status, startedAt: 1_000_300, updatedAt: 1_000_400
})

describe('streaming hydration on session switch（已呈现过的内容不重放）', () => {
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

  const thoughtBodies = (): string[] => Array.from(container.querySelectorAll('.cursor-native-thought__body'))
    .map((node) => node.textContent ?? '')
  const responseText = (): string => container.querySelector('.live-agent-response__text')?.textContent ?? ''

  const renderWorkspace = (props: { liveProcess?: LiveProcessState; liveAgentResponse?: LiveAgentResponseState }): void => {
    act(() => {
      root.render(
        <SessionWorkspace
          session={session}
          entries={[user]}
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

  it('switching into a generating turn shows existing thoughts and streamed text at once, then types only what follows', () => {
    const t1 = thinking('th:1', '第一段早已写完的思考，切换会话进来时它就在。')
    const t2 = thinking('th:2', '第二段也早就写完了，是最新一段所以默认展开。')
    const streamed = '这是切换过来之前 Cursor 已经流出的正文，有好几行了。'
    const process = (blocks: ProcessBlock[]): LiveProcessState => ({
      turn: 'cursor:t2', startedAt: 1_000_100, updatedAt: 1_000_400, generating: true, blocks
    })

    // 会话视图挂载时回合已在进行中：过程块与正文都已存在。
    renderWorkspace({ liveProcess: process([t1, t2]), liveAgentResponse: response(streamed) })
    expect(thoughtBodies()).toEqual([t2.text])
    expect(responseText()).toBe(streamed)
    act(() => { vi.advanceTimersByTime(300) })
    expect(thoughtBodies()).toEqual([t2.text])
    expect(responseText()).toBe(streamed)

    // 手动展开第一段：同样是观看者到来前的内容，落位不重播。
    const heads = Array.from(container.querySelectorAll<HTMLButtonElement>('.cursor-native-thought__head'))
    act(() => heads[0]!.click())
    expect(thoughtBodies()).toEqual([t1.text, t2.text])

    // 回合继续：新出现的思考块从空串打字（RC-9：到达时已 done 也播），正文只播增量。
    const t3 = thinking('th:3', '切进来之后新生成的思考，这段应该打字机播放。')
    const grown = `${streamed}然后这一句是切进来之后才生成的。`
    renderWorkspace({ liveProcess: process([t1, t2, t3]), liveAgentResponse: response(grown) })
    expect(thoughtBodies().slice(0, 2)).toEqual([t1.text, t2.text])
    expect(thoughtBodies()[2]).toBe('')
    expect(responseText()).toBe(streamed)
    let previous = streamed
    for (let round = 0; round < 40; round += 1) {
      act(() => { vi.advanceTimersByTime(48) })
      const current = responseText()
      expect(current.startsWith(streamed)).toBe(true)
      expect(current.length).toBeGreaterThanOrEqual(previous.length)
      previous = current
      if (current === grown && thoughtBodies()[2] === t3.text) break
    }
    expect(responseText()).toBe(grown)
    expect(thoughtBodies()[2]).toBe(t3.text)

    // complete 到达：静止收尾，不回退、不重放。
    renderWorkspace({ liveProcess: { ...process([t1, t2, t3]), generating: false }, liveAgentResponse: response(grown, 'complete') })
    act(() => { vi.advanceTimersByTime(600) })
    expect(responseText()).toBe(grown)
    expect(thoughtBodies()).toEqual([t1.text, t2.text, t3.text])
  })

  it('a viewer already watching still sees the first process frame typed out', () => {
    // 观看者先到（占位行），首个过程块随后到达：它不在挂载时的块集合里，照常播放。
    renderWorkspace({})
    expect(container.querySelector('.chat-row--agent')).not.toBeNull()
    const t1 = thinking('th:1', '观看者眼前到达的第一段思考，应该打字。')
    renderWorkspace({ liveProcess: { turn: 'cursor:t2', startedAt: 1_000_100, updatedAt: 1_000_400, generating: true, blocks: [t1] } })
    expect(thoughtBodies()).toEqual([''])
    act(() => { vi.advanceTimersByTime(900) })
    expect(thoughtBodies()).toEqual([t1.text])
  })

  it('ProcessTurnCard without viewer context falls back to the steps present at its own mount', () => {
    const t1 = thinking('th:1', '卡片挂载时已存在的思考。')
    const renderCard = (blocks: ProcessBlock[]): void => {
      act(() => root.render(<ProcessTurnCard id="turn:x" blocks={blocks} startedAt={1_000_100} updatedAt={1_000_400} compact live />))
    }
    renderCard([t1])
    expect(thoughtBodies()).toEqual([t1.text])
    const t2 = thinking('th:2', '之后新出现的思考。')
    renderCard([t1, t2])
    expect(thoughtBodies()[1]).toBe('')
    act(() => { vi.advanceTimersByTime(900) })
    expect(thoughtBodies()).toEqual([t1.text, t2.text])
  })

  it('a response that starts after the viewer arrived types from the first character', () => {
    act(() => root.render(<TurnResponseText turnKey="turn:o3" />))
    expect(container.querySelector('.live-agent-response')).toBeNull()
    act(() => root.render(<TurnResponseText turnKey="turn:o3" live={response('刚开始生成的第一句话。')} />))
    expect(responseText()).toBe('')
    act(() => { vi.advanceTimersByTime(900) })
    expect(responseText()).toBe('刚开始生成的第一句话。')
  })
})
