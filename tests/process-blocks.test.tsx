import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProcessBlock } from '../src/domain/conversation-entry'
import { ProcessBlocks } from '../src/renderer/src/ProcessBlocks'

describe('ProcessBlocks', () => {
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
})
