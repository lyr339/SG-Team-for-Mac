import { Fragment, memo, useMemo, type ReactNode } from 'react'
import { normalizeEscapedNewlines } from '../../domain/conversation-entry'
import { stripDanglingBoldMarkers } from '../../domain/model-output-sanitizer'

export type MessageBlock =
  | { type: 'paragraph'; lines: string[] }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'code'; language: string; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'divider' }

const HEADING = /^(#{1,3})\s+(.+)$/
const BULLET = /^\s*[-*•–—]\s+(.+)$/
const ORDERED = /^\s*\d+[.)]\s+(.+)$/
const QUOTE = /^\s*>\s?(.*)$/
const FENCE = /^\x60{3}\s*([^\s]*)/
const DIVIDER = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_DIVIDER = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/
const INLINE_TOKEN = /(\x60[^\x60\n]+\x60|\*\*[^*\n]+\*\*)/g

export function normalizeMessageText(text: string): string {
  return normalizeEscapedNewlines(text)
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function beginsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? ''
  const next = lines[index + 1] ?? ''
  return FENCE.test(line)
    || HEADING.test(line)
    || BULLET.test(line)
    || ORDERED.test(line)
    || QUOTE.test(line)
    || DIVIDER.test(line)
    || (line.includes('|') && TABLE_DIVIDER.test(next))
}

export function parseMessageBlocks(text: string): MessageBlock[] {
  const lines = normalizeMessageText(text).split('\n')
  const blocks: MessageBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = line.match(FENCE)
    if (fence) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !FENCE.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: 'code', language: fence[1] ?? '', text: code.join('\n') })
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]!.trim() })
      index += 1
      continue
    }

    if (DIVIDER.test(line)) {
      blocks.push({ type: 'divider' })
      index += 1
      continue
    }

    if (line.includes('|') && TABLE_DIVIDER.test(lines[index + 1] ?? '')) {
      const headers = tableCells(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) {
        rows.push(tableCells(lines[index] ?? ''))
        index += 1
      }
      blocks.push({ type: 'table', headers, rows })
      continue
    }

    const bullet = line.match(BULLET)
    const ordered = line.match(ORDERED)
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered)
      const items: string[] = []
      while (index < lines.length) {
        const match = (lines[index] ?? '').match(isOrdered ? ORDERED : BULLET)
        if (!match) break
        items.push(match[1]!.trim())
        index += 1
      }
      blocks.push({ type: 'list', ordered: isOrdered, items })
      continue
    }

    const quote = line.match(QUOTE)
    if (quote) {
      const quoteLines: string[] = []
      while (index < lines.length) {
        const match = (lines[index] ?? '').match(QUOTE)
        if (!match) break
        quoteLines.push(match[1] ?? '')
        index += 1
      }
      blocks.push({ type: 'quote', lines: quoteLines })
      continue
    }

    const paragraphLines = [line.trimEnd()]
    index += 1
    while (index < lines.length && (lines[index] ?? '').trim() && !beginsBlock(lines, index)) {
      paragraphLines.push((lines[index] ?? '').trimEnd())
      index += 1
    }
    blocks.push({ type: 'paragraph', lines: paragraphLines })
  }

  return blocks
}

function inlineContent(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  let tokenIndex = 0
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const at = match.index ?? 0
    if (at > cursor) nodes.push(stripDanglingBoldMarkers(text.slice(cursor, at)))
    const token = match[0]
    if (token.charCodeAt(0) === 96) {
      nodes.push(<code key={keyPrefix + '-code-' + tokenIndex}>{token.slice(1, -1)}</code>)
    } else {
      nodes.push(<strong key={keyPrefix + '-strong-' + tokenIndex}>{token.slice(2, -2)}</strong>)
    }
    tokenIndex += 1
    cursor = at + token.length
  }
  // 兜底：未配对的 **（模型输出被截断/工具标记泄漏的残留）不字面显示；
  // 路径通配 **\/*.ts 等合法字面由 strip 内部启发式保留。
  if (cursor < text.length) nodes.push(stripDanglingBoldMarkers(text.slice(cursor)))
  return nodes
}

function linesContent(lines: string[], keyPrefix: string): ReactNode {
  return lines.map((line, index) => (
    <Fragment key={keyPrefix + '-line-' + index}>
      {index > 0 ? <br /> : null}
      {inlineContent(line, keyPrefix + '-' + index)}
    </Fragment>
  ))
}

export function messagePlainText(text: string): string {
  return stripDanglingBoldMarkers(normalizeMessageText(text))
    .replace(/\x60{3}[\s\S]*?\x60{3}/g, ' [代码] ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\x60([^\x60]+)\x60/g, '$1')
    .replace(/^\s*(?:#{1,3}|[-*•–—]|\d+[.)]|>)\s*/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/[|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 打字机每帧只改 text；memo 让同文本的父级重渲染（快照推送）不重解析 Markdown。 */
export const MessageContent = memo(function MessageContent({
  text,
  className = ''
}: {
  text: string
  className?: string
}): React.JSX.Element {
  const blocks = useMemo(() => parseMessageBlocks(text), [text])
  return (
    <div className={'message-content ' + className}>
      {blocks.map((block, index) => {
        const key = block.type + '-' + index
        if (block.type === 'heading') {
          if (block.level === 1) return <h3 key={key}>{inlineContent(block.text, key)}</h3>
          if (block.level === 2) return <h4 key={key}>{inlineContent(block.text, key)}</h4>
          return <h5 key={key}>{inlineContent(block.text, key)}</h5>
        }
        if (block.type === 'list') {
          const items = block.items.map((item, itemIndex) => (
            <li key={key + '-' + itemIndex}>{inlineContent(item, key + '-' + itemIndex)}</li>
          ))
          return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>
        }
        if (block.type === 'quote') {
          return <blockquote key={key}>{linesContent(block.lines, key)}</blockquote>
        }
        if (block.type === 'code') {
          return <pre key={key} data-language={block.language || undefined}><code>{block.text}</code></pre>
        }
        if (block.type === 'table') {
          return (
            <div className="message-table-wrap" key={key}>
              <table>
                <thead><tr>{block.headers.map((cell, cellIndex) => <th key={cellIndex}>{inlineContent(cell, key + '-h-' + cellIndex)}</th>)}</tr></thead>
                <tbody>{block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>{block.headers.map((_, cellIndex) => <td key={cellIndex}>{inlineContent(row[cellIndex] ?? '', key + '-' + rowIndex + '-' + cellIndex)}</td>)}</tr>
                ))}</tbody>
              </table>
            </div>
          )
        }
        if (block.type === 'divider') return <hr key={key} />
        return <p key={key}>{linesContent(block.lines, key)}</p>
      })}
    </div>
  )
})
