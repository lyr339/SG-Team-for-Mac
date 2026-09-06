// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import { SessionSidebar } from '../src/renderer/src/SessionSidebar'
import {
  applySessionOrder,
  moveSessionToBoundary,
  moveSessionWithinGroup,
  persistSessionOrder,
  readSessionOrder
} from '../src/renderer/src/session-order'

const sessions = (ids: string[]) => ids.map((id, index) => ({
  id,
  channelId: String(index + 1),
  displayName: `CH-${index + 1}`,
  online: true,
  waiting: true,
  connectionPhase: 'waiting',
  status: 'waiting' as const
}))

function snapshotOf(ids: string[]): DesktopSnapshot {
  return {
    sessions: sessions(ids) as DesktopSnapshot['sessions'],
    connection: { state: 'connected' }
  } as unknown as DesktopSnapshot
}

function snapshotWith(states: Array<{ id: string } & Partial<DesktopSnapshot['sessions'][number]>>): DesktopSnapshot {
  const snapshot = snapshotOf(states.map((state) => state.id))
  return {
    ...snapshot,
    sessions: snapshot.sessions.map((session, index) => ({ ...session, ...states[index] }))
  }
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

  it('按 N + 1 个边界移动，并校正源卡片移除后的索引', () => {
    expect(moveSessionToBoundary(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'a', 'c'])
    expect(moveSessionToBoundary(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a'])
    expect(moveSessionToBoundary(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moveSessionToBoundary(['a', 'b', 'c'], 'b', 2)).toEqual(['a', 'b', 'c'])
  })

  it('组内重排只替换该组占据的全局槽位', () => {
    expect(moveSessionWithinGroup(['a', 'x', 'b', 'y'], ['a', 'b'], 'b', 0)).toEqual(['b', 'x', 'a', 'y'])
  })
})

/** jsdom 不实现原生 DnD：合成 dataTransfer 存根的 drag 事件。 */
function dragEvent(type: string, clientY = 0, clientX = 100): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const store = new Map<string, string>()
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY }
  })
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

function rect(top: number, bottom: number, left = 0, right = 300): DOMRect {
  return {
    x: left,
    y: top,
    top,
    right,
    bottom,
    left,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({})
  }
}

