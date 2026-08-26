import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  MessageContent,
  messagePlainText,
  normalizeMessageText,
  parseMessageBlocks
} from '../src/renderer/src/MessageContent'

describe('MessageContent', () => {
  it('renders common Agent Markdown without exposing formatting markers', () => {
    const text = [
      '收到 **CH-2** 更新。',
      '',
      '## 当前结论',
      '',
      '- 任务已完成',
      '- 等待验收',
      '',
      '使用 `submit_for_review` 提交。'
    ].join('\n')
    const html = renderToStaticMarkup(<MessageContent text={text} />)

    expect(html).toContain('<strong>CH-2</strong>')
    expect(html).toContain('<h4>当前结论</h4>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<code>submit_for_review</code>')
    expect(html).not.toContain('**')
    expect(html).not.toContain('##')
  })

  it('renders tables and keeps raw HTML inert', () => {
    const text = [
      '| 路径 | 用途 |',
      '| --- | --- |',
      '| README.md | 说明 |',
      '',
      '<img src=x onerror=alert(1)>'
    ].join('\n')
    const html = renderToStaticMarkup(<MessageContent text={text} />)

    expect(parseMessageBlocks(text)[0]?.type).toBe('table')
    expect(html).toContain('<table>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src="x"')
  })

  it('produces a clean one-line preview', () => {
    expect(messagePlainText('## 结论\n\n- **完成**\n- 暂无阻塞')).toBe('结论 完成 暂无阻塞')
  })

  it('treats repeated escaped newlines from agent replies as markdown line breaks', () => {
    const text = '收到，已确认成员离线。\\n\\n当前任务板：\\n- P1：样式收敛\\n- P2：过程块修复'
    expect(normalizeMessageText(text)).toContain('\n- P1')
    expect(parseMessageBlocks(text).map((block) => block.type)).toEqual(['paragraph', 'paragraph', 'list'])
    const html = renderToStaticMarkup(<MessageContent text={text} />)
    expect(html).toContain('<ul>')
    expect(html).not.toContain('\\n')
  })
})
