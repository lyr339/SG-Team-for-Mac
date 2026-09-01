/**
 * 模型工具调用标记泄漏的检测与净化。
 *
 * 背景（2026-08-28 CH-1 事故实锤）：模型流式生成工具调用时，特殊标记
 * （`<|open|>` / `<|close|>` / `<|sep|>` 等管道分隔 token）可能泄漏进文本通道，
 * 且生成在标记中途截断——record_reply 根本不会发出，而泄漏文本已持久化进
 * Cursor 转录。若不净化，窗口会把未闭合的 `**` 与标记残片原样渲染成乱码。
 *
 * 该标记形态（`<|` + 小写字母/数字/`-`/`_` + `|>`）在正常中英文内容、代码、
 * Markdown 中均不合法（Haskell 的 `<|` 后随空格、`<|>` 中间无字母，均不匹配），
 * 命中即视为生成已损坏的阳性证据：截断到泄漏点，并清理截断残留的未闭合粗体标记。
 */

/** 管道分隔特殊标记（`<|open|>` / `<|close|>` / `<|sep|>` 等）。 */
const TOOL_TOKEN_PATTERN = /<\|[a-z][a-z0-9_-]*\|>/i

/**
 * Cursor 隐私脱敏标记（`[REDACTED]`）：Cursor 后端生成思考摘要时，会把推理中
 * 引用的敏感内容（文件正文、代码片段、密钥等）替换为该标记后才下发到客户端
 * 数据模型——不是乱码，是 Cursor 自己的脱敏产物。对纯展示文本它是零信息量
 * 噪音（如「正在读取 package.json…以便准确回答。 [REDACTED]」）。
 */
const REDACTION_MARKER_PATTERN = /\[REDACTED\]/gi

/**
 * 剥离 Cursor 脱敏标记并收敛残留空白（仅用于思考摘要等纯展示文本；
 * 工具参数明细中的脱敏片段保留原样——剥离会把 `[REDACTED]/foo.ts` 误显示成
 * 完整路径，比保留标记更误导）。
 */
export function stripRedactionMarkers(text: string): string {
  if (!REDACTION_MARKER_PATTERN.test(text)) {
    REDACTION_MARKER_PATTERN.lastIndex = 0
    return text
  }
  REDACTION_MARKER_PATTERN.lastIndex = 0
  return text
    .replace(REDACTION_MARKER_PATTERN, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([。！？，、；：）】」』.,!?;:)\]])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

export interface SanitizedModelText {
  text: string
  /** 是否检出工具调用标记泄漏（生成中断的阳性证据）。 */
  leaked: boolean
}

/** 快速检测文本是否含工具调用标记泄漏。 */
export function hasToolTokenLeakage(text: string): boolean {
  return TOOL_TOKEN_PATTERN.test(text)
}

/**
 * 净化模型生成文本：未检出泄漏时原样返回；检出时截断到首个泄漏标记之前，
 * 并清理截断残留的未闭合 `**`（截断文本是原文前缀，未配对者必为「打开未闭合」）。
 */
export function sanitizeModelGeneratedText(raw: string): SanitizedModelText {
  const match = TOOL_TOKEN_PATTERN.exec(raw)
  if (!match) return { text: raw, leaked: false }
  const truncated = raw.slice(0, match.index).replace(/[ \t]+$/g, '')
  return { text: stripDanglingBoldMarkers(truncated), leaked: true }
}

/** 用户可见的模型文本统一入口：处理工具标记泄漏，并移除零信息量脱敏占位符。 */
export function sanitizeModelDisplayText(raw: string): SanitizedModelText {
  const sanitized = sanitizeModelGeneratedText(raw)
  return {
    ...sanitized,
    text: stripRedactionMarkers(
      sanitized.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    )
  }
}

/** 逐行清理未配对的粗体标记（配对规则与渲染层一致：顺序两两配对）。 */
export function stripDanglingBoldMarkers(text: string): string {
  return text.split('\n').map(stripLineDanglingBoldMarker).join('\n')
}

/**
 * 清理单行内未配对的 `**`。奇数个时最后一个为「打开未闭合」，
 * 形似粗体 opener 时移除；以下合法字面保留：
 * 路径通配（后随 `/` 或前接 `/`）、数学写法（后随空白，如 `2 ** 3`）、
 * 粗斜体标记（后随 `*`）。行尾孤立 `**`（截断/打字机瞬态）同样移除。
 */
export function stripLineDanglingBoldMarker(line: string): string {
  const positions: number[] = []
  for (let index = 0; index < line.length - 1; index += 1) {
    if (line[index] === '*' && line[index + 1] === '*') {
      positions.push(index)
      index += 1
    }
  }
  if (positions.length % 2 === 0) return line
  const last = positions.at(-1)
  if (last === undefined) return line
  const next = line[last + 2]
  if (next === '/' || next === '*' || (next !== undefined && /\s/.test(next))) return line
  if (line[last - 1] === '/') return line
  return `${line.slice(0, last)}${line.slice(last + 2)}`
}
