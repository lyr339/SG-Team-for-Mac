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

  it('converges double-escaped newlines before parsing markdown', () => {
    const text = '进展更新：\\\\n\\\\n- backend：10%\\\\n- reviewer：待命'
    expect(normalizeMessageText(text)).toBe('进展更新：\n\n- backend：10%\n- reviewer：待命')
    const html = renderToStaticMarkup(<MessageContent text={text} />)
    expect(html).toContain('<ul>')
    expect(html).not.toContain('\\n')
  })

  it('hides dangling bold openers from truncated model output but keeps glob patterns', () => {
    // 生成中断/截断残留的未闭合 ** 不应字面渲染（2026-08-28 CH-1 事故）
    const broken = renderToStaticMarkup(<MessageContent text={'结论先说：分析到一半 **'} />)
    expect(broken).not.toContain('**')
    const mixed = renderToStaticMarkup(<MessageContent text={'1. **服务层** 已确认，**中继聚合'} />)
    expect(mixed).toContain('<strong>服务层</strong>')
    expect(mixed).not.toContain('**')
    // 合法字面保留：路径通配与数学写法
    const glob = renderToStaticMarkup(<MessageContent text={'匹配 **/*.ts 与 src/**/tests'} />)
    expect(glob).toContain('**/*.ts')
    expect(glob).toContain('src/**/tests')
    expect(messagePlainText('**结论**：完成了 **一半')).toBe('结论：完成了 一半')
  })

  it('renders Markdown images: local paths through sg-image, remote as links, unknown targets as raw text', () => {
    const text = [
      '## 1. 输入区',
      '',
      '![自适应增高](/tmp/sg-composer-grow.png)',
      '',
      '行内也可以 ![缩略](/Users/lyr/Desktop/a b.jpg "标题") 混排，远程 ![站图](https://example.com/x.png) 只给链接。',
      '',
      '![不是图片](/etc/passwd)'
    ].join('\n')
    const blocks = parseMessageBlocks(text)
    expect(blocks[1]).toEqual({ type: 'image', alt: '自适应增高', target: '/tmp/sg-composer-grow.png' })
    expect(blocks[3]).toEqual({ type: 'image', alt: '不是图片', target: '/etc/passwd' })
    const html = renderToStaticMarkup(<MessageContent text={text} />)
    // 独占一行的图片成为 figure，且经 sg-image 协议加载，可点击查看
    expect(html).toContain('<figure class="message-figure">')
    expect(html).toContain('src="sg-image://local/%2Ftmp%2Fsg-composer-grow.png"')
    expect(html).toContain('attachment-thumb message-image__thumb')
    expect(html).toContain('<small class="message-image__caption">自适应增高</small>')
    // 行内图片带标题也能解析；空格路径原样编码
    expect(html).toContain('src="sg-image://local/%2FUsers%2Flyr%2FDesktop%2Fa%20b.jpg"')
    // 远程图片不加载，只给外链
    expect(html).toContain('href="https://example.com/x.png"')
    expect(html).not.toContain('src="https://example.com/x.png"')
    // 非图片目标原样保留为文本，不留破图
    expect(html).toContain('![不是图片](/etc/passwd)')
    expect(html).not.toContain('sg-image://local/%2Fetc%2Fpasswd')
    // 纯文本预览用 alt 代替语法
    expect(messagePlainText('看图 ![自适应增高](/tmp/a.png) 和 ![](/tmp/b.png)')).toBe('看图 [图片：自适应增高] 和 [图片]')
  })
})
