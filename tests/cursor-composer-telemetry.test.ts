import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { cursorComposerBindingMarker } from '../src/domain/cursor-telemetry'
import type { RuntimeBinding } from '../src/domain/team-control'
import { CursorComposerTelemetryReader } from '../src/infrastructure/cursor/cursor-composer-telemetry'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qingtian-cursor-telemetry-'))
  const workspace = join(root, 'workspace')
  const projectsRoot = join(root, 'projects')
  const workspaceStorageRoot = join(root, 'workspace-storage')
  const globalStateDatabase = join(root, 'state.vscdb')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(projectsRoot, { recursive: true })
  mkdirSync(workspaceStorageRoot, { recursive: true })
  return {
    root,
    workspace,
    projectsRoot,
    workspaceStorageRoot,
    globalStateDatabase,
    reader: new CursorComposerTelemetryReader({ globalStateDatabase, projectsRoot, workspaceStorageRoot })
  }
}

function header(input: {
  composerId: string
  workspace: string
  title?: string
  lastUpdatedAt?: number
  contextUsagePercent?: number
  contextTokensUsed?: number
  contextTokenLimit?: number
  additions?: number
  deletions?: number
  files?: number
  workspaceStorageId?: string
  status?: string
  abortReason?: string
  generatingBubbleIds?: string[]
}) {
  return {
    composerId: input.composerId,
    name: input.title ?? '测试会话',
    createdAt: 1_000,
    lastUpdatedAt: input.lastUpdatedAt ?? 2_000,
    contextUsagePercent: input.contextUsagePercent,
    contextTokensUsed: input.contextTokensUsed,
    contextTokenLimit: input.contextTokenLimit,
    totalLinesAdded: input.additions,
    totalLinesRemoved: input.deletions,
    filesChangedCount: input.files,
    status: input.status,
    abortReason: input.abortReason,
    generatingBubbleIds: input.generatingBubbleIds,
    workspaceIdentifier: {
      id: input.workspaceStorageId,
      uri: { fsPath: input.workspace }
    }
  }
}

function writeHeaders(path: string, headers: unknown[]): void {
  const database = new DatabaseSync(path)
  try {
    database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
    database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'composer.composerHeaders',
      JSON.stringify({ allComposers: headers })
    )
  } finally {
    database.close()
  }
}

function writeApplicationUser(path: string, value: unknown, raw = false): void {
  const database = new DatabaseSync(path)
  try {
    database.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
      'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser',
      raw ? String(value) : JSON.stringify(value)
    )
  } finally {
    database.close()
  }
}

function composerApplicationUser(): unknown {
  return {
    availableDefaultModels2: [{
      name: 'composer-2.5',
      clientDisplayName: 'Composer 2.5',
      inputboxShortModelName: 'Composer 2.5',
      supportsMaxMode: true,
      supportsNonMaxMode: true,
      contextTokenLimit: 200_000,
      contextTokenLimitForMaxMode: 200_000,
      parameterDefinitions: [{
        id: 'fast',
        name: 'Fast',
        parameterType: {
          booleanParameter: {
              values: [{ value: 'false' }, { value: 'true', displayName: 'Fast', increasesModelCost: true }]
          }
        }
      }],
      variants: [{
        parameterValues: [{ id: 'fast', value: 'true' }],
        isMaxMode: false
      }]
    }],
    aiSettings: {
      modelConfig: {
        composer: {
          modelName: 'composer-2.5',
          selectedModels: [{
            modelId: 'composer-2.5',
            parameters: [{ id: 'fast', value: 'true' }]
          }]
        }
      }
    }
  }
}

function parameterizedComposerApplicationUser(): unknown {
  return {
    availableDefaultModels2: [{
      name: 'claude-fable-5',
      supportsMaxMode: true,
      supportsNonMaxMode: true,
      contextTokenLimit: 300_000,
      contextTokenLimitForMaxMode: 1_000_000,
      clientDisplayName: 'Claude Fable 5',
      inputboxShortModelName: 'Claude Fable 5',
      parameterDefinitions: [
        {
          id: 'thinking',
          name: 'Thinking',
          parameterType: {
            booleanParameter: { values: [{ value: 'false' }, { value: 'true' }] }
          }
        },
        {
          id: 'context',
          name: 'Context',
          parameterType: {
            enumParameter: {
              values: [
                { value: '300k', displayName: '300K' },
                { value: '1m', displayName: '1M' }
              ]
            }
          }
        },
        {
          id: 'effort',
          name: 'Effort',
          parameterType: {
            enumParameter: {
              values: [{ value: 'max', displayName: 'Max' }]
            }
          }
        }
      ],
      variants: [{
        parameterValues: [
          { id: 'thinking', value: 'true' },
          { id: 'context', value: '1m' },
          { id: 'effort', value: 'max' }
        ],
        isMaxMode: false
      }]
    }],
    aiSettings: {
      modelConfig: {
        composer: {
          maxMode: true,
          selectedModels: [{
            modelId: 'claude-fable-5',
            parameters: [
              { id: 'thinking', value: 'true' },
              { id: 'context', value: '1m' },
              { id: 'effort', value: 'max' }
            ]
          }]
        }
      }
    }
  }
}

function kimiApplicationUser(maxMode: boolean): unknown {
  return {
    availableDefaultModels2: [{
      name: 'kimi-k3',
      clientDisplayName: 'Kimi K3',
      inputboxShortModelName: 'Kimi K3',
      supportsMaxMode: true,
      supportsNonMaxMode: true,
      contextTokenLimit: 1_048_576,
      contextTokenLimitForMaxMode: 1_048_576,
      parameterDefinitions: [{
        id: 'reasoning', name: 'Reasoning',
        parameterType: { enumParameter: { values: [{ value: 'max', displayName: 'Max' }] } }
      }],
      variants: [{ parameterValues: [{ id: 'reasoning', value: 'max' }], isMaxMode: false }]
    }],
    aiSettings: {
      modelConfig: {
        composer: {
          modelName: 'kimi-k3',
          maxMode,
          selectedModels: [{
            modelId: 'kimi-k3',
            parameters: [{ id: 'reasoning', value: 'max' }]
          }]
        }
      }
    }
  }
}

function transcriptDirectoryName(workspace: string): string {
  return normalize(workspace).replace(/^[/\\]+/, '').replace(/[:/\\]+/g, '-')
}

function writeTranscript(projectsRoot: string, workspace: string, composerId: string, text: string): void {
  const directory = join(
    projectsRoot,
    transcriptDirectoryName(workspace),
    'agent-transcripts',
    composerId
  )
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `${composerId}.jsonl`), text)
}

