import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * 工作区变更监听：Agent 写文件 / git 操作后把「有变化」的信号推给渲染层，替代 2s
 * 轮询。只做信号，不在监听回调里读 git——摘要仍由渲染层按当前范围拉取。
 *
 * 忽略规则：node_modules 与 .git 内部对象；但 .git/index、.git/HEAD、.git/refs 是
 * 暂存 / 提交 / 切分支的证据，必须放行。递归监听依赖平台原生能力（macOS FSEvents、
 * Windows ReadDirectoryChangesW）；不支持或失败时 `active=false`，渲染层回落轮询。
 */
export interface WorkspaceReviewWatcherOptions {
  workspacePath: () => string | undefined
  onChange: () => void
  onStatus?: (active: boolean) => void
  debounceMs?: number
  /** 测试注入：替代 fs.watch。 */
  watch?: (root: string, listener: (eventType: string, filename: string | Buffer | null) => void) => Pick<FSWatcher, 'close' | 'on'>
  /** 测试注入：替代 git rev-parse --show-toplevel。 */
  resolveRoot?: (workspacePath: string) => Promise<string | undefined>
}

const DEFAULT_DEBOUNCE_MS = 300

/** 相对仓库根的路径是否应触发刷新。 */
export function isWatchRelevantPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized) return true
  const segments = normalized.split('/')
  if (segments.includes('node_modules')) return false
  if (segments.at(-1) === '.DS_Store') return false
  const gitIndex = segments.indexOf('.git')
  if (gitIndex >= 0) {
    const inside = segments.slice(gitIndex + 1)
    const head = inside[0] ?? ''
    if (!head) return false
    if (head.endsWith('.lock')) return false
    return head === 'index' || head === 'HEAD' || head === 'ORIG_HEAD' || head === 'MERGE_HEAD' || head === 'refs' || head === 'packed-refs'
  }
  return true
}

async function defaultResolveRoot(workspacePath: string): Promise<string | undefined> {
  const real = await realpath(resolve(workspacePath)).catch(() => undefined)
  if (!real) return undefined
  return new Promise((resolveRoot) => {
    execFile('git', ['rev-parse', '--show-toplevel'], {
      cwd: real,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
      timeout: 5_000
    }, (error, stdout) => {
      resolveRoot(!error && typeof stdout === 'string' && stdout.trim() ? stdout.trim() : real)
    })
  })
}

export class WorkspaceReviewWatcher {
  private watcher: Pick<FSWatcher, 'close' | 'on'> | undefined
  private watchedRoot = ''
  private watchedWorkspace = ''
  private timer: NodeJS.Timeout | undefined
  private refreshing: Promise<void> | undefined
  private stopped = true
  active = false

  constructor(private readonly options: WorkspaceReviewWatcherOptions) {}

  start(): void {
    this.stopped = false
    void this.refresh()
  }

  stop(): void {
    this.stopped = true
    this.closeWatcher()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.watchedWorkspace = ''
  }

  /** 工作区切换时重新绑定监听；同一路径重复调用无副作用。 */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.rebind().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async rebind(): Promise<void> {
    if (this.stopped) return
    const workspace = this.options.workspacePath()?.trim() ?? ''
    if (workspace === this.watchedWorkspace && (this.watcher || !workspace)) return
    this.closeWatcher()
    this.watchedWorkspace = workspace
    if (!workspace) return
    const resolveRoot = this.options.resolveRoot ?? defaultResolveRoot
    const root = await resolveRoot(workspace)
    if (this.stopped || workspace !== this.watchedWorkspace) return
    if (!root) return
    try {
      const watch = this.options.watch ?? ((target, listener) => fsWatch(target, { recursive: true, persistent: false }, listener))
      const watcher = watch(root, (_eventType, filename) => {
        const name = typeof filename === 'string' ? filename : filename ? filename.toString() : ''
        if (name && !isWatchRelevantPath(name)) return
        this.schedule()
      })
      watcher.on('error', () => {
        this.closeWatcher()
      })
      this.watcher = watcher
      this.watchedRoot = root
      this.setActive(true)
    } catch {
      this.setActive(false)
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.stopped) this.options.onChange()
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
  }

  private closeWatcher(): void {
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        // 关闭失败不影响后续重绑。
      }
    }
    this.watcher = undefined
    this.watchedRoot = ''
    this.setActive(false)
  }

  private setActive(value: boolean): void {
    if (this.active === value) return
    this.active = value
    this.options.onStatus?.(value)
  }

  get root(): string {
    return this.watchedRoot
  }
}
