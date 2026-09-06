import { describe, expect, it } from 'vitest'
import type { WorkspaceDiffLine } from '../src/domain/workspace-review'
import { hunkInlineSegments, inlineDiffSegments, tokenizeLine } from '../src/renderer/src/inspector/inline-diff'

describe('inline diff', () => {
  it('tokenizes into words, whitespace and single symbols that concatenate back to the source', () => {
    const line = 'const value = compute(a, b) // 注释'
    const tokens = tokenizeLine(line)
    expect(tokens.join('')).toBe(line)
    expect(tokens).toContain('compute')
    expect(tokens).toContain('(')
  })

  it('marks only the changed token when a single identifier is renamed', () => {
    const { old: before, new: after } = inlineDiffSegments('const value = 1', 'const total = 1')
    expect(before.map((segment) => [segment.text, segment.changed])).toEqual([['const ', false], ['value', true], [' = 1', false]])
    expect(after.map((segment) => [segment.text, segment.changed])).toEqual([['const ', false], ['total', true], [' = 1', false]])
  })

  it('falls back to whole-line highlighting when most of the line changed', () => {
    const { old: before, new: after } = inlineDiffSegments('return alpha()', 'throw new Error("beta gamma delta")')
    expect(before).toEqual([{ text: 'return alpha()', changed: true }])
    expect(after).toEqual([{ text: 'throw new Error("beta gamma delta")', changed: true }])
  })

  it('pairs deletion and addition runs by position and leaves unpaired lines without segments', () => {
    const lines: WorkspaceDiffLine[] = [
      { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'deletion', text: 'let x = 1', oldLine: 2 },
      { kind: 'deletion', text: 'let y = 2', oldLine: 3 },
      { kind: 'addition', text: 'let x = 10', newLine: 2 },
      { kind: 'addition', text: 'let y = 2', newLine: 3 },
      { kind: 'addition', text: 'let z = 3', newLine: 4 },
      { kind: 'context', text: 'b', oldLine: 4, newLine: 5 }
    ]
    const segments = hunkInlineSegments(lines)
    expect(segments[0]).toBeUndefined()
    expect(segments[1]?.some((segment) => segment.changed && segment.text === '1')).toBe(true)
    expect(segments[3]?.some((segment) => segment.changed && segment.text === '10')).toBe(true)
    // 第二对完全相同（移动行）：返回单个未变化片段。
    expect(segments[2]).toEqual([{ text: 'let y = 2', changed: false }])
    expect(segments[4]).toEqual([{ text: 'let y = 2', changed: false }])
    // 多出的新增行没有配对。
    expect(segments[5]).toBeUndefined()
    expect(segments[6]).toBeUndefined()
  })
})
