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
  additions?: number
  deletions?: number
  files?: number
  workspaceStorageId?: string
}) {
  return {
    composerId: input.composerId,
    name: input.title ?? '测试会话',
    createdAt: 1_000,
    lastUpdatedAt: input.lastUpdatedAt ?? 2_000,
    contextUsagePercent: input.contextUsagePercent,
    totalLinesAdded: input.additions,
    totalLinesRemoved: input.deletions,
    filesChangedCount: input.files,
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
      contextTokenLimit: 200_000,
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
      clientDisplayName: 'Claude Fable 5',
      inputboxShortModelName: 'Claude Fable 5',
      contextTokenLimit: 300_000,
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
        isMaxMode: true
      }]
    }],
    aiSettings: {
      modelConfig: {
        composer: {
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
      contextTokenLimit: 200_000
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
      options: ['Thinking', '1M', 'Max'],
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
      optionLabels: ['Thinking', '1M', 'Max']
    })
    expect(snapshot.cursorModels?.[0]?.parameterDefinitions.map((definition) => definition.id)).toEqual([
      'thinking', 'context', 'effort'
    ])
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

  it('parses assistant work entries from the transcript, filters keepalive noise and grows incrementally', () => {
    const data = fixture()
    const composerId = 'composer-work-entries-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
    writeApplicationUser(data.globalStateDatabase, composerApplicationUser())
    const userLine = JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '实现一个测试' }] } })
    const assistantLine = JSON.stringify({
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: '好的，我先看一下代码结构。' },
          { type: 'tool_use', name: 'Glob', input: { glob_pattern: '**/*.ts', target_directory: '/repo' } },
          { type: 'tool_use', name: 'CallMcpTool', input: { server: 'qtwx-mcp-1', toolName: 'check_messages', arguments: {} } },
          { type: 'tool_use', name: 'CallMcpTool', input: { server: 'qtwx-mcp-1', toolName: 'record_reply', arguments: { content: '完成' } } }
        ]
      }
    })
    writeTranscript(data.projectsRoot, data.workspace, composerId, `${userLine}\n${assistantLine}\n`)

    // user 行不产生条目；qtwx/team 内部同步噪音被过滤；真实工具调用生成摘要
    const first = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]!.workEntries!
    expect(first.map((entry) => entry.kind)).toEqual(['text', 'tool'])
    expect(first[0]).toMatchObject({ kind: 'text', text: '好的，我先看一下代码结构。', line: 2 })
    expect(first[1]).toMatchObject({ kind: 'tool', toolName: 'Glob', toolKind: 'search', line: 2 })
    expect(first[1]!.text).toContain('**/*.ts')
    expect(first[1]!.details).toEqual([
      { label: '目录', value: '/repo', kind: 'path' },
      { label: '模式', value: '**/*.ts', kind: 'text' }
    ])
    expect(first.every((entry) => entry.at > 0)).toBe(true)
    // 同一行已经 record_reply 收尾，真实工具不应继续显示 running
    expect(first[1]!.status).toBe('done')
    expect(first[0]!.status).toBeUndefined()

    // 增量：追加新行后旧条目保留、新条目以物理行号追加；
    // 新条目出现即推断此前工具已完成（Cursor 顺序执行）
    const path = transcriptPath(data.projectsRoot, data.workspace, composerId)
    appendFileSync(path, `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '继续补充说明' }] } })}\n`)
    const second = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]!.workEntries!
    expect(second).toHaveLength(3)
    expect(second.at(-1)).toMatchObject({ kind: 'text', text: '继续补充说明', line: 3 })
    expect(second[0]).toMatchObject({ text: '好的，我先看一下代码结构。' })
    expect(second[1]!.status).toBe('done')
  })

  it('assigns transcript work entries to separate turns and filters internal polling narration', () => {
    const data = fixture()
    const composerId = 'composer-work-turns-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
    const firstTurn = 'turn-one'
    const secondTurn = 'turn-two'
    writeTranscript(data.projectsRoot, data.workspace, composerId, [
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: '开始第一轮。' },
            {
              type: 'tool_use',
              name: 'CallDynamicTool',
              input: {
                namespace: 'user-qunshu',
                toolName: 'record_process',
                arguments: { channel_id: '1', turn: firstTurn, block: { id: 'a', kind: 'thinking', status: 'running' } }
              }
            }
          ]
        }
      }),
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: '读取第一轮文件。' },
            { type: 'tool_use', name: 'Read', input: { path: '/repo/src/a.ts' } }
          ]
        }
      }),
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: '同步第一轮回复。' },
            {
              type: 'tool_use',
              name: 'CallDynamicTool',
              input: {
                namespace: 'user-qunshu',
                toolName: 'record_reply',
                arguments: { channel_id: '1', turn: firstTurn, content: '第一轮完成' }
              }
            }
          ]
        }
      }),
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: '继续 keepalive，等待新消息。' },
            {
              type: 'tool_use',
              name: 'CallDynamicTool',
              input: { namespace: 'user-qunshu', toolName: 'check_messages', arguments: { channel_id: '1' } }
            }
          ]
        }
      }),
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: '开始第二轮。' },
            {
              type: 'tool_use',
              name: 'CallDynamicTool',
              input: {
                namespace: 'user-qunshu',
                toolName: 'record_process',
                arguments: { channel_id: '1', turn: secondTurn, block: { id: 'b', kind: 'thinking', status: 'running' } }
              }
            }
          ]
        }
      }),
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Shell', input: { command: 'npm test' } }
          ]
        }
      })
    ].join('\n') + '\n')

    const entries = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]!.workEntries!
    expect(entries.map((entry) => entry.text)).toEqual([
      '开始第一轮。',
      '读取第一轮文件。',
      'Read /repo/src/a.ts',
      '开始第二轮。',
      'Shell npm test'
    ])
    expect(entries.filter((entry) => entry.turn === firstTurn)).toHaveLength(3)
    expect(entries.filter((entry) => entry.turn === secondTurn)).toHaveLength(2)
    expect(entries.some((entry) => entry.text.includes('keepalive'))).toBe(false)
    expect(entries.some((entry) => entry.text.includes('record_process'))).toBe(false)
    expect(entries.find((entry) => entry.text === 'Read /repo/src/a.ts')?.status).toBe('done')
    expect(entries.at(-1)?.status).toBe('running')
  })

  it('starts a new implicit turn after returning to check_messages', () => {
    const data = fixture()
    const composerId = 'composer-implicit-turn-boundary-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
    writeTranscript(data.projectsRoot, data.workspace, composerId, [
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: '第一轮开始。' },
            { type: 'tool_use', name: 'Shell', input: { command: 'npm test' } }
          ]
        }
      }),
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: '这条消息我已经读过了。继续轮询。' },
            {
              type: 'tool_use',
              name: 'CallDynamicTool',
              input: { namespace: 'user-qunshu', toolName: 'check_messages', arguments: { channel_id: '1' } }
            }
          ]
        }
      }),
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: '第二轮开始。' },
            { type: 'tool_use', name: 'Read', input: { path: '/repo/src/b.ts' } }
          ]
        }
      })
    ].join('\n') + '\n')

    const entries = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]!.workEntries!
    expect(entries.map((entry) => entry.text)).toEqual([
      '第一轮开始。',
      'Shell npm test',
      '第二轮开始。',
      'Read /repo/src/b.ts'
    ])
    expect(entries.some((entry) => entry.text.includes('继续轮询'))).toBe(false)
    expect(new Set(entries.map((entry) => entry.turn)).size).toBe(2)
    expect(entries[1]!.status).toBe('done')
    expect(entries[0]!.turn).not.toBe(entries[2]!.turn)
  })

  it('does not create visible work entries for repeated empty polling', () => {
    const data = fixture()
    const composerId = 'composer-empty-polling-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
    writeTranscript(data.projectsRoot, data.workspace, composerId, [
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: '继续等待用户回复。' },
            {
              type: 'tool_use',
              name: 'CallDynamicTool',
              input: { namespace: 'user-qunshu', toolName: 'check_messages', arguments: { channel_id: '1' } }
            }
          ]
        }
      }),
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: '这条消息我已经读过了。让我继续轮询等待用户的回复。' },
            {
              type: 'tool_use',
              name: 'CallDynamicTool',
              input: { namespace: 'user-qunshu', toolName: 'record_reply', arguments: { channel_id: '1', content: 'noop' } }
            }
          ]
        }
      }),
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'CallDynamicTool',
              input: { namespace: 'user-qunshu', toolName: 'check_messages', arguments: { channel_id: '1' } }
            }
          ]
        }
      })
    ].join('\n') + '\n')

    const composer = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]
    expect(composer?.workEntries).toBeUndefined()
  })

  it('hides qingtian/team MCP calls from Cursor work entries while keeping external MCP calls', () => {
    const data = fixture()
    const composerId = 'composer-filter-internal-mcp-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
    writeTranscript(data.projectsRoot, data.workspace, composerId, `${JSON.stringify({
      role: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'CallDynamicTool', input: { namespace: 'qingtian', toolName: 'team_list_available', arguments: {} } },
          { type: 'tool_use', name: 'CallDynamicTool', input: { namespace: 'github', toolName: 'create_pull_request', arguments: {} } },
          { type: 'tool_use', name: 'CallMcpTool', input: { server: 'project-alpha-qtwx-mcp-1', toolName: 'qingtian', arguments: {} } },
          { type: 'tool_use', name: 'CallMcpTool', input: { server: 'qtwx-mcp-1', toolName: 'record_reply', arguments: {} } }
        ]
      }
    })}\n`)

    const entries = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]!.workEntries!
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'tool',
      toolKind: 'mcp',
      toolName: 'create_pull_request',
      text: '调用 create_pull_request',
      details: [
        { label: '命名空间', value: 'github', kind: 'text' },
        { label: '参数', value: '{}', kind: 'code' }
      ]
    })
  })

  it('keeps expandable tool input details for command and edit process cards', () => {
    const data = fixture()
    const composerId = 'composer-process-details-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
    writeTranscript(data.projectsRoot, data.workspace, composerId, `${JSON.stringify({
      role: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Shell',
            input: {
              command: 'npm test',
              working_directory: '/repo',
              description: 'Run unit tests',
              block_until_ms: 120000
            }
          },
          {
            type: 'tool_use',
            name: 'StrReplace',
            input: {
              path: '/repo/src/index.ts',
              old_string: 'const a = 1\nconst b = 2',
              new_string: 'const a = 1\nconst b = 3'
            }
          },
          {
            type: 'tool_use',
            name: 'ApplyPatch',
            input: '*** Begin Patch\n*** Update File: /repo/src/App.tsx\n@@\n-old\n+new\n*** End Patch\n'
          }
        ]
      }
    })}\n`)

    const entries = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]!.workEntries!
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({
      toolName: 'Shell',
      toolKind: 'command',
      details: [
        { label: '命令', value: 'npm test', kind: 'code' },
        { label: '工作目录', value: '/repo', kind: 'path' },
        { label: '说明', value: 'Run unit tests', kind: 'text' }
      ]
    })
    expect(entries[1]).toMatchObject({
      toolName: 'StrReplace',
      toolKind: 'edit',
      details: [
        { label: '文件', value: '/repo/src/index.ts', kind: 'path' },
        { label: '变更规模', value: '+2 / -2' },
        { label: '替换前', value: 'const a = 1\nconst b = 2', kind: 'code' },
        { label: '替换后', value: 'const a = 1\nconst b = 3', kind: 'code' }
      ]
    })
    expect(entries[2]).toMatchObject({
      toolName: 'ApplyPatch',
      toolKind: 'edit',
      details: [
        { label: '文件', value: '/repo/src/App.tsx', kind: 'path' },
        { label: 'Patch', kind: 'code' }
      ]
    })
    expect(entries[2]!.details?.[1]?.value).toContain('*** Update File: /repo/src/App.tsx')
  })

  it('drops redacted-only transcript text while keeping useful redacted context', () => {
    const data = fixture()
    const composerId = 'composer-redacted-noise-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
    writeTranscript(data.projectsRoot, data.workspace, composerId, `${JSON.stringify({
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: '[REDACTED]' },
          { type: 'text', text: '[REDACTED]\n\n[REDACTED]' },
          {
            type: 'tool_use',
            name: 'Shell',
            input: {
              command: 'npm test',
              working_directory: '/repo',
              description: '[REDACTED]'
            }
          },
          { type: 'text', text: '验证完成；敏感片段为 [REDACTED]。' }
        ]
      }
    })}\n`)

    const entries = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]!.workEntries!
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      kind: 'tool',
      toolName: 'Shell',
      details: [
        { label: '命令', value: 'npm test', kind: 'code' },
        { label: '工作目录', value: '/repo', kind: 'path' }
      ]
    })
    expect(entries[0]!.details?.some((detail) => detail.value === '[REDACTED]')).toBe(false)
    expect(entries[1]).toMatchObject({
      kind: 'text',
      text: '验证完成；敏感片段为 [REDACTED]。'
    })
  })

  it('parses TodoWrite into a structured task card and classifies rg as search', () => {
    const data = fixture()
    const composerId = 'composer-todo-card-123'
    const runtime = { ...binding('1'), composerId }
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
    writeTranscript(data.projectsRoot, data.workspace, composerId, `${JSON.stringify({
      role: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: {
              merge: false,
              todos: [
                { id: 'a', content: '核对需求基线', status: 'completed' },
                { id: 'b', content: '实现过程回显', status: 'in_progress' },
                { id: 'c', content: '跑全量测试', status: 'pending' }
              ]
            }
          },
          { type: 'tool_use', name: 'rg', input: { pattern: 'workEntries', path: 'src/' } }
        ]
      }
    })}\n`)

    const entries = data.reader.readWorkspace(data.workspace, [runtime]).composers[0]!.workEntries!
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'tool', toolKind: 'todo', toolName: 'TodoWrite' })
    expect(entries[0]!.todos).toEqual([
      { content: '核对需求基线', status: 'completed' },
      { content: '实现过程回显', status: 'in_progress' },
      { content: '跑全量测试', status: 'pending' }
    ])
    expect(entries[1]).toMatchObject({ kind: 'tool', toolKind: 'search', toolName: 'rg' })
    expect(entries[1]!.text).toContain('workEntries')
  })

  it('omits work entries for composers without a binding or channel evidence', () => {
    const data = fixture()
    const composerId = 'composer-no-binding-123'
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: data.workspace })])
    writeTranscript(
      data.projectsRoot,
      data.workspace,
      composerId,
      `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '干活' }] } })}\n`
    )

    const composer = data.reader.readWorkspace(data.workspace, []).composers[0]
    expect(composer?.workEntries).toBeUndefined()
  })

  it('resolves work entries for channel-located composers in numeric project dirs', () => {
    const data = fixture()
    const composerId = 'composer-channel-work-123'
    // composer 头部属于另一个工作区，会被工作区过滤——靠通道转录水合
    writeHeaders(data.globalStateDatabase, [header({ composerId, workspace: join(data.root, 'other-workspace') })])
    const directory = join(data.projectsRoot, '1779762671039', 'agent-transcripts', composerId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `${composerId}.jsonl`), `${JSON.stringify({
      role: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'CallMcpTool', input: { server: 'qtwx-mcp-1', toolName: 'check_messages', arguments: {} } }
        ]
      }
    })}\n${JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'text', text: '在跨工作区窗口里工作' }] }
    })}\n`)

    const composer = data.reader.readWorkspace(data.workspace, [binding('1')]).composers[0]
    expect(composer?.composerId).toBe(composerId)
    expect(composer?.workEntries).toHaveLength(1)
    expect(composer?.workEntries?.[0]).toMatchObject({ kind: 'text', text: '在跨工作区窗口里工作' })
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

  it('still stops an idle agent whose waiting lease ended and transcript went stale', () => {
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
    expect(snapshot.composers[0]?.activity).toMatchObject({ state: 'stopped' })
    expect(snapshot.composers[0]?.activity?.detail).toContain('等待租约已经结束')
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
})
