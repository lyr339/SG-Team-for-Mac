import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  WorkspaceDiffHunk,
  WorkspaceDiffLine,
  WorkspaceReviewFileDiff,
  WorkspaceReviewFileStatus,
  WorkspaceReviewFileSummary,
  WorkspaceReviewSummary
} from '../../domain/workspace-review'

const MAX_FILES = 200
const MAX_DIFF_LINES = 4_000
const MAX_TEXT_FILE_BYTES = 512 * 1024
const GIT_MAX_BUFFER = 8 * 1024 * 1024

interface ReviewContext {
  workspacePath: string
  workspaceName: string
  root: string
  scope: string
  hasHead: boolean
}

interface Numstat {
  additions?: number
  deletions?: number
  binary: boolean
}

function fileStatus(xy: string, recordType: string): WorkspaceReviewFileStatus {
  if (recordType === '?') return 'untracked'
  if (recordType === 'u' || xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflicted'
  if (xy.includes('R')) return 'renamed'
  if (xy.includes('A')) return 'added'
  if (xy.includes('D')) return 'deleted'
  return 'modified'
}

/** Parse `git status --porcelain=v2 -z`; paths remain lossless because `-z` disables quoting. */
export function parsePorcelainV2(value: string): WorkspaceReviewFileSummary[] {
  const records = value.split('\0')
  const files: WorkspaceReviewFileSummary[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.startsWith('# ')) continue
    const type = record[0]!
    if (type === '?') {
      const path = record.slice(2)
      if (path) files.push({ path, status: 'untracked', staged: false, unstaged: true })
      continue
    }
    const fields = record.split(' ')
    const xy = fields[1] ?? '..'
    const pathIndex = type === '1' ? 8 : type === '2' ? 9 : type === 'u' ? 10 : -1
    if (pathIndex < 0) continue
    const path = fields.slice(pathIndex).join(' ')
    if (!path) continue
    const previousPath = type === '2' ? records[index + 1] || undefined : undefined
    if (type === '2') index += 1
    files.push({
      path,
      ...(previousPath ? { previousPath } : {}),
      status: fileStatus(xy, type),
      staged: xy[0] !== '.' && xy[0] !== '?',
      unstaged: xy[1] !== '.' && xy[1] !== '?'
    })
  }
  return files
}

/** Parse `git diff --numstat -z`, including its three-record rename form. */
export function parseNumstatZ(value: string): Map<string, Numstat> {
  const records = value.split('\0')
  const result = new Map<string, Numstat>()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const additionsText = record.slice(0, firstTab)
    const deletionsText = record.slice(firstTab + 1, secondTab)
    let path = record.slice(secondTab + 1)
    if (!path) {
      index += 1 // previous path
      path = records[++index] ?? '' // destination path
    }
    if (!path) continue
    const binary = additionsText === '-' || deletionsText === '-'
    result.set(path, {
      additions: binary ? undefined : Number.parseInt(additionsText, 10),
      deletions: binary ? undefined : Number.parseInt(deletionsText, 10),
      binary
    })
  }
  return result
}