function transcriptEntry(server: string, toolName: string): string {
  return JSON.stringify({
    role: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        name: 'CallMcpTool',
        input: { server, toolName, arguments: {} }
      }]
    }
  })
}

function dynamicTranscriptEntry(namespace: string, toolName: string, name = 'CallDynamicTool'): string {
  return JSON.stringify({
    role: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        name,
        input: { namespace, toolName, arguments: {} }
      }]
    }
  })
}

function writeRuntimeState(input: {
  workspaceStorageRoot: string
  storageId: string
  channelId: string
  now: number
  heartbeatPid: number
  connectionPid: number
  waitingPid?: number
}): void {
  const root = join(
    input.workspaceStorageRoot,
    input.storageId,
    'QingTian.qingtian-v2',
    'runtime',
    'messages',
    's',
    input.channelId
  )
  mkdirSync(root, { recursive: true })
  const state = (pid: number, active = true) => ({
    channelId: input.channelId,
    pid,
    runtimeStamp: 'runtime-a',
    active,
    updatedAt: input.now
  })
  writeFileSync(join(root, 'heartbeat.json'), JSON.stringify({
    ...state(input.heartbeatPid),
    lastSeen: input.now
  }))
  writeFileSync(join(root, 'connection.json'), JSON.stringify(state(input.connectionPid)))
  writeFileSync(join(root, 'waiting.json'), JSON.stringify(state(input.waitingPid ?? input.connectionPid)))
}

function writeLeaseFiles(input: {
  workspaceStorageRoot: string
  storageId: string
  channelId: string
  pid: number
  heartbeatLastSeen: number
  connectionUpdatedAt: number
  waitingUpdatedAt: number
}): void {
  const root = join(
    input.workspaceStorageRoot,
    input.storageId,
    'QingTian.qingtian-v2',
    'runtime',
    'messages',
    's',
    input.channelId
  )
  mkdirSync(root, { recursive: true })
  const base = { channelId: input.channelId, pid: input.pid, runtimeStamp: 'runtime-a', active: true }
  writeFileSync(join(root, 'heartbeat.json'), JSON.stringify({ ...base, lastSeen: input.heartbeatLastSeen }))
  writeFileSync(join(root, 'connection.json'), JSON.stringify({ ...base, updatedAt: input.connectionUpdatedAt }))
  writeFileSync(join(root, 'waiting.json'), JSON.stringify({ ...base, updatedAt: input.waitingUpdatedAt }))
}

function transcriptPath(projectsRoot: string, workspace: string, composerId: string): string {
  return join(
    projectsRoot,
    transcriptDirectoryName(workspace),
    'agent-transcripts',
    composerId,
    `${composerId}.jsonl`
  )
}

function backdateTranscript(projectsRoot: string, workspace: string, composerId: string, ageMs: number): void {
  const path = transcriptPath(projectsRoot, workspace, composerId)
  const mtime = new Date(Date.now() - ageMs)
  utimesSync(path, mtime, mtime)
}

function binding(channelId: string, generation = 'generation123', installedAt = 1_500): RuntimeBinding {
  return {
    id: `binding-${channelId}`,
    workspaceId: 'workspace-a',
    runId: 'run-a',
    slotId: `slot-${channelId}`,
    channelId,
    agentSessionId: `agent-${channelId}`,
    generation,
    composerBindingKey: generation,
    installedAt,
    launchStatus: 'not_started',
    launchDetail: '',
    lastCheckInNote: ''
  }
}

