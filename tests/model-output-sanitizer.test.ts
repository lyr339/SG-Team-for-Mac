import { describe, expect, it } from 'vitest'
import {
  hasToolTokenLeakage,
  sanitizeModelGeneratedText,
  stripDanglingBoldMarkers,
  stripLineDanglingBoldMarker,
  stripRedactionMarkers
} from '../src/domain/model-output-sanitizer'

// 特殊标记用拼接构造，避免字面序列在工具调用传输中被误解析（正是本缺陷本身）。
const OPEN = '<|' + 'open' + '|>'
const CLOSE = '<|' + 'close' + '|>'
const SEP = '<|' + 'sep' + '|>'

// 2026-08-28 CH-1 事故转录原文（工具调用标记泄漏进文本通道，生成截断）
const INCIDENT_TEXT =
  '**结论先说：截图里显示的是 "Auto · 200K '
  + CLOSE + 'argument' + SEP + OPEN + 'argument key="content" type="string"' + SEP
  + '**结论先说：截图里显示的是 "Auto · 200K'

describe('model-output-sanitizer', () => {
  it('detects the incident leakage and truncates to the leak point', () => {
    const result = sanitizeModelGeneratedText(INCIDENT_TEXT)
    expect(result.leaked).toBe(true)
    expect(result.text).toBe('结论先说：截图里显示的是 "Auto · 200K')
    expect(result.text).not.toContain('**')
    expect(result.text).not.toContain('<|')
  })


  it('does not false-positive on Haskell-style operators or plain pipes', () => {
    expect(hasToolTokenLeakage('f <| x 与 a <|> b')).toBe(false)
    expect(hasToolTokenLeakage('表格 | 管道 | 分隔符')).toBe(false)
    expect(hasToolTokenLeakage('a | b | c')).toBe(false)
  })

  describe('stripRedactionMarkers（Cursor 隐私脱敏标记）', () => {
    it('strips trailing markers from mixed thinking summaries', () => {
      expect(stripRedactionMarkers('正在读取 package.json 并查看项目结构，以便准确回答。 [REDACTED]'))
        .toBe('正在读取 package.json 并查看项目结构，以便准确回答。')
    })

    it('strips mid-text markers and collapses the leftover whitespace', () => {
      expect(stripRedactionMarkers('先读取配置 [REDACTED] 然后继续分析'))
        .toBe('先读取配置 然后继续分析')
    })

    it('reduces pure-redacted text to empty (dropped by callers)', () => {
      expect(stripRedactionMarkers('[REDACTED]')).toBe('')
      expect(stripRedactionMarkers('  [REDACTED] [redacted] ')).toBe('')
    })

    it('is case-insensitive and returns marker-free text untouched', () => {
      expect(stripRedactionMarkers('a [Redacted] b')).toBe('a b')
      const text = '正常思考文本，无标记。\n第二行 **保留** 原样。'
      expect(stripRedactionMarkers(text)).toBe(text)
    })

    it('keeps newlines and trims only edge whitespace', () => {
      expect(stripRedactionMarkers('  第一行\n第二行 [REDACTED]  '))
        .toBe('第一行\n第二行')
    })
  })

  it('detects leakage at position 0 (pure garbage text)', () => {
    const result = sanitizeModelGeneratedText(OPEN + 'argument key="content" type="string"')
    expect(result.leaked).toBe(true)
    expect(result.text).toBe('')
  })

  it('strips the dangling bold opener left by truncation but keeps paired bold', () => {
    expect(stripDanglingBoldMarkers('1. **MCP 工具层** 已注册，**中继聚合'))
      .toBe('1. **MCP 工具层** 已注册，中继聚合')
  })

  it('keeps glob patterns and math usage literal', () => {
    expect(stripLineDanglingBoldMarker('匹配 **/*.ts 全部文件')).toBe('匹配 **/*.ts 全部文件')
    expect(stripLineDanglingBoldMarker('计算 2 ** 3 的幂')).toBe('计算 2 ** 3 的幂')
    expect(stripLineDanglingBoldMarker('src/**/tests')).toBe('src/**/tests')
  })

  it('handles multi-line text line by line', () => {
    const input = '**正常粗体** 保留\n**未闭合标题'
    expect(stripDanglingBoldMarkers(input)).toBe('**正常粗体** 保留\n未闭合标题')
  })

  it('trims trailing whitespace left at the truncation boundary', () => {
    const result = sanitizeModelGeneratedText('正文写到一半   ' + SEP + '残片')
    expect(result.text).toBe('正文写到一半')
  })
})
