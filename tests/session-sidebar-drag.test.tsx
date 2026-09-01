// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import { SessionSidebar } from '../src/renderer/src/SessionSidebar'
import { applySessionOrder, persistSessionOrder, readSessionOrder } from '../src/renderer/src/session-order'

const sessions = (ids: string[]) => ids.map((id, index) => ({
  id,
  channelId: String(index + 1),
  displayName: `CH-${index + 1}`,
  online: index % 2 === 0,
  status: 'waiting' as const
}))

function snapshotOf(ids: string[]): DesktopSnapshot {
  return {
    sessions: sessions(ids) as DesktopSnapshot['sessions'],
    connection: { state: 'connected' }
  } as unknown as DesktopSnapshot
}

describe('session-order 纯函数', () => {
  it('手动顺序优先，未知会话（新席位）按快照原序排在已知之后', () => {
    const ordered = applySessionOrder(
      sessions(['a', 'b', 'new-1', 'c', 'new-2']),
      ['c', 'b', 'a'],
      (session) => session.id
    )
    expect(ordered.map((session) => session.id)).toEqual(['c', 'b', 'a', 'new-1', 'new-2'])
  })

  it('无持久化顺序时原样返回副本', () => {
    const input = sessions(['a', 'b'])
    const ordered = applySessionOrder(input, undefined, (session) => session.id)
    expect(ordered.map((session) => session.id)).toEqual(['a', 'b'])
    expect(ordered).not.toBe(input)
  })

  it('坏数据静默忽略，去重并限长', () => {
    localStorage.setItem('shiguang.sessionOrder.v1', '{not-json')
    expect(readSessionOrder()).toBeUndefined()
    localStorage.setItem('shiguang.sessionOrder.v1', JSON.stringify(['a', 'a', null, 42, 'b']))
    expect(readSessionOrder()).toEqual(['a', 'b'])
    persistSessionOrder(['x', 'x', 'y'])
    expect(readSessionOrder()).toEqual(['x', 'y'])
    localStorage.clear()
  })
})

/** jsdom 不实现原生 DnD：合成 dataTransfer 存根的 drag 事件。 */
function dragEvent(type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const store = new Map<string, string>()
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      effectAllowed: 'move',
      dropEffect: 'move',
      setData: (format: string, value: string) => store.set(format, value),
      getData: (format: string) => store.get(format) ?? ''
    }
  })
  return event
}

describe('SessionSidebar 拖拽重排', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    localStorage.clear()
  })

  it('拖拽到另一卡片上：落位后顺序更新并持久化', async () => {
    await act(async () => {
      root.render(
        <SessionSidebar
          snapshot={snapshotOf(['a', 'b', 'c'])}
          selectedChannelId="1"
          onSelectSession={() => {}}
        />
      )
    })
    const slots = () => Array.from(container.querySelectorAll('.session-list__slot'))
    expect(slots()).toHaveLength(3)

    const first = slots()[0]!.querySelector('button')!
    const third = slots()[2]!
    await act(async () => {
      first.dispatchEvent(dragEvent('dragstart'))
    })
    await act(async () => {
      third.dispatchEvent(dragEvent('dragover'))
    })
    // 落点指示线出现在目标槽位
    expect(third.querySelector('.session-list__drop-marker')).toBeTruthy()
    await act(async () => {
      third.dispatchEvent(dragEvent('drop'))
    })
    // 顺序已持久化（a 移动到末位）
    expect(JSON.parse(localStorage.getItem('shiguang.sessionOrder.v1')!)).toEqual(['b', 'c', 'a'])
  })

  it('在线/离线过滤视图不启用拖拽（语义分组不重排）', async () => {
    await act(async () => {
      root.render(
        <SessionSidebar
          snapshot={snapshotOf(['a', 'b', 'c'])}
          onSelectSession={() => {}}
        />
      )
    })
    const onlineButton = Array.from(container.querySelectorAll('.session-filters button'))
      .find((button) => button.textContent?.includes('在线'))!
    await act(async () => { onlineButton.click() })
    const cards = Array.from(container.querySelectorAll('.rail-session-card')) as HTMLButtonElement[]
    expect(cards.length).toBeGreaterThan(0)
    expect(cards.every((card) => card.draggable === false)).toBe(true)
  })
})
