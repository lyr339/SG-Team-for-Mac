import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type {
  CursorWorkspaceDetection,
  DetectedCursorWorkspace
} from '../../domain/cursor-workspace'
import { workspaceIdentityOf } from './workspace-identity'

const RECENT_PATHS_KEY = 'history.recentlyOpenedPathsList'
const WORKSPACE_METADATA_KEY = 'workspaceMetadata.entries'
const MAX_STATE_VALUE_BYTES = 8 * 1024 * 1024
const MAX_MCP_CONFIG_BYTES = 2 * 1024 * 1024
const CURSOR_WORKSPACE_ID = /^[a-f0-9]{32}$/
const LIVE_QINGTIAN_RUNTIME = /[\\/]workspaceStorage[\\/]([a-f0-9]{32})[\\/]QingTian\.qingtian-v2[\\/]runtime[\\/]mcp-server[\\/]index\.mjs(?:\s|$)/gi

type UnknownRecord = Record<string, unknown>

export interface CursorWorkspaceDetectorOptions {
  globalStateDatabase?: string
  workspaceStorageRoot?: string
  listProcesses?: () => string
  now?: () => number
}

function recordOf(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

function sqliteText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return undefined
}

function localFolderPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('file://')) return undefined
  try {
    const path = fileURLToPath(value)
    if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) return undefined
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function workspacePathFromMetadata(entry: UnknownRecord): string | undefined {
  const direct = localFolderPath(entry.folderUri)
  if (direct) return direct
  if (!Array.isArray(entry.paths)) return undefined
  for (const item of entry.paths) {
    const pathEntry = recordOf(item)
    const uri = recordOf(pathEntry?.uri)
    const fsPath = typeof uri?.fsPath === 'string' ? uri.fsPath : undefined
    if (fsPath && isAbsolute(fsPath)) {
      try {
        if (existsSync(fsPath) && statSync(fsPath).isDirectory()) return realpathSync(fsPath)
      } catch {
        // Cursor can remove a temporary workspace while its metadata entry is
        // still visible. Continue to the URI fallback instead of failing the
        // entire detection cycle.
      }
    }
    const external = localFolderPath(uri?.external)
    if (external) return external
  }
  return undefined
}

function defaultProcessList(): string {
  if (process.platform === 'win32') return ''
  try {
    return execFileSync('/bin/ps', ['ax', '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1_500,
      maxBuffer: 4 * 1024 * 1024
    })
  } catch {
    return ''
  }
}

function liveWorkspaceIds(processes: string): string[] {
  const ids = new Set<string>()
  LIVE_QINGTIAN_RUNTIME.lastIndex = 0
  for (let match = LIVE_QINGTIAN_RUNTIME.exec(processes); match; match = LIVE_QINGTIAN_RUNTIME.exec(processes)) {
    if (match[1] && CURSOR_WORKSPACE_ID.test(match[1])) ids.add(match[1])
  }
  return [...ids].sort()
}

function cursorIsRunning(processes: string): boolean {
  return /[\\/]Cursor\.app[\\/]Contents[\\/]MacOS[\\/]Cursor(?:\s|$)/.test(processes)
    || /(?:^|[\\/])Cursor\.exe(?:\s|$)/im.test(processes)
}

function qingtianChannelIds(workspacePath: string): string[] {
  const configPath = join(workspacePath, '.cursor', 'mcp.json')
  try {
    if (!existsSync(configPath) || statSync(configPath).size > MAX_MCP_CONFIG_BYTES) return []
    const root = recordOf(JSON.parse(readFileSync(configPath, 'utf8')))
    const servers = recordOf(root?.mcpServers)
    if (!servers) return []
    return [...new Set(Object.keys(servers).flatMap((name) => {
      const match = name.match(/^qtwx-mcp-(\d+)$/)
      return match?.[1] ? [match[1]] : []
    }))].sort((left, right) => Number(left) - Number(right) || left.localeCompare(right))
  } catch {
    return []
  }
}

function detectedWorkspace(path: string, cursorWorkspaceId?: string): DetectedCursorWorkspace | undefined {
  try {
    const identity = workspaceIdentityOf(path)
    return {
      ...identity,
      cursorWorkspaceId,
      channelIds: qingtianChannelIds(identity.path)
    }
  } catch {
    return undefined
  }
}

export class CursorWorkspaceDetector {
  private readonly globalStateDatabase: string
  private readonly workspaceStorageRoot: string
  private readonly listProcesses: () => string
  private readonly now: () => number

  constructor(options: CursorWorkspaceDetectorOptions = {}) {
    const supportRoot = join(homedir(), 'Library', 'Application Support', 'Cursor')
    this.globalStateDatabase = options.globalStateDatabase
      ?? join(supportRoot, 'User', 'globalStorage', 'state.vscdb')
    this.workspaceStorageRoot = options.workspaceStorageRoot
      ?? join(supportRoot, 'User', 'workspaceStorage')
    this.listProcesses = options.listProcesses ?? defaultProcessList
    this.now = options.now ?? Date.now
  }

