import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  WorkspaceDiffHunk,
  WorkspaceDiffLine,
  WorkspaceReviewActionInput,
  WorkspaceReviewActionResult,
  WorkspaceReviewBranchInfo,
  WorkspaceReviewFileDiff,
  WorkspaceReviewFileStatus,
  WorkspaceReviewFileSummary,
  WorkspaceReviewHeadCommit,
  WorkspaceReviewScope,
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

/**
 * Parse `git diff --name-status -z` (branch scope): `M\0path\0`, `A\0path\0`,
 * `D\0path\0`, `R100\0old\0new\0`. Copies (`C`) are reported as additions.
 */
export function parseNameStatusZ(value: string): WorkspaceReviewFileSummary[] {
  const records = value.split('\0')
  const files: WorkspaceReviewFileSummary[] = []
  for (let index = 0; index < records.length; index += 1) {
    const code = records[index]
    if (!code) continue
    const letter = code[0]!
    if (letter === 'R' || letter === 'C') {
      const previousPath = records[index + 1]
      const path = records[index + 2]
      index += 2
      if (!path) continue
      files.push({
        path,
        ...(letter === 'R' && previousPath ? { previousPath } : {}),
        status: letter === 'R' ? 'renamed' : 'added',
        staged: false,
        unstaged: false,
        committed: true
      })
      continue
    }
    const path = records[index + 1]
    index += 1
    if (!path) continue
    files.push({
      path,
      status: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'U' ? 'conflicted' : 'modified',
      staged: false,
      unstaged: false,
      committed: true
    })
  }
  return files
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

/**
 * Cut a single hunk out of a one-file unified diff so `git apply` can stage /
 * unstage / revert just that hunk. The hunk is located by its exact header
 * line; a stale header (file changed since the diff was displayed) yields
 * undefined instead of applying the wrong region.
 */
export function buildHunkPatch(rawDiff: string, hunkHeader: string): string | undefined {
  const lines = rawDiff.replace(/\r\n?/g, '\n').split('\n')
  const headerLines: string[] = []
  const hunkLines: string[] = []
  let inHeader = true
  let capturing = false
  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      inHeader = false
      if (capturing) break
      capturing = line === hunkHeader
      if (capturing) hunkLines.push(line)
      continue
    }
    if (inHeader) {
      headerLines.push(line)
      continue
    }
    if (capturing) hunkLines.push(line)
  }
  if (!hunkLines.length || !headerLines.some((line) => line.startsWith('diff --git'))) return undefined
  while (hunkLines.length && hunkLines[hunkLines.length - 1] === '') hunkLines.pop()
  return `${[...headerLines, ...hunkLines].join('\n')}\n`
}