/** Parse one-file unified diff into renderer-ready hunks with stable old/new line numbers. */
export function parseUnifiedDiff(value: string, maxLines = MAX_DIFF_LINES): { hunks: WorkspaceDiffHunk[]; truncated: boolean } {
  const hunks: WorkspaceDiffHunk[] = []
  let current: WorkspaceDiffHunk | undefined
  let oldLine = 0
  let newLine = 0
  let previousOldEnd = 0
  let kept = 0
  let truncated = false

  for (const raw of value.replace(/\r\n?/g, '\n').split('\n')) {
    const header = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (header) {
      oldLine = Number.parseInt(header[1]!, 10)
      newLine = Number.parseInt(header[2]!, 10)
      current = {
        header: raw,
        skippedBefore: Math.max(0, oldLine - previousOldEnd - 1),
        lines: []
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (kept >= maxLines) {
      truncated = true
      break
    }
    let line: WorkspaceDiffLine
    if (raw.startsWith('+')) {
      line = { kind: 'addition', text: raw.slice(1), newLine }
      newLine += 1
    } else if (raw.startsWith('-')) {
      line = { kind: 'deletion', text: raw.slice(1), oldLine }
      oldLine += 1
    } else if (raw.startsWith(' ')) {
      line = { kind: 'context', text: raw.slice(1), oldLine, newLine }
      oldLine += 1
      newLine += 1
    } else if (raw.startsWith('\\ ')) {
      line = { kind: 'meta', text: raw }
    } else {
      continue
    }
    current.lines.push(line)
    previousOldEnd = Math.max(previousOldEnd, oldLine - 1)
    kept += 1
  }
  return { hunks, truncated }
}

function runGit(cwd: string, args: string[], allowFailure = false): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: GIT_MAX_BUFFER,
      timeout: 8_000
    }, (error, stdout) => {
      if (error && !allowFailure) {
        reject(error)
        return
      }
      resolveOutput(typeof stdout === 'string' ? stdout : '')
    })
  })
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

async function assertSafePath(root: string, path: string, boundary = root): Promise<string> {
  if (!path || isAbsolute(path) || path.includes('\0')) throw new Error('文件路径无效')
  const candidate = resolve(root, path)
  if (!isInside(boundary, candidate)) throw new Error('文件超出当前工作区')
  try {
    const actual = await realpath(candidate)
    if (!isInside(boundary, actual)) throw new Error('文件超出当前工作区')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }
  return candidate
}

function emptySummary(
  state: WorkspaceReviewSummary['state'],
  workspaceName: string,
  detail?: string
): WorkspaceReviewSummary {
  return {
    state,
    workspaceName,
    files: [],
    additions: 0,
    deletions: 0,
    revision: '',
    updatedAt: Date.now(),
    ...(detail ? { detail } : {})
  }
}

async function textAdditionCount(path: string): Promise<{ additions?: number; binary?: boolean }> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_TEXT_FILE_BYTES) return {}
    const content = await readFile(path)
    if (content.subarray(0, 8_192).includes(0)) return { binary: true }
    const text = content.toString('utf8')
    if (!text) return { additions: 0 }
    return { additions: text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0) }
  } catch {
    return {}
  }
}

async function workingFileFingerprint(root: string, boundary: string, file: WorkspaceReviewFileSummary): Promise<string> {
  if (!file.unstaged) return `${file.path}:index`
  try {
    const path = await assertSafePath(root, file.path, boundary)
    const info = await stat(path)
    return `${file.path}:${info.size}:${info.mtimeMs}`
  } catch {
    return `${file.path}:missing`
  }
}

export class WorkspaceReviewReader {
  constructor(private readonly workspacePath: () => string | undefined) {}

  private async context(): Promise<ReviewContext | undefined> {
    const configured = this.workspacePath()
    if (!configured) return undefined
    const workspacePath = await realpath(resolve(configured))
    await access(workspacePath)
    const root = (await runGit(workspacePath, ['rev-parse', '--show-toplevel'], true)).trim()
    if (!root) return { workspacePath, workspaceName: basename(workspacePath), root: '', scope: '.', hasHead: false }
    const scope = relative(root, workspacePath) || '.'
    const head = (await runGit(root, ['rev-parse', '--verify', 'HEAD'], true)).trim()
    return { workspacePath, workspaceName: basename(workspacePath), root, scope, hasHead: Boolean(head) }
  }

