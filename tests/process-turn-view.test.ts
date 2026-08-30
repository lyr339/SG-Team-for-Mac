import { describe, expect, it } from 'vitest'
import { buildProcessTurnView, suggestedActionsFromText } from '../src/renderer/src/process-turn-view'

describe('ProcessTurnViewModel', () => {

  it('preserves Cursor native thinking/tool order and exposes native details', () => {
    const model = buildProcessTurnView({
      id: 'native-turn',
      blocks: [
        { kind: 'thinking', id: 'z-thinking', text: '先分析', status: 'done', durationMs: 2_000 },
        { kind: 'message', id: 'assistant-progress', text: '准备读取目标文件。', status: 'done' },
        { kind: 'tool', id: 'a-read', toolName: 'read_file_v2', toolKind: 'read', summary: '/a.ts', output: 'file body', status: 'done' },
        { kind: 'thinking', id: 'm-thinking', text: '再判断', status: 'running' },
        { kind: 'tool', id: 'b-browser', toolName: 'browser_navigate', toolKind: 'browser', summary: 'http://localhost', status: 'running' },
        { kind: 'tool', id: 'todos', toolName: 'todos', toolKind: 'todo', summary: '待办清单 0/1', todos: [{ content: '验收', status: 'in_progress' }], status: 'running' }
      ]
    })
    expect(model.steps.map((step) => step.kind)).toEqual(['thinking', 'message', 'read', 'thinking', 'browser', 'todo'])
    expect(model.steps[0]?.durationMs).toBe(2_000)
    expect(model.steps[1]?.body).toBe('准备读取目标文件。')
    expect(model.steps[2]?.details).toContainEqual({ label: '输出', value: 'file body', kind: 'code' })
    expect(model.steps[5]?.todos).toEqual([{ content: '验收', status: 'in_progress' }])
  })

  it('marks CDP sampling boundaries as estimated timing', () => {
    const model = buildProcessTurnView({
      id: 'cursor-live',
      blocks: [{
        kind: 'tool', id: 'cursor:read', toolName: 'read_file', toolKind: 'read',
        summary: 'package.json', status: 'done', startedAt: 1_000, completedAt: 1_120,
        timingEstimated: true
      }]
    })
    expect(model.timingEstimated).toBe(true)
    expect(model.elapsedMs).toBe(120)
  })

  it('extracts up to four contextual next actions from a real answer', () => {
    expect(suggestedActionsFromText(`结论已经确认。\n\n接下来可以：\n1. 补齐回归测试\n2. 提交本轮改动\n3. 观察实时日志\n4. 更新实现文档\n5. 多余项`)).toEqual([
      '补齐回归测试', '提交本轮改动', '观察实时日志', '更新实现文档'
    ])
  })
})