describe('CursorComposerTelemetryReader', () => {
  it('uses persisted aborted status as immediate offline evidence when CDP is unavailable', () => {
    const data = fixture()
    const composerId = 'composer-persisted-abort-123'
    writeHeaders(data.globalStateDatabase, [header({
      composerId,
      workspace: data.workspace,
      status: 'aborted',
      abortReason: 'error'
    })])
    const runtime = { ...binding('1'), composerId }

    const snapshot = data.reader.readWorkspace(data.workspace, [runtime])

    expect(snapshot.composers[0]?.activity).toMatchObject({
      state: 'stopped',
      channelId: '1'
    })
    expect(snapshot.composers[0]?.activity?.detail).toContain('持久状态')
  })

  it('uses persisted generating bubbles as positive activity evidence', () => {
    const data = fixture()
    const composerId = 'composer-persisted-running-123'
    writeHeaders(data.globalStateDatabase, [header({
      composerId,
      workspace: data.workspace,
      generatingBubbleIds: ['bubble-running']
    })])
    const runtime = { ...binding('1'), composerId }

    const snapshot = data.reader.readWorkspace(data.workspace, [runtime])

    expect(snapshot.composers[0]?.activity).toMatchObject({ state: 'active', channelId: '1' })
  })

  it('reads Cursor current Composer profile without pretending it belongs to a historical session', () => {
    const data = fixture()
    writeHeaders(data.globalStateDatabase, [header({
      composerId: 'composer-profile-123',
      workspace: data.workspace
    })])
    writeApplicationUser(data.globalStateDatabase, composerApplicationUser())

    const snapshot = data.reader.readWorkspace(data.workspace, [])

    expect(snapshot.composerProfile).toEqual({
      scope: 'cursor-composer-current',
      modelId: 'composer-2.5',
      displayName: 'Composer 2.5',
      options: ['Fast'],
      maxMode: false,
      contextTokenLimit: 200_000
    })
    expect(snapshot.cursorModels?.[0]).toMatchObject({
      modelId: 'composer-2.5',
      displayName: 'Composer 2.5',
      parameters: [{ id: 'fast', value: 'true' }],
      selected: true,
      optionLabels: ['Fast'],
      parameterDefinitions: [{
        id: 'fast',
        displayName: 'Fast',
        kind: 'boolean',
        values: [
          { value: 'false', displayName: 'Off', increasesCost: false },
          { value: 'true', displayName: 'Fast', increasesCost: true }
        ]
      }],
      supportsMaxMode: true,
      supportsNonMaxMode: true,
      contextTokenLimit: 200_000,
      contextTokenLimitForMaxMode: 200_000
    })
    expect(snapshot.composers[0]?.modelName).toBeUndefined()
  })

  it('shows selected enum values instead of redundant Context and Effort labels', () => {
    const data = fixture()
    writeHeaders(data.globalStateDatabase, [header({
      composerId: 'composer-profile-123',
      workspace: data.workspace
    })])
    writeApplicationUser(data.globalStateDatabase, parameterizedComposerApplicationUser())

    const snapshot = data.reader.readWorkspace(data.workspace, [])

    expect(snapshot.composerProfile).toEqual({
      scope: 'cursor-composer-current',
      modelId: 'claude-fable-5',
      displayName: 'Claude Fable 5',
      options: ['Think', '1M', 'Max'],
      maxMode: true,
      contextTokenLimit: 1_000_000
    })
    expect(snapshot.cursorModels?.[0]).toMatchObject({
      modelId: 'claude-fable-5',
      selected: true,
      parameters: [
        { id: 'thinking', value: 'true' },
        { id: 'context', value: '1m' },
        { id: 'effort', value: 'max' }
      ],
      optionLabels: ['Think', '1M', 'Max'],
      supportsMaxMode: true,
      supportsNonMaxMode: true,
      contextTokenLimitForMaxMode: 1_000_000
    })
    expect(snapshot.cursorModels?.[0]?.parameterDefinitions.map((definition) => definition.id)).toEqual([
      'thinking', 'context', 'effort'
    ])
    expect(snapshot.cursorModels?.[0]?.variants).toEqual([{
      parameters: [
        { id: 'thinking', value: 'true' },
        { id: 'context', value: '1m' },
        { id: 'effort', value: 'max' }
      ],
      maxMode: false,
      isDefaultMaxConfig: undefined,
      isDefaultNonMaxConfig: undefined
    }])
    expect(snapshot.cursorModels?.[0]?.parameterDefinitions).toMatchObject([
      {
        displayName: 'Thinking',
        values: [
          { value: 'false', displayName: 'Off' },
          { value: 'true', displayName: 'On' }
        ]
      },
      {
        displayName: 'Context',
        values: [
          { value: '300k', displayName: '300K' },
          { value: '1m', displayName: '1M' }
        ]
      },
      {
        displayName: 'Effort',
        values: [{ value: 'max', displayName: 'Max' }]
      }
    ])
  })

  it('treats Kimi reasoning=max and MAX Mode as independent controls', () => {
    const standard = fixture()
    writeHeaders(standard.globalStateDatabase, [header({
      composerId: 'composer-kimi-standard', workspace: standard.workspace
    })])
    writeApplicationUser(standard.globalStateDatabase, kimiApplicationUser(false))
    const standardSnapshot = standard.reader.readWorkspace(standard.workspace, [])
    expect(standardSnapshot.composerProfile).toMatchObject({
      modelId: 'kimi-k3',
      options: ['Think', 'Max'],
      maxMode: false,
      contextTokenLimit: 200_000
    })
    expect(standardSnapshot.cursorModels?.[0]).toMatchObject({
      supportsMaxMode: true,
      contextTokenLimit: 1_048_576,
      contextTokenLimitForMaxMode: 1_048_576
    })

    const max = fixture()
    writeHeaders(max.globalStateDatabase, [header({
      composerId: 'composer-kimi-max', workspace: max.workspace
    })])
    writeApplicationUser(max.globalStateDatabase, kimiApplicationUser(true))
    expect(max.reader.readWorkspace(max.workspace, []).composerProfile).toMatchObject({
      modelId: 'kimi-k3',
      maxMode: true,
      contextTokenLimit: 1_048_576
    })
  })

  it('reads per-composer modelConfig from composerData so each session shows its own profile', () => {
    const data = fixture()
    const composerId = 'composer-per-session-1'
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
    writeApplicationUser(data.globalStateDatabase, kimiApplicationUser(false))
    const database = new DatabaseSync(data.globalStateDatabase)
    try {
      database.exec('CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)')
      database.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
        `composerData:${composerId}`,
        JSON.stringify({
          _v: 16,
          composerId,
          modelConfig: {
            modelName: 'kimi-k3',
            maxMode: true,
            selectedModels: [{ modelId: 'kimi-k3', parameters: [{ id: 'reasoning', value: 'max' }] }]
          }
        })
      )
    } finally {
      database.close()
    }

    const snapshot = data.reader.readWorkspace(data.workspace, [])
    expect(snapshot.composers[0]?.modelProfile).toMatchObject({
      modelId: 'kimi-k3',
      displayName: 'Kimi K3',
      options: ['Think', 'Max'],
      maxMode: true,
      contextTokenLimit: 1_048_576
    })
  })

  it('keeps session telemetry available when Cursor current profile is malformed', () => {
    const data = fixture()
    writeHeaders(data.globalStateDatabase, [header({
      composerId: 'composer-profile-123',
      workspace: data.workspace
    })])
    writeApplicationUser(data.globalStateDatabase, '{broken json', true)

    const snapshot = data.reader.readWorkspace(data.workspace, [])

    expect(snapshot.availability).toBe('available')
    expect(snapshot.composers).toHaveLength(1)
    expect(snapshot.composerProfile).toBeUndefined()
  })

  it('filters to the exact workspace and binds real metrics through the deterministic launch marker', () => {
    const data = fixture()
    const composerId = 'composer-alpha-123'
    const runtime = binding('2')
    writeHeaders(data.globalStateDatabase, [
      header({
        composerId,
        workspace: data.workspace,
        title: '实现\n监控卡',
        contextUsagePercent: 63.3,
        additions: 275,
        deletions: 17,
        files: 10
      }),
      header({
        composerId: 'composer-other-123',
        workspace: join(data.root, 'other-workspace'),
        contextUsagePercent: 99
      })
    ])
    writeTranscript(
      data.projectsRoot,
      data.workspace,
      composerId,
      `${cursorComposerBindingMarker({ bindingKey: runtime.composerBindingKey, channelId: runtime.channelId })}\n${'x'.repeat(1_100_000)}`
    )

    const snapshot = data.reader.readWorkspace(data.workspace, [runtime])

    expect(snapshot.availability).toBe('available')
    expect(snapshot.composers).toHaveLength(1)
    expect(snapshot.composers[0]).toMatchObject({
      composerId,
      title: '实现 监控卡',
      contextUsage: { ratio: 0.633 },
      changes: { additions: 275, deletions: 17, files: 10 }
    })
    expect(snapshot.composers[0]?.modelName).toBeUndefined()
    expect(snapshot.bindingCandidates).toEqual([{
      channelId: '2',
      composerId,
      generation: 'generation123',
      bindingKey: 'generation123',
      method: 'launch_marker'
    }])
  })

  it('does not collect per-composer token estimates from transcripts', () => {
    const data = fixture()
    const composerId = 'composer-no-token-usage-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace, contextUsagePercent: 10 })])
    writeApplicationUser(data.globalStateDatabase, composerApplicationUser())
    const userLine = JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '实现一个测试' }] } })
    const assistantLine = JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '已经完成实现' }] } })
    writeTranscript(data.projectsRoot, data.workspace, composerId, `${userLine}\n${assistantLine}\n`)

    const first = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]!
    expect('tokenUsage' in first).toBe(false)

    const transcriptPath = join(
      data.projectsRoot, transcriptDirectoryName(data.workspace), 'agent-transcripts', composerId, `${composerId}.jsonl`
    )
    appendFileSync(transcriptPath, `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '补充一条回复' }] } })}\n`)
    const second = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]!
    expect('tokenUsage' in second).toBe(false)
  })

  it('reads Cursor native promptTokenBreakdown for the context hover panel', () => {
    const data = fixture()
    const composerId = 'composer-native-context-breakdown'
    const breakdown = {
      totalUsedTokens: 18_900,
      maxTokens: 200_000,
      categories: [
        { id: 'system_prompt', label: 'System prompt', estimatedTokens: 488 },
        { id: 'tools', label: 'Tool definitions', estimatedTokens: 7_700 },
        { id: 'rules', label: 'Rules', estimatedTokens: 3_800 },
        { id: 'conversation', label: 'Conversation', estimatedTokens: 217 }
      ]
    }
    writeHeaders(data.globalStateDatabase, [header({
      composerId,
      workspace: data.workspace,
      contextUsagePercent: 9.45
    })])
    const database = new DatabaseSync(data.globalStateDatabase)
    try {
      database.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)')
      database.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
        `composerData:${composerId}`,
        JSON.stringify({
          composerId,
          contextUsagePercent: 9.45,
          contextTokensUsed: 18_900,
          contextTokenLimit: 200_000,
          promptTokenBreakdown: breakdown
        })
      )
    } finally {
      database.close()
    }

    const composer = data.reader.readWorkspace(data.workspace, []).composers[0]
    expect(composer?.contextUsage).toMatchObject({
      used: 18_900,
      limit: 200_000,
      breakdown
    })
    expect(composer?.contextUsage?.ratio).toBeCloseTo(0.0945)
  })












  it('keeps context usage without fabricating a token estimate before Cursor creates a transcript file', () => {
    const data = fixture()
    const composerId = 'composer-context-only-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({
      composerId,
      workspace: data.workspace,
      contextUsagePercent: 10.8,
      lastUpdatedAt: 8_000
    })])
    writeApplicationUser(data.globalStateDatabase, composerApplicationUser())

    const composer = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]

    expect(composer?.contextUsage?.ratio).toBeCloseTo(0.108)
    expect('tokenUsage' in (composer ?? {})).toBe(false)
  })

  it('refuses an ambiguous transcript instead of assigning it by channel order', () => {
    const data = fixture()
    const composerId = 'composer-shared-123'
    const first = binding('1')
    const second = binding('2')
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
    writeTranscript(
      data.projectsRoot,
      data.workspace,
      composerId,
      `${cursorComposerBindingMarker({ bindingKey: first.composerBindingKey, channelId: first.channelId })}\n${cursorComposerBindingMarker({ bindingKey: second.composerBindingKey, channelId: second.channelId })}`
    )

    const snapshot = data.reader.readWorkspace(data.workspace, [first, second])

    expect(snapshot.bindingCandidates).toEqual([])
  })

  it('uses the legacy channel hint only when it is recent and globally unique', () => {
    const data = fixture()
    writeHeaders(data.globalStateDatabase, [
      header({ composerId: 'composer-recent-123', workspace: data.workspace, lastUpdatedAt: 10_000 }),
      header({ composerId: 'composer-stale-123', workspace: data.workspace, lastUpdatedAt: 1 })
    ])
    writeTranscript(data.projectsRoot, data.workspace, 'composer-recent-123', 'using qtwx-mcp-3 now')
    writeTranscript(data.projectsRoot, data.workspace, 'composer-stale-123', 'using qtwx-mcp-4 now')

    const snapshot = data.reader.readWorkspace(data.workspace, [
      binding('3', 'generation123', 9_000),
      binding('4', 'generation123', 1_000_000)
    ])

    expect(snapshot.bindingCandidates).toEqual([{
      channelId: '3',
      composerId: 'composer-recent-123',
      generation: 'generation123',
      bindingKey: 'generation123',
      method: 'channel_marker'
    }])
  })

  it('verifies waiting only when the bound Composer and current MCP process own the same lease', () => {
    const data = fixture()
    const now = 2_000_000
    const storageId = 'a'.repeat(32)
    const composerId = 'composer-waiting-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({
      composerId,
      workspace: data.workspace,
      workspaceStorageId: storageId
    })])
    writeTranscript(
      data.projectsRoot,
      data.workspace,
      composerId,
      transcriptEntry('project-alpha-qtwx-mcp-1', 'check_messages')
    )
    writeRuntimeState({
      workspaceStorageRoot: data.workspaceStorageRoot,
      storageId,
      channelId: '1',
      now,
      heartbeatPid: 4321,
      connectionPid: 4321
    })
    const reader = new CursorComposerTelemetryReader({
      globalStateDatabase: data.globalStateDatabase,
      projectsRoot: data.projectsRoot,
      workspaceStorageRoot: data.workspaceStorageRoot,
      now: () => now,
      isProcessAlive: (pid) => pid === 4321
    })

    const snapshot = reader.readWorkspace(data.workspace, [runtime])

    expect(snapshot.composers[0]?.activity).toMatchObject({
      state: 'waiting',
      channelId: '1'
    })
  })

  it('rejects a stale waiting lease owned by a previous MCP process', () => {
    const data = fixture()
    const now = 2_000_000
    const storageId = 'b'.repeat(32)
    const composerId = 'composer-stale-wait-123'
    const runtime = { ...binding('2'), composerId }
    writeHeaders(data.globalStateDatabase, [header({
      composerId,
      workspace: data.workspace,
      workspaceStorageId: storageId
    })])
    writeTranscript(
      data.projectsRoot,
      data.workspace,
      composerId,
      transcriptEntry('project-alpha-qtwx-mcp-2', 'check_messages')
    )
    writeRuntimeState({
      workspaceStorageRoot: data.workspaceStorageRoot,
      storageId,
      channelId: '2',
      now,
      heartbeatPid: 9002,
      connectionPid: 8002
    })
    const reader = new CursorComposerTelemetryReader({
      globalStateDatabase: data.globalStateDatabase,
      projectsRoot: data.projectsRoot,
      workspaceStorageRoot: data.workspaceStorageRoot,
      now: () => now,
      isProcessAlive: (pid) => pid === 9002
    })

    const snapshot = reader.readWorkspace(data.workspace, [runtime])

    expect(snapshot.composers[0]?.activity).toMatchObject({
      state: 'stopped',
      channelId: '2'
    })
    expect(snapshot.composers[0]?.activity?.detail).toContain('旧运行时')
  })

  it('marks record_reply without a following check_messages as stopped once activity goes stale', () => {
    const data = fixture()
    const now = Date.now()
    const storageId = 'c'.repeat(32)
    const composerId = 'composer-quota-stop-123'
    const runtime = { ...binding('3'), composerId }
    writeHeaders(data.globalStateDatabase, [header({
      composerId,
      workspace: data.workspace,
      workspaceStorageId: storageId,
      lastUpdatedAt: now - 120_000
    })])
    writeTranscript(
      data.projectsRoot,
      data.workspace,
      composerId,
      transcriptEntry('project-alpha-qtwx-mcp-3', 'record_reply')
    )
    // 转录与 composer 双双陈旧：record_reply 收尾后长时间没有回到 check_messages = 真停止
    backdateTranscript(data.projectsRoot, data.workspace, composerId, 120_000)
    writeRuntimeState({
      workspaceStorageRoot: data.workspaceStorageRoot,
      storageId,
      channelId: '3',
      now,
      heartbeatPid: 4303,
      connectionPid: 4303
    })
    const reader = new CursorComposerTelemetryReader({
      globalStateDatabase: data.globalStateDatabase,
      projectsRoot: data.projectsRoot,
      workspaceStorageRoot: data.workspaceStorageRoot,
      now: () => now,
      isProcessAlive: (pid) => pid === 4303
    })

    const snapshot = reader.readWorkspace(data.workspace, [runtime])

    expect(snapshot.composers[0]?.activity).toMatchObject({
      state: 'stopped',
      channelId: '3'
    })
    expect(snapshot.composers[0]?.activity?.detail).toContain('未再次进入 check_messages')
  })

  it('treats a fresh record_reply as entering the next listen round, not as stopped', () => {
    const data = fixture()
    const now = Date.now()
    const storageId = 'g'.repeat(32)
    const composerId = 'composer-reply-flush-window'
    const runtime = { ...binding('3'), composerId }
    writeHeaders(data.globalStateDatabase, [header({
      composerId,
      workspace: data.workspace,
      workspaceStorageId: storageId,
      lastUpdatedAt: now
    })])
    // 转录刚落盘（新鲜）：record_reply 与紧随的 check_messages 之间存在 flush 窗口，
    // 协议强制同步后立刻回到监听——窗口内不得判 stopped
    writeTranscript(
      data.projectsRoot,
      data.workspace,
      composerId,
      transcriptEntry('project-alpha-qtwx-mcp-3', 'record_reply')
    )
    writeRuntimeState({
      workspaceStorageRoot: data.workspaceStorageRoot,
      storageId,
      channelId: '3',
      now,
      heartbeatPid: 4303,
      connectionPid: 4303
    })
    const reader = new CursorComposerTelemetryReader({
      globalStateDatabase: data.globalStateDatabase,
      projectsRoot: data.projectsRoot,
      workspaceStorageRoot: data.workspaceStorageRoot,
      now: () => now,
      isProcessAlive: (pid) => pid === 4303
    })

    const snapshot = reader.readWorkspace(data.workspace, [runtime])

    expect(snapshot.composers[0]?.activity).toMatchObject({ state: 'active', channelId: '3' })
    expect(snapshot.composers[0]?.activity?.detail).toContain('下一轮监听')
  })

  it('recognizes current Cursor CallDynamicTool records and ignores tool discovery entries', () => {
    const data = fixture()
    const now = Date.now()
    const storageId = 'd'.repeat(32)
    const composerId = 'composer-dynamic-stop-123'
    const runtime = { ...binding('4'), composerId }
    writeHeaders(data.globalStateDatabase, [header({
      composerId,
      workspace: data.workspace,
      workspaceStorageId: storageId,
      lastUpdatedAt: now - 120_000
    })])
    writeTranscript(
      data.projectsRoot,
      data.workspace,
      composerId,
      [
        dynamicTranscriptEntry('project-alpha-qtwx-mcp-4', 'record_reply'),
        dynamicTranscriptEntry('project-alpha-qtwx-mcp-4', 'check_messages', 'GetDynamicTools')
      ].join('\n')
    )
    // 陈旧化：GetDynamicTools 被跳过后最后动作是 record_reply，且长时间未回到监听
    backdateTranscript(data.projectsRoot, data.workspace, composerId, 120_000)
    writeRuntimeState({
      workspaceStorageRoot: data.workspaceStorageRoot,
      storageId,
      channelId: '4',
      now,
      heartbeatPid: 4304,
      connectionPid: 4304
    })
    const reader = new CursorComposerTelemetryReader({
      globalStateDatabase: data.globalStateDatabase,
      projectsRoot: data.projectsRoot,
      workspaceStorageRoot: data.workspaceStorageRoot,
      now: () => now,
      isProcessAlive: (pid) => pid === 4304
    })

    const snapshot = reader.readWorkspace(data.workspace, [runtime])

    expect(snapshot.composers[0]?.activity).toMatchObject({
      state: 'stopped',
      channelId: '4'
    })
  })

  it('extracts the channel id from unified qunshu server arguments (channel_id param)', () => {
    const data = fixture()
    const now = Date.now()
    const composerId = 'composer-qunshu-channel-args'
    const runtime = { ...binding('2'), composerId }
    writeHeaders(data.globalStateDatabase, [header({
      composerId,
      workspace: data.workspace,
      lastUpdatedAt: now
    })])
    // 统一服务器形态：namespace 是 qunshu（不含通道号），通道身份在 arguments.channel_id
    writeTranscript(
      data.projectsRoot,
      data.workspace,
      composerId,
      `${JSON.stringify({
        role: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'CallDynamicTool',
            input: { namespace: 'user-qunshu', toolName: 'check_messages', arguments: { channel_id: '2' } }
          }]
        }
      })}\n`
    )
    const reader = new CursorComposerTelemetryReader({
      globalStateDatabase: data.globalStateDatabase,
      projectsRoot: data.projectsRoot,
      workspaceStorageRoot: data.workspaceStorageRoot,
      now: () => now,
      isProcessAlive: () => true
    })

    const snapshot = reader.readWorkspace(data.workspace, [runtime])

    // 通道归属正确识别；无插件租约文件（内嵌模式）时按 waiting 投影
    expect(snapshot.composers[0]?.activity).toMatchObject({ state: 'waiting', channelId: '2' })
  })

  it('keeps a busy agent active: long-poll ended for work (stale connection lease is not death)', () => {
    const data = fixture()
    const now = Date.now()
    const storageId = 'e'.repeat(32)
    const composerId = 'composer-busy-thinking-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace, workspaceStorageId: storageId })])
    writeTranscript(data.projectsRoot, data.workspace, composerId, transcriptEntry('project-alpha-qtwx-mcp-1', 'check_messages'))
    // 心跳新鲜、身份一致；连接/等待租约仅时间陈旧（Agent 接到活后没再碰 MCP）
    writeLeaseFiles({
      workspaceStorageRoot: data.workspaceStorageRoot,
      storageId,
      channelId: '1',
      pid: 7001,
      heartbeatLastSeen: now,
      connectionUpdatedAt: now - 60_000,
      waitingUpdatedAt: now - 60_000
    })
    const reader = new CursorComposerTelemetryReader({
      globalStateDatabase: data.globalStateDatabase,
      projectsRoot: data.projectsRoot,
      workspaceStorageRoot: data.workspaceStorageRoot,
      now: () => now,
      isProcessAlive: () => true
    })
    const snapshot = reader.readWorkspace(data.workspace, [runtime])
    expect(snapshot.composers[0]?.activity).toMatchObject({ state: 'active', channelId: '1' })
    expect(snapshot.composers[0]?.activity?.detail).toContain('正在处理')
  })

  it('keeps a working agent active on tool action despite a time-stale connection lease', () => {
    const data = fixture()
    const now = Date.now()
    const storageId = 'f'.repeat(32)
    const composerId = 'composer-busy-tool-123'
    const runtime = { ...binding('2'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace, workspaceStorageId: storageId })])
    writeTranscript(data.projectsRoot, data.workspace, composerId, transcriptEntry('project-alpha-qtwx-mcp-2', 'run_command'))
    writeLeaseFiles({
      workspaceStorageRoot: data.workspaceStorageRoot,
      storageId,
      channelId: '2',
      pid: 7002,
      heartbeatLastSeen: now,
      connectionUpdatedAt: now - 90_000,
      waitingUpdatedAt: now - 90_000
    })
    const reader = new CursorComposerTelemetryReader({
      globalStateDatabase: data.globalStateDatabase,
      projectsRoot: data.projectsRoot,
      workspaceStorageRoot: data.workspaceStorageRoot,
      now: () => now,
      isProcessAlive: () => true
    })
    const snapshot = reader.readWorkspace(data.workspace, [runtime])
    expect(snapshot.composers[0]?.activity).toMatchObject({ state: 'active' })
    expect(snapshot.composers[0]?.activity?.detail).toContain('刚刚产生新的 Agent 活动')
  })

  it('marks long-task silence within work grace as workInProgress unknown, not stopped', () => {
    const data = fixture()
    const now = Date.now()
    const storageId = '0'.repeat(32)
    const composerId = 'composer-long-task-123'
    const runtime = { ...binding('3'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace, workspaceStorageId: storageId })])
    writeTranscript(data.projectsRoot, data.workspace, composerId, transcriptEntry('project-alpha-qtwx-mcp-3', 'run_command'))
    backdateTranscript(data.projectsRoot, data.workspace, composerId, 120_000)
    writeLeaseFiles({
      workspaceStorageRoot: data.workspaceStorageRoot,
      storageId,
      channelId: '3',
      pid: 7003,
      heartbeatLastSeen: now,
      connectionUpdatedAt: now - 150_000,
      waitingUpdatedAt: now - 150_000
    })
    const reader = new CursorComposerTelemetryReader({
      globalStateDatabase: data.globalStateDatabase,
      projectsRoot: data.projectsRoot,
      workspaceStorageRoot: data.workspaceStorageRoot,
      now: () => now,
      isProcessAlive: () => true
    })
    const snapshot = reader.readWorkspace(data.workspace, [runtime])
    expect(snapshot.composers[0]?.activity).toMatchObject({ state: 'unknown', workInProgress: true })
  })

  it('falls back to plain unknown beyond the work-activity grace window', () => {
    const data = fixture()
    const now = Date.now()
    const storageId = '9'.repeat(32)
    const composerId = 'composer-beyond-grace-123'
    const runtime = { ...binding('4'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace, workspaceStorageId: storageId })])
    writeTranscript(data.projectsRoot, data.workspace, composerId, transcriptEntry('project-alpha-qtwx-mcp-4', 'run_command'))
    backdateTranscript(data.projectsRoot, data.workspace, composerId, 601_000)
    writeLeaseFiles({
      workspaceStorageRoot: data.workspaceStorageRoot,
      storageId,
      channelId: '4',
      pid: 7004,
      heartbeatLastSeen: now,
      connectionUpdatedAt: now - 610_000,
      waitingUpdatedAt: now - 610_000
    })
    const reader = new CursorComposerTelemetryReader({
      globalStateDatabase: data.globalStateDatabase,
      projectsRoot: data.projectsRoot,
      workspaceStorageRoot: data.workspaceStorageRoot,
      now: () => now,
      isProcessAlive: () => true
    })
    const snapshot = reader.readWorkspace(data.workspace, [runtime])
    expect(snapshot.composers[0]?.activity?.state).toBe('unknown')
    expect(snapshot.composers[0]?.activity?.workInProgress).toBeUndefined()
  })

  it('does not call an Agent stopped merely because check_messages ended and the next work is quiet', () => {
    const data = fixture()
    const now = Date.now()
    const storageId = '8'.repeat(32)
    const composerId = 'composer-idle-death-123'
    const runtime = { ...binding('5'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace, workspaceStorageId: storageId })])
    writeTranscript(data.projectsRoot, data.workspace, composerId, transcriptEntry('project-alpha-qtwx-mcp-5', 'check_messages'))
    backdateTranscript(data.projectsRoot, data.workspace, composerId, 60_000)
    writeLeaseFiles({
      workspaceStorageRoot: data.workspaceStorageRoot,
      storageId,
      channelId: '5',
      pid: 7005,
      heartbeatLastSeen: now,
      connectionUpdatedAt: now - 60_000,
      waitingUpdatedAt: now - 60_000
    })
    const reader = new CursorComposerTelemetryReader({
      globalStateDatabase: data.globalStateDatabase,
      projectsRoot: data.projectsRoot,
      workspaceStorageRoot: data.workspaceStorageRoot,
      now: () => now,
      isProcessAlive: () => true
    })
    const snapshot = reader.readWorkspace(data.workspace, [runtime])
    expect(snapshot.composers[0]?.activity).toMatchObject({ state: 'unknown', workInProgress: true })
    expect(snapshot.composers[0]?.activity?.detail).toContain('可能正在执行长任务')
  })

  it('reports a missing Cursor database without throwing or fabricating data', () => {
    const data = fixture()
    const snapshot = data.reader.readWorkspace(data.workspace, [binding('1')])
    expect(snapshot).toMatchObject({
      availability: 'unavailable',
      composers: [],
      bindingCandidates: [],
      issue: '找不到 Cursor 本机会话数据库'
    })
  })
})