  async summary(): Promise<WorkspaceReviewSummary> {
    let context: ReviewContext | undefined
    try {
      context = await this.context()
    } catch (error) {
      return emptySummary('unavailable', '', error instanceof Error ? error.message : String(error))
    }
    if (!context) return emptySummary('unavailable', '', '当前没有可审查的工作区')
    if (!context.root) return emptySummary('not_git', context.workspaceName, '当前工作区还不是 Git 仓库')

    try {
      const statusRaw = await runGit(context.root, [
        'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', context.scope
      ])
      const allFiles = parsePorcelainV2(statusRaw)
      const files = allFiles.slice(0, MAX_FILES)
      const numstatRaw = context.hasHead
        ? await runGit(context.root, ['diff', '--numstat', '-z', '--find-renames', 'HEAD', '--', context.scope])
        : ''
      const counts = parseNumstatZ(numstatRaw)
      for (const file of files) {
        const count = counts.get(file.path)
        if (count) {
          file.additions = count.additions
          file.deletions = count.deletions
          file.binary = count.binary || undefined
        } else if (file.status === 'untracked' || file.status === 'added') {
          const addition = await textAdditionCount(await assertSafePath(context.root, file.path, context.workspacePath))
          file.additions = addition.additions
          file.deletions = addition.additions === undefined ? undefined : 0
          file.binary = addition.binary
        }
      }
      const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0)
      const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0)
      const worktreeFingerprint = (await Promise.all(files.map((file) => (
        workingFileFingerprint(context.root, context.workspacePath, file)
      )))).join('\0')
      const revision = createHash('sha1')
        .update(statusRaw).update('\0').update(numstatRaw).update('\0').update(worktreeFingerprint)
        .digest('hex').slice(0, 16)
      return {
        state: files.length ? 'ready' : 'clean',
        workspaceName: context.workspaceName,
        files,
        additions,
        deletions,
        revision,
        updatedAt: Date.now(),
        ...(allFiles.length > MAX_FILES
          ? { detail: `变更文件超过 ${MAX_FILES} 个，仅显示前 ${MAX_FILES} 个` }
          : {})
      }
    } catch (error) {
      return emptySummary('error', context.workspaceName, error instanceof Error ? error.message : String(error))
    }
  }

  async fileDiff(input: { path: string }): Promise<WorkspaceReviewFileDiff> {
    const context = await this.context()
    if (!context?.root) {
      return { state: 'missing', path: input.path, hunks: [], truncated: false, detail: '当前没有可读取差异的 Git 工作区' }
    }
    const filePath = await assertSafePath(context.root, input.path, context.workspacePath)
    const statusRaw = await runGit(context.root, [
      'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', context.scope
    ])
    const changedFile = parsePorcelainV2(statusRaw).find((file) => file.path === input.path)
    if (!changedFile) {
      return { state: 'missing', path: input.path, hunks: [], truncated: false, detail: '文件已无待审查变更' }
    }
    const previousPath = changedFile.previousPath
    if (previousPath) await assertSafePath(context.root, previousPath, context.workspacePath)
    const tracked = (await runGit(context.root, ['ls-files', '--', input.path], true)).trim()
    const paths = [previousPath, input.path].filter((value): value is string => Boolean(value))

    try {
      if (!context.hasHead || !tracked) {
        const content = await readFile(filePath)
        if (content.subarray(0, 8_192).includes(0)) {
          return { state: 'binary', path: input.path, previousPath, hunks: [], truncated: false }
        }
        const allLines = content.toString('utf8').replace(/\r\n?/g, '\n').split('\n')
        if (allLines.at(-1) === '') allLines.pop()
        const truncated = allLines.length > MAX_DIFF_LINES
        const lines = allLines.slice(0, MAX_DIFF_LINES).map((text, index): WorkspaceDiffLine => ({
          kind: 'addition', text, newLine: index + 1
        }))
        return {
          state: 'ready', path: input.path, previousPath,
          hunks: lines.length ? [{ header: `@@ -0 +1 @@`, skippedBefore: 0, lines }] : [],
          truncated
        }
      }

      const raw = await runGit(context.root, [
        'diff', '--no-ext-diff', '--no-color', '--find-renames', '--unified=3', 'HEAD', '--', ...paths
      ])
      if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(raw)) {
        return { state: 'binary', path: input.path, previousPath, hunks: [], truncated: false }
      }
      const parsed = parseUnifiedDiff(raw)
      return {
        state: 'ready', path: input.path, previousPath,
        hunks: parsed.hunks, truncated: parsed.truncated
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return {
        state: code === 'ENOENT' ? 'missing' : 'error',
        path: input.path,
        previousPath,
        hunks: [],
        truncated: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }
}
