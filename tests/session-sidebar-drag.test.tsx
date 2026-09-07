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

  it('动态展示四类状态组与头部摘要；折叠状态持久化，折叠内容 inert 且过渡后卸载', async () => {
    await renderSnapshot(snapshotWith([
      { id: 'run', displayName: '运行席', status: 'running', waiting: false, connectionPhase: 'processing', queueDepth: 1 },
      { id: 'attention', displayName: '关注席', status: 'blocked', waiting: false, connectionPhase: 'approval' },
      { id: 'waiting', displayName: '待命席', status: 'idle', waiting: false, connectionPhase: 'keepalive' },
      { id: 'offline', displayName: '离线席', online: false, status: 'reviving', waiting: false, connectionPhase: 'reviving', queueDepth: 2 }
    ]))
    const headers = Array.from(container.querySelectorAll('.session-group__header'))
    expect(headers.map((header) => header.textContent?.replace(/\s/g, ''))).toEqual([
      '执行中1', '需关注1', '待命1', '离线1'
    ])
    expect(headers.every((header) => header.getAttribute('aria-expanded') === 'true')).toBe(true)
    // 头部：标题 + 摘要（代替旧版三段筛选器）+ 总数。
    const header = container.querySelector('.session-pane > .inspector-section__header')!
    expect(header.querySelector('strong')?.textContent).toBe('会话')
    expect(header.querySelector('span')?.textContent).toBe('1 执行中 · 1 需关注 · 1 待命 · 1 离线 · 排队 3')
    expect(header.querySelector('.session-pane__count')?.textContent).toBe('4')
    expect(container.querySelector('.session-filters')).toBeNull()

    const waitingHeader = container.querySelector<HTMLButtonElement>('.session-group.is-waiting .session-group__header')!
    await act(async () => waitingHeader.click())
    const collapsible = container.querySelector('.session-group.is-waiting .inspector-collapsible')!
    expect(waitingHeader.getAttribute('aria-expanded')).toBe('false')
    expect(collapsible.classList.contains('is-open')).toBe(false)
    expect(collapsible.hasAttribute('inert')).toBe(true)
    expect(JSON.parse(localStorage.getItem('shiguang.sessionGroups.collapsed.v1')!)).toContain('waiting')
    await act(async () => { await new Promise((done) => setTimeout(done, 260)) })
    expect(container.querySelector('.session-group.is-waiting .session-group__list')).toBeNull()
    // 其余组不受影响。
    expect(container.querySelector('.session-group.is-offline .session-group__list')).not.toBeNull()
  })

  it('方向键在可见行之间漫游，Home / End 跳到首尾；折叠组内的行不在候选里；只有选中行进入 Tab 序列', async () => {
    await renderSnapshot(snapshotWith([
      { id: 'a', displayName: '待命 A' },
      { id: 'b', displayName: '待命 B' },
      { id: 'x', displayName: '执行 X', status: 'running', waiting: false, connectionPhase: 'processing' },
      { id: 'o', displayName: '离线 O', online: false, status: 'offline', waiting: false, connectionPhase: '' }
    ]))
    const rows = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.session-row'))
    const nameOf = (row: Element | null | undefined) => row?.querySelector('.session-row__name')?.textContent
    // 分组顺序：执行中 X → 待命 A（选中，channel 1）、B → 离线 O。
    expect(rows().map(nameOf)).toEqual(['执行 X', '待命 A', '待命 B', '离线 O'])
    expect(rows().map((row) => row.tabIndex)).toEqual([-1, 0, -1, -1])

    const press = async (key: string): Promise<void> => {
      await act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      })
    }
    await act(async () => rows()[1]!.focus())
    await press('ArrowDown')
    expect(nameOf(document.activeElement)).toBe('待命 B')
    await press('ArrowDown')
    expect(nameOf(document.activeElement)).toBe('离线 O')
    await press('ArrowDown')
    expect(nameOf(document.activeElement)).toBe('离线 O')
    await press('Home')
    expect(nameOf(document.activeElement)).toBe('执行 X')
    await press('End')
    expect(nameOf(document.activeElement)).toBe('离线 O')

    // 折叠离线组后，End 落在最后一个可见行。
    const offlineHeader = container.querySelector<HTMLButtonElement>('.session-group.is-offline .session-group__header')!
    await act(async () => offlineHeader.click())
    await act(async () => rows()[0]!.focus())
    await press('End')
    expect(nameOf(document.activeElement)).toBe('待命 B')
  })

  it('没有会话时显示可行动的空态；连接中显示加载态', async () => {
    await renderSnapshot({ ...snapshotOf([]), connection: { state: 'connected' } } as unknown as DesktopSnapshot)
    expect(container.querySelector('.session-group')).toBeNull()
    expect(container.querySelector('.inspector-state')?.textContent).toContain('还没有会话')
    expect(container.querySelector('.inspector-state .inspector-link')).toBeNull()

    let opened = 0
    await act(async () => {
      root.render(
        <SessionSidebar
          snapshot={{ ...snapshotOf([]), connection: { state: 'connected' } } as unknown as DesktopSnapshot}
          onSelectSession={() => {}}
          onOpenRun={() => { opened += 1 }}
        />
      )
    })
    const link = container.querySelector<HTMLButtonElement>('.inspector-state .inspector-link')!
    expect(link.textContent).toBe('前往运行页')
    await act(async () => link.click())
    expect(opened).toBe(1)

    await renderSnapshot({ ...snapshotOf([]), connection: { state: 'reconnecting' } } as unknown as DesktopSnapshot)
    expect(container.querySelector('.inspector-state.is-loading')).not.toBeNull()
    expect(container.querySelector('.session-pane > .inspector-section__header span')?.textContent).toBe('正在连接通道…')
  })

  it('跨状态组拖放不改排序，被拖卡片动态换组会安全取消', async () => {
    const initial = snapshotWith([
      { id: 'a', displayName: '待命 A' },
      { id: 'b', displayName: '待命 B' },
      { id: 'x', displayName: '执行 X', status: 'running', waiting: false, connectionPhase: 'processing' }
    ])
    await renderSnapshot(initial)
    const waitingCard = container.querySelector<HTMLButtonElement>('.session-group.is-waiting .session-row')!
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

  it('只有同组里不止一行时才可拖拽；单独一行的组没有可重排的余地', async () => {
    await renderSnapshot(snapshotWith([
      { id: 'a', displayName: '待命 A' },
      { id: 'b', displayName: '待命 B' },
      { id: 'x', displayName: '执行 X', status: 'running', waiting: false, connectionPhase: 'processing' }
    ]))
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('.session-row'))
    expect(rows.map((row) => [row.querySelector('.session-row__name')?.textContent, row.draggable])).toEqual([
      ['执行 X', false],
      ['待命 A', true],
      ['待命 B', true]
    ])
  })

  it('点击行打开对应通道；选中行带 aria-current', async () => {
    let opened: string | undefined
    await act(async () => {
      root.render(
        <SessionSidebar
          snapshot={snapshotOf(['a', 'b'])}
          selectedChannelId="2"
          onSelectSession={(channelId) => { opened = channelId }}
        />
      )
    })
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('.session-row'))
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true'])
    await act(async () => rows[0]!.click())
    expect(opened).toBe('1')
  })
})