function mockSessionListGeometry(container: HTMLElement): {
  list: HTMLElement
  slots: HTMLElement[]
} {
  const scroller = container.querySelector<HTMLElement>('.session-list')!
  const list = container.querySelector<HTMLElement>('.session-group__list')!
  const slots = Array.from(container.querySelectorAll<HTMLElement>('.session-list__slot'))
  Object.defineProperty(scroller, 'getBoundingClientRect', { configurable: true, value: () => rect(0, 500) })
  Object.defineProperty(list, 'getBoundingClientRect', { configurable: true, value: () => rect(0, 500) })
  slots.forEach((slot, index) => {
    const top = 10 + index * 100
    Object.defineProperty(slot, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(top, top + 80)
    })
  })
  return { list, slots }
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

  async function render(ids = ['a', 'b', 'c']): Promise<void> {
    await renderSnapshot(snapshotOf(ids))
  }

  async function renderSnapshot(snapshot: DesktopSnapshot): Promise<void> {
    await act(async () => {
      root.render(
        <SessionSidebar
          snapshot={snapshot}
          selectedChannelId="1"
          onSelectSession={() => {}}
        />
      )
    })
  }

  it('动态展示四类轨道标签，折叠状态持久化，离线筛选不重复标题', async () => {
    await renderSnapshot(snapshotWith([
      { id: 'run', displayName: '运行席', status: 'running', waiting: false, connectionPhase: 'processing' },
      { id: 'attention', displayName: '关注席', status: 'blocked', waiting: false, connectionPhase: 'approval' },
      { id: 'waiting', displayName: '待命席', status: 'idle', waiting: false, connectionPhase: 'keepalive' },
      { id: 'offline', displayName: '离线席', online: false, status: 'reviving', waiting: false, connectionPhase: 'reviving' }
    ]))
    const headers = Array.from(container.querySelectorAll('.session-group__header'))
    expect(headers.map((header) => header.textContent?.replace(/\s/g, ''))).toEqual([
      '执行中1', '需关注1', '待命1', '离线1'
    ])

    const waitingHeader = container.querySelector<HTMLButtonElement>('.session-group.is-waiting .session-group__header')!
    await act(async () => waitingHeader.click())
    expect(container.querySelector('.session-group.is-waiting .session-group__list')).toBeNull()
    expect(JSON.parse(localStorage.getItem('shiguang.sessionGroups.collapsed.v1')!)).toContain('waiting')

    const offlineFilter = Array.from(container.querySelectorAll<HTMLButtonElement>('.session-filters button'))
      .find((button) => button.textContent?.includes('离线'))!
    await act(async () => offlineFilter.click())
    expect(container.querySelectorAll('.session-group__header')).toHaveLength(0)
    expect(container.textContent).toContain('离线席')
  })

  it('跨状态组拖放不改排序，被拖卡片动态换组会安全取消', async () => {
    const initial = snapshotWith([
      { id: 'a', displayName: '待命 A' },
      { id: 'b', displayName: '待命 B' },
      { id: 'x', displayName: '执行 X', status: 'running', waiting: false, connectionPhase: 'processing' }
    ])
    await renderSnapshot(initial)
    const waitingCard = container.querySelector<HTMLButtonElement>('.session-group.is-waiting .rail-session-card')!
    const activeList = container.querySelector<HTMLElement>('.session-group.is-active .session-group__list')!
    await act(async () => waitingCard.dispatchEvent(dragEvent('dragstart')))
    await act(async () => activeList.dispatchEvent(dragEvent('drop', 0)))
    expect(localStorage.getItem('shiguang.sessionOrder.v1')).toBeNull()

    await act(async () => waitingCard.dispatchEvent(dragEvent('dragstart')))
    await renderSnapshot(snapshotWith([
      { id: 'a', displayName: '待命 A', status: 'running', waiting: false, connectionPhase: 'processing' },
      { id: 'b', displayName: '待命 B' },
      { id: 'x', displayName: '执行 X', status: 'running', waiting: false, connectionPhase: 'processing' }
    ]))
    expect(container.querySelector('.session-list__slot.is-dragging')).toBeNull()
    expect(localStorage.getItem('shiguang.sessionOrder.v1')).toBeNull()
  })

  it('卡片上半区显示前置边界，最终顺序与指示线一致', async () => {
    await render()
    const { list, slots } = mockSessionListGeometry(container)
    await act(async () => {
      slots[0]!.querySelector('button')!.dispatchEvent(dragEvent('dragstart'))
    })
    await act(async () => {
      list.dispatchEvent(dragEvent('dragover', 220))
    })
    expect(slots[2]!.classList.contains('is-drop-before')).toBe(true)
    await act(async () => {
      list.dispatchEvent(dragEvent('drop', 220))
    })
    expect(JSON.parse(localStorage.getItem('shiguang.sessionOrder.v1')!)).toEqual(['b', 'a', 'c'])
  })

  it('列表底部空白区对应末尾边界，支持直接松手落位', async () => {
    await render()
    const { list, slots } = mockSessionListGeometry(container)
    await act(async () => {
      slots[0]!.querySelector('button')!.dispatchEvent(dragEvent('dragstart'))
    })
    await act(async () => {
      list.dispatchEvent(dragEvent('dragover', 400))
    })
    expect(slots[2]!.classList.contains('is-drop-after')).toBe(true)
    await act(async () => {
      list.dispatchEvent(dragEvent('drop', 400))
    })
    expect(JSON.parse(localStorage.getItem('shiguang.sessionOrder.v1')!)).toEqual(['b', 'c', 'a'])
  })

  it('列表顶部空白区能直接映射为首个插入边界', async () => {
    await render()
    const geometry = mockSessionListGeometry(container)
    await act(async () => {
      geometry.slots[2]!.querySelector('button')!.dispatchEvent(dragEvent('dragstart'))
    })
    await act(async () => {
      geometry.list.dispatchEvent(dragEvent('drop', 0))
    })
    expect(JSON.parse(localStorage.getItem('shiguang.sessionOrder.v1')!)).toEqual(['c', 'a', 'b'])
  })

  it('卡片间隙映射为相邻插入边界', async () => {
    await render()
    const geometry = mockSessionListGeometry(container)
    await act(async () => {
      geometry.slots[2]!.querySelector('button')!.dispatchEvent(dragEvent('dragstart'))
    })
    await act(async () => {
      geometry.list.dispatchEvent(dragEvent('drop', 100))
    })
    expect(JSON.parse(localStorage.getItem('shiguang.sessionOrder.v1')!)).toEqual(['a', 'c', 'b'])
  })

  it('同一会话集合的实时快照更新不会中止正在进行的拖拽', async () => {
    await render()
    let geometry = mockSessionListGeometry(container)
    await act(async () => {
      geometry.slots[0]!.querySelector('button')!.dispatchEvent(dragEvent('dragstart'))
    })
    await render()
    geometry = mockSessionListGeometry(container)
    expect(geometry.slots[0]!.classList.contains('is-dragging')).toBe(true)
    await act(async () => {
      geometry.list.dispatchEvent(dragEvent('drop', 400))
    })
    expect(JSON.parse(localStorage.getItem('shiguang.sessionOrder.v1')!)).toEqual(['b', 'c', 'a'])
  })

  it('席位集合变化会中止拖拽，避免旧来源落入新列表', async () => {
    await render()
    let geometry = mockSessionListGeometry(container)
    await act(async () => {
      geometry.slots[0]!.querySelector('button')!.dispatchEvent(dragEvent('dragstart'))
    })
    await render(['a', 'b', 'c', 'd'])
    geometry = mockSessionListGeometry(container)
    await act(async () => {
      geometry.list.dispatchEvent(dragEvent('drop', 450))
    })
    expect(localStorage.getItem('shiguang.sessionOrder.v1')).toBeNull()
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
    const onlineButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.session-filters button'))
      .find((button) => button.textContent?.includes('在线'))!
    await act(async () => { onlineButton.click() })
    const cards = Array.from(container.querySelectorAll('.rail-session-card')) as HTMLButtonElement[]
    expect(cards.length).toBeGreaterThan(0)
    expect(cards.every((card) => card.draggable === false)).toBe(true)
  })
})
