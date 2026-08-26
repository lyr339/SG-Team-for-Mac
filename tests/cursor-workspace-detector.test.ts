import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { CursorWorkspaceDetector } from '../src/infrastructure/cursor/cursor-workspace-detector'
import { workspaceIdentityOf } from '../src/infrastructure/cursor/workspace-identity'
import { shouldAutoFollowCursorWorkspace } from '../src/domain/cursor-workspace'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qingtian-workspace-detect-'))
  roots.push(root)
  const storage = join(root, 'workspaceStorage')
  const projectA = join(root, 'property-app')
  const projectB = join(root, 'second-app')
  mkdirSync(storage, { recursive: true })
  for (const path of [projectA, projectB]) {
    mkdirSync(join(path, '.cursor'), { recursive: true })
    writeFileSync(join(path, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: {
        'qtwx-mcp-1': {},
        'qtwx-mcp-2': {},
        'qtwx-mcp-4': {},
        unrelated: {}
      }
    }))
  }
  const cursorA = 'a'.repeat(32)
  const cursorB = 'b'.repeat(32)
  for (const [id, path] of [[cursorA, projectA], [cursorB, projectB]] as const) {
    mkdirSync(join(storage, id), { recursive: true })
    writeFileSync(join(storage, id, 'workspace.json'), JSON.stringify({
      folder: new URL(`file://${path}`).toString()
    }))
  }
  const databasePath = join(root, 'state.vscdb')
  const database = new DatabaseSync(databasePath)
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
  database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'history.recentlyOpenedPathsList',
    JSON.stringify({ entries: [{ folderUri: new URL(`file://${projectA}`).toString() }] })
  )
  database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'workspaceMetadata.entries',
    JSON.stringify({ entries: [
      { workspaceId: cursorA, folderUri: new URL(`file://${projectA}`).toString() },
      { workspaceId: cursorB, folderUri: new URL(`file://${projectB}`).toString() }
    ] })
  )
  database.close()
  return { databasePath, storage, projectA, projectB, cursorA, cursorB }
}

function runtimeProcess(storage: string, workspaceId: string): string {
  return `/usr/local/bin/node ${join(storage, workspaceId, 'QingTian.qingtian-v2/runtime/mcp-server/index.mjs')}`
}

describe('CursorWorkspaceDetector', () => {
  it('uses the unique running qtwx MCP workspace as authoritative evidence', () => {
    const data = fixture()
    const detector = new CursorWorkspaceDetector({
      globalStateDatabase: data.databasePath,
      workspaceStorageRoot: data.storage,
      listProcesses: () => [
        runtimeProcess(data.storage, data.cursorA),
        runtimeProcess(data.storage, data.cursorA)
      ].join('\n'),
      now: () => 123
    })
    expect(detector.detect()).toMatchObject({
      state: 'detected',
      confidence: 'certain',
      source: 'running-qingtian-mcp',
      observedAt: 123,
      workspace: {
        id: workspaceIdentityOf(data.projectA).id,
        path: realpathSync(data.projectA),
        cursorWorkspaceId: data.cursorA,
        channelIds: ['1', '2', '4']
      }
    })
  })

  it('refuses to guess when qtwx MCP is running in multiple Cursor windows', () => {
    const data = fixture()
    const detector = new CursorWorkspaceDetector({
      globalStateDatabase: data.databasePath,
      workspaceStorageRoot: data.storage,
      listProcesses: () => [
        runtimeProcess(data.storage, data.cursorA),
        runtimeProcess(data.storage, data.cursorB)
      ].join('\n')
    })
    const detection = detector.detect()
    expect(detection.state).toBe('ambiguous')
    expect(detection.confidence).toBe('none')
    expect(detection.candidates).toHaveLength(2)
  })

  it('uses Cursor recent state only as a non-automatic fallback', () => {
    const data = fixture()
    const detector = new CursorWorkspaceDetector({
      globalStateDatabase: data.databasePath,
      workspaceStorageRoot: data.storage,
      listProcesses: () => '/Applications/Cursor.app/Contents/MacOS/Cursor'
    })
    expect(detector.detect()).toMatchObject({
      state: 'detected',
      confidence: 'likely',
      source: 'cursor-recent',
      workspace: { id: workspaceIdentityOf(data.projectA).id }
    })
  })
})

describe('workspace auto-follow policy', () => {
  const detection = (confidence: 'certain' | 'likely') => ({
    state: 'detected' as const,
    source: confidence === 'certain' ? 'running-qingtian-mcp' as const : 'cursor-recent' as const,
    confidence,
    workspace: { id: 'new', name: 'new', path: '/new', channelIds: ['1'] },
    candidates: [],
    detail: '',
    observedAt: 1
  })

  it('follows a unique live workspace when the old run is not active', () => {
    expect(shouldAutoFollowCursorWorkspace({
      detection: detection('certain'),
      activeWorkspaceId: 'old',
      activeRunStatus: 'completed'
    })).toBe(true)
  })

  it('does not silently abandon a running team or trust recent-only evidence', () => {
    expect(shouldAutoFollowCursorWorkspace({
      detection: detection('certain'),
      activeWorkspaceId: 'old',
      activeRunStatus: 'running'
    })).toBe(false)
    expect(shouldAutoFollowCursorWorkspace({
      detection: detection('likely'),
      activeWorkspaceId: 'old',
      activeRunStatus: 'completed'
    })).toBe(false)
  })
})