function runGit(cwd: string, args: string[], allowFailure = false, input?: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = execFile('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: GIT_MAX_BUFFER,
      timeout: 8_000
    }, (error, stdout, stderr) => {
      if (error && !allowFailure) {
        const detail = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : error.message
        reject(new Error(detail))
        return
      }
      resolveOutput(typeof stdout === 'string' ? stdout : '')
    })
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
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
  scope: WorkspaceReviewScope,
  workspaceName: string,
  detail?: string
): WorkspaceReviewSummary {
  return {
    state,
    scope,
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

function normalizeScope(scope: unknown): WorkspaceReviewScope {
  return scope === 'branch' ? 'branch' : 'uncommitted'
}

export interface WorkspaceReviewActionPorts {
  /** 未跟踪 / 新增文件的「撤销」不是 rm：进系统回收站，可找回。 */
  trashItem?: (absolutePath: string) => Promise<void>
}

export class WorkspaceReviewReader {
  constructor(
    private readonly workspacePath: () => string | undefined,
    private readonly ports: WorkspaceReviewActionPorts = {}
  ) {}

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

  /** 当前分支与基线分支（origin/HEAD → main → master）。 */
  private async branchInfo(context: ReviewContext): Promise<WorkspaceReviewBranchInfo> {
    const current = (await runGit(context.root, ['rev-parse', '--abbrev-ref', 'HEAD'], true)).trim()
    const currentLabel = current && current !== 'HEAD'
      ? current
      : (await runGit(context.root, ['rev-parse', '--short', 'HEAD'], true)).trim()
    const remoteHead = (await runGit(context.root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], true)).trim()
    const candidates = [remoteHead, 'main', 'master', 'origin/main', 'origin/master'].filter(Boolean)
    let base: string | undefined
    for (const candidate of candidates) {
      const verified = (await runGit(context.root, ['rev-parse', '--verify', '-q', `${candidate}^{commit}`], true)).trim()
      if (verified) {
        base = candidate
        break
      }
    }
    const onBase = Boolean(base && (base === currentLabel || base === `origin/${currentLabel}`))
    return { current: currentLabel, ...(base ? { base } : {}), ...(onBase ? { onBase } : {}) }
  }

  private async mergeBase(context: ReviewContext, base: string): Promise<string | undefined> {
    const value = (await runGit(context.root, ['merge-base', 'HEAD', base], true)).trim()
    return value || undefined
  }

  private async headCommit(context: ReviewContext): Promise<WorkspaceReviewHeadCommit | undefined> {
    if (!context.hasHead) return undefined
    const raw = (await runGit(context.root, ['log', '-1', '--format=%h%x00%s'], true)).trim()
    if (!raw) return undefined
    const [short = '', subject = ''] = raw.split('\0')
    return short ? { short, subject } : undefined
  }

  /** 把仓库相对路径解析为工作区内的绝对路径（供在 Finder / 编辑器中打开）。 */
  async resolveWorkspaceFile(path: string): Promise<string> {
    const context = await this.context()
    if (!context?.root) throw new Error('当前没有可定位文件的工作区')
    return assertSafePath(context.root, path, context.workspacePath)
  }

  async summary(options: { scope?: WorkspaceReviewScope } = {}): Promise<WorkspaceReviewSummary> {
    const scope = normalizeScope(options.scope)
    let context: ReviewContext | undefined
    try {
      context = await this.context()
    } catch (error) {
      return emptySummary('unavailable', scope, '', error instanceof Error ? error.message : String(error))
    }
    if (!context) return emptySummary('unavailable', scope, '', '当前没有可审查的工作区')
    if (!context.root) return emptySummary('not_git', scope, context.workspaceName, '当前工作区还不是 Git 仓库')

    try {
      const statusRaw = await runGit(context.root, [
        'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', context.scope
      ])
      const worktreeFiles = parsePorcelainV2(statusRaw)
      const branch = context.hasHead ? await this.branchInfo(context) : undefined
      let diffBase = context.hasHead ? 'HEAD' : undefined
      const notes: string[] = []
      let allFiles = worktreeFiles
      if (scope === 'branch') {
        if (!branch?.base) {
          notes.push('未找到基线分支（origin/HEAD、main、master），已按未提交变更展示')
        } else if (branch.onBase) {
          notes.push(`当前就在基线分支 ${branch.base} 上，分支范围与未提交变更相同`)
        } else {
          const mergeBase = await this.mergeBase(context, branch.base)
          if (!mergeBase) {
            notes.push(`无法计算与 ${branch.base} 的共同祖先，已按未提交变更展示`)
          } else {
            diffBase = mergeBase
            const nameStatusRaw = await runGit(context.root, [
              'diff', '--name-status', '-z', '--find-renames', mergeBase, '--', context.scope
            ])
            const worktreeByPath = new Map(worktreeFiles.map((file) => [file.path, file]))
            const merged = parseNameStatusZ(nameStatusRaw).map((file) => {
              const live = worktreeByPath.get(file.path)
              if (!live) return file
              worktreeByPath.delete(file.path)
              return { ...file, staged: live.staged, unstaged: live.unstaged, committed: false }
            })
            // 只在工作树里、尚未进入任何提交的文件（未跟踪 / 新增暂存）也属于分支变更。
            for (const rest of worktreeByPath.values()) merged.push(rest)
            allFiles = merged
          }
        }
      }
      const files = allFiles.slice(0, MAX_FILES)
      const numstatRaw = diffBase
        ? await runGit(context.root, ['diff', '--numstat', '-z', '--find-renames', diffBase, '--', context.scope])
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
        .update(scope).update('\0').update(diffBase ?? '').update('\0')
        .update(statusRaw).update('\0').update(numstatRaw).update('\0').update(worktreeFingerprint)
        .digest('hex').slice(0, 16)
      if (allFiles.length > MAX_FILES) notes.push(`变更文件超过 ${MAX_FILES} 个，仅显示前 ${MAX_FILES} 个`)
      const headCommit = files.length ? undefined : await this.headCommit(context)
      return {
        state: files.length ? 'ready' : 'clean',
        scope,
        workspaceName: context.workspaceName,
        files,
        additions,
        deletions,
        revision,
        updatedAt: Date.now(),
        ...(notes.length ? { detail: notes.join('；') } : {}),
        ...(branch ? { branch } : {}),
        ...(headCommit ? { headCommit } : {})
      }
    } catch (error) {
      return emptySummary('error', scope, context.workspaceName, error instanceof Error ? error.message : String(error))
    }
  }

  async fileDiff(input: { path: string; scope?: WorkspaceReviewScope }): Promise<WorkspaceReviewFileDiff> {
    const scope = normalizeScope(input.scope)
    const context = await this.context()
    if (!context?.root) {
      return { state: 'missing', path: input.path, hunks: [], truncated: false, detail: '当前没有可读取差异的 Git 工作区' }
    }
    const filePath = await assertSafePath(context.root, input.path, context.workspacePath)
    const statusRaw = await runGit(context.root, [
      'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', context.scope
    ])
    const worktreeFile = parsePorcelainV2(statusRaw).find((file) => file.path === input.path)
    let diffBase = context.hasHead ? 'HEAD' : undefined
    let previousPath = worktreeFile?.previousPath
    if (scope === 'branch' && context.hasHead) {
      const branch = await this.branchInfo(context)
      const mergeBase = branch.base && !branch.onBase ? await this.mergeBase(context, branch.base) : undefined
      if (mergeBase) {
        diffBase = mergeBase
        if (!worktreeFile) {
          const nameStatusRaw = await runGit(context.root, [
            'diff', '--name-status', '-z', '--find-renames', mergeBase, '--', context.scope
          ])
          const committed = parseNameStatusZ(nameStatusRaw).find((file) => file.path === input.path)
          if (!committed) {
            return { state: 'missing', path: input.path, hunks: [], truncated: false, detail: '文件已无待审查变更' }
          }
          previousPath = committed.previousPath
        }
      } else if (!worktreeFile) {
        return { state: 'missing', path: input.path, hunks: [], truncated: false, detail: '文件已无待审查变更' }
      }
    } else if (!worktreeFile) {
      return { state: 'missing', path: input.path, hunks: [], truncated: false, detail: '文件已无待审查变更' }
    }
    if (previousPath) await assertSafePath(context.root, previousPath, context.workspacePath)
    const tracked = (await runGit(context.root, ['ls-files', '--', input.path], true)).trim()
    const paths = [previousPath, input.path].filter((value): value is string => Boolean(value))

    try {
      if (!diffBase || (!tracked && !previousPath)) {
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
        'diff', '--no-ext-diff', '--no-color', '--find-renames', '--unified=3', diffBase, '--', ...paths
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

  /**
   * 用户显式发起的 Git 动作。文件级动作按当前 git 状态选择命令；hunk 级动作在
   * 主进程重新生成与操作基准一致的差异（index→工作树 或 HEAD→index），按 hunk 头
   * 精确定位后交给 `git apply`。任何校验失败都不落地半个操作。
   */
  async apply(input: WorkspaceReviewActionInput): Promise<WorkspaceReviewActionResult> {
    const context = await this.context()
    if (!context?.root) return { ok: false, message: '当前没有可操作的 Git 工作区' }
    let filePath: string
    try {
      filePath = await assertSafePath(context.root, input.path, context.workspacePath)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    const statusRaw = await runGit(context.root, [
      'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', input.path
    ])
    const file = parsePorcelainV2(statusRaw).find((candidate) => candidate.path === input.path)
    if (!file) return { ok: false, message: '文件已无待处理变更，请刷新' }
    if (file.previousPath) {
      try {
        await assertSafePath(context.root, file.previousPath, context.workspacePath)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
    try {
      if (input.hunkHeader) return await this.applyHunk(context, file, input.action, input.hunkHeader)
      switch (input.action) {
        case 'stage':
          await runGit(context.root, ['add', '-A', '--', input.path])
          return { ok: true, message: `已暂存 ${input.path}` }
        case 'unstage':
          if (context.hasHead) await runGit(context.root, ['reset', '-q', '--', ...[file.previousPath, input.path].filter((value): value is string => Boolean(value))])
          else await runGit(context.root, ['rm', '--cached', '-q', '--', input.path])
          return { ok: true, message: `已取消暂存 ${input.path}` }
        case 'revert':
          return await this.revertFile(context, file, filePath)
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  private async revertFile(
    context: ReviewContext,
    file: WorkspaceReviewFileSummary,
    filePath: string
  ): Promise<WorkspaceReviewActionResult> {
    const inHead = context.hasHead
      && Boolean((await runGit(context.root, ['ls-tree', '--name-only', 'HEAD', '--', file.path], true)).trim())
    if (file.previousPath && context.hasHead) {
      // 重命名：恢复旧路径，把新路径从索引移除并送回收站。
      await runGit(context.root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', file.previousPath])
      await runGit(context.root, ['rm', '--cached', '-q', '--force', '--', file.path], true)
      await this.trash(filePath)
      return { ok: true, message: `已撤销重命名，恢复 ${file.previousPath}` }
    }
    if (inHead) {
      await runGit(context.root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', file.path])
      return { ok: true, message: `已撤销 ${file.path} 的改动` }
    }
    // HEAD 里没有：未跟踪或新增暂存文件。先出索引，再进回收站。
    if (file.staged) await runGit(context.root, ['rm', '--cached', '-q', '--force', '--', file.path], true)
    await this.trash(filePath)
    return { ok: true, message: `已移到回收站：${file.path}` }
  }

  private async trash(absolutePath: string): Promise<void> {
    if (!this.ports.trashItem) throw new Error('当前环境不支持移到回收站，未删除文件')
    try {
      await access(absolutePath)
    } catch {
      return
    }
    await this.ports.trashItem(absolutePath)
  }

  private async applyHunk(
    context: ReviewContext,
    file: WorkspaceReviewFileSummary,
    action: WorkspaceReviewActionInput['action'],
    hunkHeader: string
  ): Promise<WorkspaceReviewActionResult> {
    if (file.status === 'untracked' || file.status === 'conflicted' || file.previousPath) {
      return { ok: false, message: '该文件不支持按块操作，请使用整文件操作' }
    }
    const pureUnstaged = file.unstaged && !file.staged
    const pureStaged = file.staged && !file.unstaged
    if ((action === 'stage' || action === 'revert') && !pureUnstaged) {
      return { ok: false, message: '文件同时存在已暂存与未暂存改动，按块操作会错位；请先整文件处理' }
    }
    if (action === 'unstage' && !pureStaged) {
      return { ok: false, message: '文件存在未暂存改动，按块取消暂存会错位；请先整文件处理' }
    }
    const raw = await runGit(context.root, [
      'diff', '--no-ext-diff', '--no-color', '--unified=3',
      ...(action === 'unstage' ? ['--cached'] : []),
      '--', file.path
    ])
    const patch = buildHunkPatch(raw, hunkHeader)
    if (!patch) return { ok: false, message: '该代码块已变化，请刷新后重试' }
    const args = action === 'stage'
      ? ['apply', '--cached', '--recount']
      : action === 'unstage'
        ? ['apply', '--cached', '-R', '--recount']
        : ['apply', '-R', '--recount']
    await runGit(context.root, [...args, '-'], false, patch)
    const verb = action === 'stage' ? '已暂存' : action === 'unstage' ? '已取消暂存' : '已撤销'
    return { ok: true, message: `${verb}一个代码块：${file.path}` }
  }
}
