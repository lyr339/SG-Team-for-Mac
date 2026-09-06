import type { WorkspaceDiffLine } from '../../../domain/workspace-review'

/**
 * 行内字级差异：把相邻的「删除行 / 新增行」按位置配对，对每一对做 token 级 LCS，
 * 标出真正变化的片段。GitHub / Codex 的 diff 都这样做——没有它，改一个变量名要
 * 用户自己在两行红绿之间肉眼找。
 *
 * 纯函数、渲染层计算：单个 hunk 内一对行最多几百个 token，O(n·m) 可控；超出上限
 * 直接整行标记，不做二次分割。
 */
export interface InlineSegment {
  text: string
  changed: boolean
}

const MAX_TOKENS = 400

/** 按「单词 / 空白 / 单个符号」切分，保证拼接回去与原文一致。 */
export function tokenizeLine(text: string): string[] {
  return text.match(/[A-Za-z0-9_\u00C0-\uFFFF]+|\s+|[^\sA-Za-z0-9_\u00C0-\uFFFF]/g) ?? []
}

function lcsTable(left: string[], right: string[]): Uint16Array {
  const width = right.length + 1
  const table = new Uint16Array((left.length + 1) * width)
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = left[i] === right[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  return table
}

function pushSegment(target: InlineSegment[], text: string, changed: boolean): void {
  if (!text) return
  const last = target[target.length - 1]
  if (last && last.changed === changed) last.text += text
  else target.push({ text, changed })
}

/** 一对旧 / 新行的字级片段；相同文本返回单个未变化片段。 */
export function inlineDiffSegments(oldText: string, newText: string): { old: InlineSegment[]; new: InlineSegment[] } {
  if (oldText === newText) {
    return { old: [{ text: oldText, changed: false }], new: [{ text: newText, changed: false }] }
  }
  const left = tokenizeLine(oldText)
  const right = tokenizeLine(newText)
  if (!left.length || !right.length || left.length > MAX_TOKENS || right.length > MAX_TOKENS) {
    return { old: [{ text: oldText, changed: true }], new: [{ text: newText, changed: true }] }
  }
  const width = right.length + 1
  const table = lcsTable(left, right)
  const oldSegments: InlineSegment[] = []
  const newSegments: InlineSegment[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      pushSegment(oldSegments, left[i]!, false)
      pushSegment(newSegments, right[j]!, false)
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      pushSegment(oldSegments, left[i]!, true)
      i += 1
    } else {
      pushSegment(newSegments, right[j]!, true)
      j += 1
    }
  }
  while (i < left.length) pushSegment(oldSegments, left[i++]!, true)
  while (j < right.length) pushSegment(newSegments, right[j++]!, true)
  // 变化占比过高时字级高亮只剩噪音：退回整行。
  const changedRatio = (segments: InlineSegment[], total: number): number => (
    total ? segments.filter((segment) => segment.changed).reduce((sum, segment) => sum + segment.text.length, 0) / total : 0
  )
  if (changedRatio(oldSegments, oldText.length) > 0.75 && changedRatio(newSegments, newText.length) > 0.75) {
    return { old: [{ text: oldText, changed: true }], new: [{ text: newText, changed: true }] }
  }
  return { old: oldSegments, new: newSegments }
}

/**
 * 为一个 hunk 的行序列计算字级片段：连续的删除块与紧随其后的新增块按位置配对
 * （第 k 个删除行 ↔ 第 k 个新增行），未配对的行不做字级标注。
 * 返回按行索引对齐的片段数组；无字级信息的行为 undefined。
 */
export function hunkInlineSegments(lines: readonly WorkspaceDiffLine[]): Array<InlineSegment[] | undefined> {
  const result: Array<InlineSegment[] | undefined> = new Array(lines.length).fill(undefined)
  let index = 0
  while (index < lines.length) {
    if (lines[index]!.kind !== 'deletion') {
      index += 1
      continue
    }
    const deletionStart = index
    while (index < lines.length && lines[index]!.kind === 'deletion') index += 1
    const additionStart = index
    while (index < lines.length && lines[index]!.kind === 'addition') index += 1
    const deletions = additionStart - deletionStart
    const additions = index - additionStart
    const pairs = Math.min(deletions, additions)
    for (let k = 0; k < pairs; k += 1) {
      const oldLine = lines[deletionStart + k]!
      const newLine = lines[additionStart + k]!
      const segments = inlineDiffSegments(oldLine.text, newLine.text)
      const fullyChanged = segments.old.length === 1 && segments.old[0]!.changed
        && segments.new.length === 1 && segments.new[0]!.changed
      if (fullyChanged) continue
      result[deletionStart + k] = segments.old
      result[additionStart + k] = segments.new
    }
  }
  return result
}