describe('transcript discovery beyond workspace-derived directories', () => {
  function writeTranscriptInDir(projectsRoot: string, directoryName: string, composerId: string, text: string): string {
    const directory = join(projectsRoot, directoryName, 'agent-transcripts', composerId)
    mkdirSync(directory, { recursive: true })
    const path = join(directory, `${composerId}.jsonl`)
    writeFileSync(path, text)
    return path
  }

  it('discovers transcripts in numeric timestamp project dirs (new Cursor naming) for activity', () => {
    const data = fixture()
    const composerId = 'composer-numeric-dir-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
    const userLine = JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '实现一个测试' }] } })
    writeTranscriptInDir(
      data.projectsRoot,
      '1779762671039',
      composerId,
      `${userLine}\n${transcriptEntry('qtwx-mcp-1', 'check_messages')}\n`
    )

    const composer = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]
    expect(composer?.activity).toMatchObject({ state: 'waiting', channelId: '1' })
  })

  it('prefers the newest transcript when the same composer appears in multiple project dirs', () => {
    const data = fixture()
    const composerId = 'composer-multi-dir-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
    const stale = writeTranscriptInDir(data.projectsRoot, '1779762671039', composerId, `${transcriptEntry('qtwx-mcp-1', 'record_reply')}\n`)
    const staleTime = new Date(Date.now() - 60 * 60_000)
    utimesSync(stale, staleTime, staleTime)
    writeTranscriptInDir(data.projectsRoot, '1780659222896', composerId, `${transcriptEntry('qtwx-mcp-1', 'check_messages')}\n`)

    const composer = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]
    expect(composer?.activity).toMatchObject({ state: 'waiting' })
  })
})