  detect(): CursorWorkspaceDetection {
    const observedAt = this.now()
    const processes = this.listProcesses()
    const liveIds = liveWorkspaceIds(processes)
    const state = this.readCursorState()
    const metadataPaths = new Map(state.metadata.flatMap((entry) => {
      const workspaceId = typeof entry.workspaceId === 'string' ? entry.workspaceId.toLowerCase() : ''
      const path = workspacePathFromMetadata(entry)
      return CURSOR_WORKSPACE_ID.test(workspaceId) && path ? [[workspaceId, path] as const] : []
    }))
    const liveCandidates = liveIds.flatMap((workspaceId) => {
      const path = this.pathFromWorkspaceStorage(workspaceId) ?? metadataPaths.get(workspaceId)
      const workspace = path ? detectedWorkspace(path, workspaceId) : undefined
      return workspace ? [workspace] : []
    })

    if (liveIds.length === 1 && liveCandidates.length === 1) {
      return {
        state: 'detected',
        source: 'running-qingtian-mcp',
        confidence: 'certain',
        workspace: liveCandidates[0],
        candidates: liveCandidates,
        detail: '由当前运行中的晴天 MCP 通道确认',
        observedAt
      }
    }
    if (liveIds.length > 1) {
      return {
        state: 'ambiguous',
        source: 'running-qingtian-mcp',
        confidence: 'none',
        candidates: liveCandidates,
        detail: `检测到 ${liveIds.length} 个同时运行的 Cursor 工程，已停止自动切换`,
        observedAt
      }
    }

    if (cursorIsRunning(processes)) {
      const recentPath = state.recentPaths[0]
      const recent = recentPath ? detectedWorkspace(recentPath) : undefined
      if (recent) {
        return {
          state: 'detected',
          source: 'cursor-recent',
          confidence: 'likely',
          workspace: recent,
          candidates: [recent],
          detail: '由 Cursor 最近使用的本地工程推断，等待 MCP 通道进一步确认',
          observedAt
        }
      }
    }

    return {
      state: 'unavailable',
      confidence: 'none',
      candidates: [],
      detail: liveIds.length === 1
        ? '发现晴天 MCP 进程，但无法映射到本地 Cursor 工程'
        : '尚未发现正在运行的本地 Cursor 工程',
      observedAt
    }
  }

  private readCursorState(): { metadata: UnknownRecord[]; recentPaths: string[] } {
    if (!existsSync(this.globalStateDatabase)) return { metadata: [], recentPaths: [] }
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(this.globalStateDatabase, {
        readOnly: true,
        timeout: 300,
        defensive: true
      })
      database.exec('PRAGMA query_only = ON')
      database.exec('PRAGMA busy_timeout = 300')
      const rows = database.prepare(
        'SELECT key, value FROM ItemTable WHERE key IN (?, ?)'
      ).all(RECENT_PATHS_KEY, WORKSPACE_METADATA_KEY) as Array<{ key?: unknown; value?: unknown }>
      const values = new Map(rows.flatMap((row) => {
        const key = typeof row.key === 'string' ? row.key : ''
        const value = sqliteText(row.value)
        return key && value && Buffer.byteLength(value, 'utf8') <= MAX_STATE_VALUE_BYTES
          ? [[key, value] as const]
          : []
      }))
      const metadataRoot = recordOf(JSON.parse(values.get(WORKSPACE_METADATA_KEY) ?? '{}'))
      const recentRoot = recordOf(JSON.parse(values.get(RECENT_PATHS_KEY) ?? '{}'))
      const metadata = Array.isArray(metadataRoot?.entries)
        ? metadataRoot.entries.map(recordOf).filter((entry): entry is UnknownRecord => Boolean(entry))
        : []
      const recentPaths = Array.isArray(recentRoot?.entries)
        ? recentRoot.entries.flatMap((entry) => {
            const folderUri = recordOf(entry)?.folderUri
            const path = localFolderPath(folderUri)
            return path ? [path] : []
          })
        : []
      return { metadata, recentPaths }
    } catch {
      return { metadata: [], recentPaths: [] }
    } finally {
      database?.close()
    }
  }

  private pathFromWorkspaceStorage(workspaceId: string): string | undefined {
    const descriptorPath = join(this.workspaceStorageRoot, workspaceId, 'workspace.json')
    try {
      if (!existsSync(descriptorPath) || statSync(descriptorPath).size > 256 * 1024) return undefined
      const descriptor = recordOf(JSON.parse(readFileSync(descriptorPath, 'utf8')))
      return localFolderPath(descriptor?.folder)
    } catch {
      return undefined
    }
  }
}
