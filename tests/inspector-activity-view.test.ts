import { describe, expect, it } from 'vitest'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import { projectActivity, splitMcpToolName } from '../src/renderer/src/inspector/activity-view'

const workspace = '/Users/me/project'

const entries: ConversationEntry[] = [
  { id: 'u1', channelId: '2', role: 'user', text: '把登录页改成暗色', timestamp: 1, deliveredAt: 2, status: 'complete', source: 'desktop' },
  {
    id: 'r1', channelId: '2', role: 'assistant', text: '完成', timestamp: 9, status: 'complete', source: 'cursor',
    processBlocks: [
      { kind: 'thinking', id: 't1', text: '先看现状', status: 'done', durationMs: 4_000 },
      { kind: 'tool', id: 'read1', toolName: 'read_file', toolKind: 'read', status: 'done', summary: `${workspace}/src/login.tsx` },
      { kind: 'tool', id: 'grep1', toolName: 'grep', toolKind: 'search', status: 'done', summary: 'theme' },
      { kind: 'tool', id: 'edit1', toolName: 'edit_file', toolKind: 'edit', status: 'done', summary: `${workspace}/src/login.tsx`, startedAt: 3 },
      { kind: 'tool', id: 'edit2', toolName: 'edit_file', toolKind: 'edit', status: 'done', summary: 'src/login.tsx', startedAt: 4 },
      { kind: 'command', id: 'cmd1', command: 'npm test', output: '3 passed', exitCode: 0, status: 'done', startedAt: 5, completedAt: 7 },
      { kind: 'tool', id: 'mcp1', toolName: 'mcp-user-playwright-browser_snapshot', toolKind: 'mcp', status: 'done', summary: 'user-playwright' },
      { kind: 'tool', id: 'todo1', toolName: 'todos', toolKind: 'todo', status: 'done', todos: [{ content: 'x', status: 'completed' }] }
    ]
  },
  { id: 'u2', channelId: '2', role: 'user', text: '再跑一次构建', timestamp: 20, deliveredAt: 21, status: 'complete', source: 'desktop' }
]

describe('activity projection', () => {
  it('groups blocks by user turn, de-duplicates files and sources, and keeps todo blocks out', () => {
    const view = projectActivity(entries, undefined, workspace)
    // 第二条用户消息还没有任何过程：不出现空回合；最新回合排前面。
    expect(view.turns).toHaveLength(1)
    const turn = view.turns[0]!
    expect(turn.prompt).toBe('把登录页改成暗色')
    expect(turn.files).toEqual([expect.objectContaining({ path: 'src/login.tsx', count: 2, kinds: ['edit'], blockId: 'edit2' })])
    expect(turn.sources).toEqual([
      expect.objectContaining({ kind: 'read', label: 'src/login.tsx', count: 1 }),
      expect.objectContaining({ kind: 'search', label: 'theme' })
    ])
    expect(turn.commands).toEqual([expect.objectContaining({ command: 'npm test', exitCode: 0, output: '3 passed', durationMs: 2 })])
    expect(turn.tools).toEqual([expect.objectContaining({ server: 'user-playwright', toolName: 'browser_snapshot' })])
    expect(turn.thinkingMs).toBe(4_000)
    expect(turn.stepCount).toBe(8)
    expect(view.totals).toEqual({ files: 1, commands: 1, failedCommands: 0, sources: 2, tools: 1 })
  })

  it('attaches the live process to the newest turn and marks it live', () => {
    const view = projectActivity(entries, {
      turn: 'live', startedAt: 22, updatedAt: 23, generating: true,
      blocks: [
        { kind: 'tool', id: 'cmd-live', toolName: 'run_terminal_cmd', toolKind: 'command', status: 'running', summary: 'npm run build' },
        { kind: 'tool', id: 'write-live', toolName: 'write', toolKind: 'write', status: 'running', summary: 'dist/notes.md' }
      ]
    }, workspace)
    expect(view.turns[0]).toMatchObject({ prompt: '再跑一次构建', live: true })
    expect(view.turns[0]!.commands).toEqual([expect.objectContaining({ command: 'npm run build', status: 'running' })])
    expect(view.turns[0]!.files).toEqual([expect.objectContaining({ path: 'dist/notes.md', kinds: ['write'], status: 'running' })])
    expect(view.turns[1]!.prompt).toBe('把登录页改成暗色')
  })

  it('counts failed commands by explicit failure or non-zero exit code', () => {
    const failing: ConversationEntry[] = [
      { id: 'u', channelId: '2', role: 'user', text: 'x', timestamp: 1, deliveredAt: 1, status: 'complete', source: 'desktop' },
      {
        id: 'r', channelId: '2', role: 'assistant', text: '', timestamp: 2, status: 'complete', source: 'cursor',
        processBlocks: [
          { kind: 'command', id: 'c1', command: 'npm test', output: '1 failed', exitCode: 1, status: 'done' },
          { kind: 'tool', id: 'c2', toolName: 'shell', toolKind: 'command', status: 'failed', summary: 'make', error: 'boom' }
        ]
      }
    ]
    const view = projectActivity(failing, undefined)
    expect(view.totals.failedCommands).toBe(2)
    expect(view.turns[0]!.commands[1]).toMatchObject({ output: 'boom', status: 'failed' })
  })

  it('splits MCP tool names into server and tool', () => {
    expect(splitMcpToolName('mcp-SG Team-check_messages')).toEqual({ server: 'SG Team', tool: 'check_messages' })
    expect(splitMcpToolName('read_file')).toEqual({ tool: 'read_file' })
  })
})
