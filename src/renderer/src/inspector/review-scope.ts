import type { ConversationEntry, ProcessBlock } from '../../../domain/conversation-entry'
import type { WorkspaceReviewFileSummary, WorkspaceReviewSummary } from '../../../domain/workspace-review'
import type { LiveProcessState } from '../../../shared/desktop-api'

/**
 * 「本轮」审查范围：Git 没有时间维度，用最近一条已投递用户消息之后的 edit / write
 * 过程块提取文件路径，与未提交变更取交集。复用 outboundId 虚拟回合边界，不新增采集。
 */
export type ReviewScopeId = 'uncommitted' | 'turn' | 'branch'

export const REVIEW_SCOPE_LABELS: Record<ReviewScopeId, string> = {
  uncommitted: '未提交',
  turn: '本轮',
  branch: '分支'
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'targetFile', 'target_file', 'filename', 'relativePath', 'relative_workspace_path']

/** 过程块里能代表文件的字符串（summary 优先，其次 input 里的路径键）。 */
export function processBlockPath(block: ProcessBlock): string | undefined {
  if (block.kind !== 'tool') return undefined
  const candidates: unknown[] = [block.summary]
  if (block.input) for (const key of PATH_KEYS) candidates.push(block.input[key])
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const value = candidate.trim()
    if (!value || /[\n\r\u0000]/.test(value) || value.length > 1_000) continue
    // 命令行 / 查询语句不是路径：含空格且不含路径分隔符的直接跳过。
    if (/\s/.test(value) && !/[\\/]/.test(value)) continue
    return value
  }
  return undefined
}

export function isFileMutationBlock(block: ProcessBlock): boolean {
  return block.kind === 'tool' && (block.toolKind === 'edit' || block.toolKind === 'write')
}

/** 统一为 POSIX 分隔、去掉 `./`、去掉工作区前缀（若给出）。 */
export function normalizeReviewPath(path: string, workspacePath?: string): string {
  let value = path.trim().replace(/\\/g, '/').replace(/^file:\/\//, '')
  if (workspacePath) {
    const root = workspacePath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    if (root && (value === root || value.startsWith(`${root}/`))) value = value.slice(root.length + 1)
  }
  return value.replace(/^\.\//, '').replace(/^\/{2,}/, '/')
}

/** 两个路径是否指向同一文件：一方是另一方按段的后缀（工作区可能位于仓库子目录）。 */
export function reviewPathsMatch(left: string, right: string): boolean {
  const a = left.replace(/^\/+/, '').split('/').filter(Boolean)
  const b = right.replace(/^\/+/, '').split('/').filter(Boolean)
  if (!a.length || !b.length) return false
  const short = a.length <= b.length ? a : b
  const long = short === a ? b : a
  for (let index = 1; index <= short.length; index += 1) {
    if (short[short.length - index] !== long[long.length - index]) return false
  }
  return true
}

/** 最近一条已投递用户消息在 entries 里的下标；没有则 -1。 */
export function latestDeliveredUserIndex(entries: readonly ConversationEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.role === 'user' && entry.deliveredAt !== undefined) return index
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.role === 'user') return index
  }
  return -1
}

/** 本轮（最近一条已投递用户消息之后）改动过的文件路径（已归一，去重，保持首次出现顺序）。 */
export function turnMutatedPaths(
  entries: readonly ConversationEntry[],
  liveProcess: LiveProcessState | undefined,
  workspacePath?: string
): string[] {
  const start = latestDeliveredUserIndex(entries)
  const blocks: ProcessBlock[] = []
  for (const entry of entries.slice(start + 1)) {
    if (entry.role === 'assistant' && entry.processBlocks) blocks.push(...entry.processBlocks)
  }
  if (liveProcess) blocks.push(...liveProcess.blocks)
  const paths: string[] = []
  for (const block of blocks) {
    if (!isFileMutationBlock(block)) continue
    const raw = processBlockPath(block)
    if (!raw) continue
    const normalized = normalizeReviewPath(raw, workspacePath)
    if (normalized && !paths.includes(normalized)) paths.push(normalized)
  }
  return paths
}

/** 用一组路径过滤未提交摘要（保留合计与 revision 语义，重新累计增删）。 */
export function filterSummaryToPaths(summary: WorkspaceReviewSummary, paths: readonly string[]): WorkspaceReviewSummary {
  if (summary.state !== 'ready') return summary
  const files = summary.files.filter((file) => (
    paths.some((path) => reviewPathsMatch(file.path, path) || (file.previousPath ? reviewPathsMatch(file.previousPath, path) : false))
  ))
  return {
    ...summary,
    state: files.length ? 'ready' : 'clean',
    files,
    additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
    deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0)
  }
}

/** 文件是否在给定路径集合内（供列表行高亮「本轮改动」）。 */
export function fileTouchedBy(file: Pick<WorkspaceReviewFileSummary, 'path' | 'previousPath'>, paths: readonly string[]): boolean {
  return paths.some((path) => reviewPathsMatch(file.path, path) || (file.previousPath ? reviewPathsMatch(file.previousPath, path) : false))
}
