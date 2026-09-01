// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProcessBlock } from '../src/domain/conversation-entry'
import { ProcessBlocks } from '../src/renderer/src/ProcessBlocks'

describe('ProcessBlocks', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('renders tool, thinking and command blocks with status labels', () => {
    const blocks: ProcessBlock[] = [
      {
        kind: 'tool',
        id: 'tool-1',
        toolName: 'rg',
        toolKind: 'search',
        summary: 'rg process',
        status: 'done',
        output: 'src/renderer/src/ProcessBlocks.tsx'
      },
      {
        kind: 'thinking',
        id: 'think-1',
        text: '分析过程链路并确认可落地点',
        status: 'running'
      },
      {
        kind: 'command',
        id: 'cmd-1',
        command: 'npm test',
        output: '385 passed',
        status: 'failed',
        exitCode: 1
      }
    ]

    const html = renderToStaticMarkup(<ProcessBlocks blocks={blocks} />)

    expect(html).toContain('搜索')
    expect(html).toContain('Thought')
    expect(html).toContain('运行验证')
    expect(html).toContain('thinking')
    expect(html).toContain('失败')
    expect(html).toContain('aria-expanded="false"')
  })

  it('does not expose disclosure aria on non-expandable disabled heads', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[{
      kind: 'tool',
      id: 'tool-plain',
      toolName: 'team_check_in',
      toolKind: 'mcp',
      summary: '已连接',
      status: 'done'
    }]} />)

    expect(html).toContain('cursor-native-tool__head" disabled=""')
    expect(html).toContain('过程记录')
  })

  it('renders escaped newlines inside process text as real line breaks', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[
      {
        kind: 'thinking',
        id: 'think-escaped',
        text: '用户要求内化账号流程。\\n\\n当前依赖问题：\\n- 依赖外部浏览器\\n- 需要手动权限',
        status: 'running'
      },
      {
        kind: 'command',
        id: 'cmd-escaped',
        command: 'npm test',
        output: 'Test Files\\nTests passed',
        status: 'done'
      }
    ]} />)

    expect(html).toContain('当前依赖问题')
    expect(html).toContain('<li>依赖外部浏览器</li>')
    expect(html).not.toContain('\\n')
  })

  it('collapses earlier thoughts and keeps only the latest thought expanded by default', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[
      { kind: 'thinking', id: 'thought-1', text: '较早的长思考', status: 'done' },
      { kind: 'thinking', id: 'thought-2', text: '当前最新思考', status: 'running' }
    ]} />)
    expect(html).not.toContain('较早的长思考')
    expect(html).toContain('当前最新思考')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-expanded="true"')
  })

  it('returns null for an empty block list', () => {
    expect(renderToStaticMarkup(<ProcessBlocks blocks={[]} />)).toBe('')
  })

  it('labels CDP-observed durations as approximate instead of exact runtime', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[{
      kind: 'tool', id: 'cursor:read', toolName: 'read_file', toolKind: 'read',
      summary: 'package.json', status: 'done', startedAt: 1_000, completedAt: 1_120,
      timingEstimated: true
    }]} />)
    expect(html).toContain('观测 ~0.1s')
    expect(html).toContain('<time>~0.1s</time>')
    expect(html).not.toContain('累计 0.1s')
  })

  it('renders Cursor-native thinking duration and expandable browser/todo actions', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[
      { kind: 'thinking', id: 'thought', text: '分析页面', status: 'done', durationMs: 3_000 },
      { kind: 'tool', id: 'browser', toolName: 'browser_navigate', toolKind: 'browser', summary: 'http://localhost', output: '页面已加载', status: 'done' },
      { kind: 'tool', id: 'todo', toolName: 'todos', toolKind: 'todo', summary: '待办清单 0/1', todos: [{ content: '视觉验收', status: 'in_progress' }], status: 'running' }
    ]} />)
    expect(html).toContain('浏览器操作')
    expect(html).toContain('<time>for 3.0s</time>')
    expect(html).toContain('待办清单 0/1')
    expect(html).toContain('aria-expanded="false"')
  })

  it('renders todos as a progress bar with circular status indicators', async () => {
    await act(async () => {
      root.render(<ProcessBlocks blocks={[
        {
          kind: 'tool', id: 'todo', toolName: 'todos', toolKind: 'todo', summary: '待办清单 2/4', status: 'done',
          todos: [
            { content: '已完成项 A', status: 'completed' },
            { content: '已完成项 B', status: 'completed' },
            { content: '进行中项', status: 'in_progress' },
            { content: '待办项', status: 'pending' }
          ]
        }
      ]} />)
    })
    // 折叠态只露出头部 summary；点击展开后出现进度条与 Cursor 原生三态指示器
    const head = container.querySelector<HTMLButtonElement>('.cursor-native-tool__head')!
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('待办清单 2/4')
    await act(async () => { head.click() })
    const html = container.innerHTML
    expect(html).toContain('todo-progress')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="2"')
    expect(html).toContain('aria-valuemax="4"')
    // Cursor 原生指示器：完成=描边勾，进行=实心圆旋转弧（spinner），待办=空心圆
    expect(html).toContain('todo-indicator')
    expect(html).toMatch(/is-completed[^>]*>\s*<span class="todo-indicator"[^>]*>\s*<svg/)
    expect(html).toMatch(/is-in_progress[^>]*>\s*<span class="todo-indicator"[^>]*>\s*<span class="todo-spinner"/)
    expect(html).toContain('stroke-dasharray')
    expect(html).toContain('is-pending')
  })

  it('normalizes unknown todo statuses into the cancelled bucket instead of injecting raw class names', async () => {
    await act(async () => {
      root.render(<ProcessBlocks blocks={[
        {
          kind: 'tool', id: 'todo', toolName: 'todos', toolKind: 'todo', summary: '待办清单 0/2', status: 'done',
          todos: [
            { content: '已取消项', status: 'cancelled' },
            { content: '未知状态项', status: 'weird status with spaces' }
          ]
        }
      ]} />)
    })
    const head = container.querySelector<HTMLButtonElement>('.cursor-native-tool__head')!
    await act(async () => { head.click() })
    const html = container.innerHTML
    expect(html).toContain('is-cancelled')
    // 未知状态不透传进 class，杜绝「is-weird status with spaces」式注入
    expect(html).not.toContain('is-weird')
    expect(html).not.toContain('with spaces')
    expect(container.textContent).toContain('未知状态项')
  })
})