describe('channel-level transcript activity evidence', () => {
  function writeChannelTranscript(projectsRoot: string, composerId: string, text: string, ageMs = 0): void {
    const directory = join(projectsRoot, '1780659222896', 'agent-transcripts', composerId)
    mkdirSync(directory, { recursive: true })
    const path = join(directory, `${composerId}.jsonl`)
    writeFileSync(path, text)
    if (ageMs > 0) {
      const time = new Date(Date.now() - ageMs)
      utimesSync(path, time, time)
    }
  }

  it('marks a channel stopped when its newest transcript ends with record_reply and no longer grows', () => {
    const data = fixture()
    writeChannelTranscript(
      data.projectsRoot,
      'composer-ch2-ended-123',
      `${transcriptEntry('qtwx-mcp-2', 'check_messages')}\n${transcriptEntry('qtwx-mcp-2', 'record_reply')}\n`,
      2 * 60_000
    )

    const snapshot = data.reader.readWorkspace(data.workspace, [binding('2')])
    expect(snapshot.channelActivities?.['2']).toMatchObject({
      channelId: '2',
      state: 'stopped'
    })
    expect(snapshot.channelActivities?.['2']?.detail).toContain('停止监听')
  })

  it('marks a channel active while its transcript keeps growing', () => {
    const data = fixture()
    writeChannelTranscript(
      data.projectsRoot,
      'composer-ch3-live-123',
      `${transcriptEntry('qtwx-mcp-3', 'check_messages')}\n`
    )

    const snapshot = data.reader.readWorkspace(data.workspace, [binding('3')])
    expect(snapshot.channelActivities?.['3']).toMatchObject({ channelId: '3', state: 'active' })
  })

  it('marks a zombie polling channel stopped after the transcript stays silent beyond the hard cap', () => {
    const data = fixture()
    writeChannelTranscript(
      data.projectsRoot,
      'composer-ch1-zombie-123',
      `${transcriptEntry('qtwx-mcp-1', 'check_messages')}\n`,
      16 * 60_000
    )

    const snapshot = data.reader.readWorkspace(data.workspace, [binding('1')])
    expect(snapshot.channelActivities?.['1']).toMatchObject({ channelId: '1', state: 'stopped' })
    expect(snapshot.channelActivities?.['1']?.detail).toContain('僵尸')
  })

  it('keeps short transcript silence as unknown instead of fabricating death evidence', () => {
    const data = fixture()
    writeChannelTranscript(
      data.projectsRoot,
      'composer-ch1-paused-123',
      `${transcriptEntry('qtwx-mcp-1', 'check_messages')}\n`,
      45_000
    )

    const snapshot = data.reader.readWorkspace(data.workspace, [binding('1')])
    expect(snapshot.channelActivities?.['1']).toMatchObject({ channelId: '1', state: 'unknown' })
  })

  it('omits channels that never left any transcript trace', () => {
    const data = fixture()
    const snapshot = data.reader.readWorkspace(data.workspace, [binding('9')])
    expect(snapshot.channelActivities?.['9']).toBeUndefined()
  })
})

