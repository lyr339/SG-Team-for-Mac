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
    expect(html).toContain('思考')
    expect(html).toContain('命令')
    expect(html).toContain('进行中')
    expect(html).toContain('失败 (1)')
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

    expect(html).toContain('disabled=""')
    expect(html).not.toContain('aria-expanded')
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
    expect(html).toContain('- 依赖外部浏览器')
    expect(html).not.toContain('\\n')
  })

  it('returns null for an empty block list', () => {
    expect(renderToStaticMarkup(<ProcessBlocks blocks={[]} />)).toBe('')
  })
})