describe('global composer hydration for context and binding', () => {
  it('hydrates a cross-workspace composer located via channel transcript so context stays readable', () => {
    const data = fixture()
    const composerId = 'composer-temp-workspace-1'
    // composer 头部属于另一个工作区（临时目录）——会被工作区过滤
    writeHeaders(data.globalStateDatabase, [{
      ...header({
        composerId,
        workspace: '/tmp/qingtian-temp-workspace',
        contextUsagePercent: 53.7
      }),
      modelName: 'gpt-5.3-codex'
    }])
    const directory = join(data.projectsRoot, '1779762671039', 'agent-transcripts', composerId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `${composerId}.jsonl`), `${transcriptEntry('qtwx-mcp-2', 'check_messages')}\n`)

    const snapshot = data.reader.readWorkspace(data.workspace, [binding('2')])
    expect(snapshot.channelActivities?.['2']?.composerId).toBe(composerId)
    const composer = snapshot.composers.find((entry) => entry.composerId === composerId)
    expect(composer?.contextUsage?.ratio).toBeCloseTo(0.537, 3)
    expect(composer?.modelName).toBe('gpt-5.3-codex')
  })

  it('produces binding candidates from launch markers on cross-workspace composers', () => {
    const data = fixture()
    const composerId = 'composer-cross-ws-launch-1'
    writeHeaders(data.globalStateDatabase, [header({
      composerId,
      workspace: '/tmp/qingtian-temp-workspace'
    })])
    const runtime = binding('1')
    const marker = cursorComposerBindingMarker({ bindingKey: runtime.generation, channelId: '1' })
    const directory = join(data.projectsRoot, 'Users-example-Projects-BlockChainVecSim', 'agent-transcripts', composerId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `${composerId}.jsonl`), `${transcriptEntry(marker, 'check_messages')}\n`)

    const snapshot = data.reader.readWorkspace(data.workspace, [runtime])
    expect(snapshot.bindingCandidates).toEqual([
      expect.objectContaining({
        channelId: '1',
        composerId,
        generation: runtime.generation,
        method: 'launch_marker'
      })
    ])
  })

  it('still binds transcripts carrying the legacy QINGTIAN_TEAM_BIND marker after rebrand', () => {
    const data = fixture()
    const composerId = 'composer-legacy-marker-1'
    writeHeaders(data.globalStateDatabase, [header({
      composerId,
      workspace: '/tmp/qingtian-temp-workspace'
    })])
    const runtime = binding('1')
    const legacyMarker = `[[QINGTIAN_TEAM_BIND:${runtime.generation}:CH-1]]`
    const directory = join(data.projectsRoot, 'Users-example-Projects-BlockChainVecSim', 'agent-transcripts', composerId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `${composerId}.jsonl`), `${transcriptEntry(legacyMarker, 'check_messages')}\n`)

    const snapshot = data.reader.readWorkspace(data.workspace, [runtime])
    expect(snapshot.bindingCandidates).toEqual([
      expect.objectContaining({
        channelId: '1',
        composerId,
        generation: runtime.generation,
        method: 'launch_marker'
      })
    ])
  })

  it('hydrates an explicitly bound composer even when its header is filtered by workspace', () => {
    const data = fixture()
    const composerId = 'composer-bound-elsewhere-1'
    writeHeaders(data.globalStateDatabase, [header({
      composerId,
      workspace: '/Users/example/Projects/another-project',
      contextUsagePercent: 68.9
    })])
    const runtime = { ...binding('3'), composerId }
    const snapshot = data.reader.readWorkspace(data.workspace, [runtime])
    const composer = snapshot.composers.find((entry) => entry.composerId === composerId)
    expect(composer?.contextUsage?.ratio).toBeCloseTo(0.689, 3)
  })

  describe('快照指纹缓存（vscdb+wal mtime 前置，P0 性能修复）', () => {
    it('全局转录目录索引在 TTL 内复用，过期后发现新 Composer', () => {
      const data = fixture()
      let now = 10_000
      writeHeaders(data.globalStateDatabase, [])
      const reader = new CursorComposerTelemetryReader({
        globalStateDatabase: data.globalStateDatabase,
        projectsRoot: data.projectsRoot,
        workspaceStorageRoot: data.workspaceStorageRoot,
        now: () => now,
        channelActivityPollMs: 0,
        transcriptIndexTtlMs: 2_000
      })
      expect(reader.readWorkspace(data.workspace, [binding('7')]).channelActivities?.['7']).toBeUndefined()

      const composerId = 'composer-index-cache-7'
      const directory = join(data.projectsRoot, '1780659222896', 'agent-transcripts', composerId)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, `${composerId}.jsonl`), `${transcriptEntry('qtwx-mcp-7', 'check_messages')}\n`)

      expect(reader.readWorkspace(data.workspace, [binding('7')]).channelActivities?.['7']).toBeUndefined()
      now += 2_001
      expect(reader.readWorkspace(data.workspace, [binding('7')]).channelActivities?.['7']).toMatchObject({
        channelId: '7',
        composerId
      })
    })

    it('指纹未变时整轮复用缓存（同一对象引用，不重读库）', () => {
      const data = fixture()
      const composerId = 'composer-cache-hit-1'
      writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
      const runtime = { ...binding('1'), composerId }
      const first = data.reader.readWorkspace(data.workspace, [runtime])
      expect(first.availability).toBe('available')
      const second = data.reader.readWorkspace(data.workspace, [runtime])
      expect(second).toBe(first)
    })

    it('vscdb 内容变化（mtime 推进）使缓存失效并反映新值', () => {
      const data = fixture()
      writeHeaders(data.globalStateDatabase, [header({ composerId: 'c-cache-a', workspace: data.workspace })])
      const first = data.reader.readWorkspace(data.workspace, [binding('1')])
      expect(first.composers).toHaveLength(1)
      // 二次写库走 INSERT OR REPLACE（writeHeaders 的 CREATE TABLE 仅用于初始化）
      const database = new DatabaseSync(data.globalStateDatabase)
      try {
        database.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
          'composer.composerHeaders',
          JSON.stringify({
            allComposers: [
              header({ composerId: 'c-cache-a', workspace: data.workspace }),
              header({ composerId: 'c-cache-b', workspace: data.workspace })
            ]
          })
        )
      } finally {
        database.close()
      }
      // mtime 精度兜底：显式推进，避免同毫秒写入被判未变
      const bumped = new Date(Date.now() + 2_000)
      utimesSync(data.globalStateDatabase, bumped, bumped)
      const second = data.reader.readWorkspace(data.workspace, [binding('1')])
      expect(second).not.toBe(first)
      expect(second.composers).toHaveLength(2)
    })

    it('wal 文件出现/变化触发缓存失效', () => {
      const data = fixture()
      writeHeaders(data.globalStateDatabase, [header({ composerId: 'c-cache-wal', workspace: data.workspace })])
      const first = data.reader.readWorkspace(data.workspace, [binding('1')])
      expect(data.reader.readWorkspace(data.workspace, [binding('1')])).toBe(first)
      writeFileSync(`${data.globalStateDatabase}-wal`, 'wal-growth')
      expect(data.reader.readWorkspace(data.workspace, [binding('1')])).not.toBe(first)
    })

    it('bindings 关键字段变化触发缓存失效', () => {
      const data = fixture()
      writeHeaders(data.globalStateDatabase, [header({ composerId: 'c-cache-bind', workspace: data.workspace })])
      const first = data.reader.readWorkspace(data.workspace, [binding('1')])
      const rebound = data.reader.readWorkspace(data.workspace, [{ ...binding('1'), composerId: 'c-cache-bind' }])
      expect(rebound).not.toBe(first)
    })

  })
})
