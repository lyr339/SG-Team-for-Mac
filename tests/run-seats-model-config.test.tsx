// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CursorModelOption, CursorModelSelection } from '../src/domain/cursor-model'
import { RunSeats } from '../src/renderer/src/run/RunSeats'

const opus: CursorModelOption = {
  modelId: 'claude-opus-5',
  displayName: 'Claude Opus 5',
  selected: true,
  parameters: [
    { id: 'thinking', value: 'true' },
    { id: 'context', value: '1m' },
    { id: 'effort', value: 'max' },
    { id: 'fast', value: 'true' }
  ],
  maxMode: true,
  supportsMaxMode: true,
  supportsNonMaxMode: true,
  optionLabels: ['Think', '1M', 'Max', 'Fast'],
  parameterDefinitions: [
    {
      id: 'thinking', displayName: 'Thinking', kind: 'boolean',
      values: [
        { value: 'false', displayName: 'Off', increasesCost: false },
        { value: 'true', displayName: 'On', increasesCost: false }
      ]
    },
    {
      id: 'context', displayName: 'Context', kind: 'enum',
      values: [
        { value: '300k', displayName: '300K', increasesCost: false },
        { value: '1m', displayName: '1M', increasesCost: true }
      ]
    },
    {
      id: 'effort', displayName: 'Effort', kind: 'enum',
      values: [
        { value: 'low', displayName: 'Low', increasesCost: false },
        { value: 'medium', displayName: 'Medium', increasesCost: false },
        { value: 'high', displayName: 'High', increasesCost: false },
        { value: 'xhigh', displayName: 'Extra High', increasesCost: false },
        { value: 'max', displayName: 'Max', increasesCost: false }
      ]
    },
    {
      id: 'fast', displayName: 'Fast', kind: 'boolean',
      values: [
        { value: 'false', displayName: 'Off', increasesCost: false },
        { value: 'true', displayName: 'Fast', increasesCost: true }
      ]
    }
  ],
  contextTokenLimit: 300_000,
  contextTokenLimitForMaxMode: 1_000_000
}

const gptSol: CursorModelOption = {
  modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', selected: true,
  parameters: [{ id: 'context', value: '1m' }, { id: 'reasoning', value: 'max' }, { id: 'fast', value: 'false' }],
  maxMode: true, supportsMaxMode: true, supportsNonMaxMode: true, optionLabels: [],
  parameterDefinitions: [
    { id: 'context', displayName: 'Context', kind: 'enum', values: [
      { value: '272k', displayName: '272K', increasesCost: false },
      { value: '1m', displayName: '1M', increasesCost: true }
    ] },
    { id: 'reasoning', displayName: 'Reasoning', kind: 'enum', values: [
      { value: 'max', displayName: 'Max', increasesCost: false }
    ] },
    { id: 'fast', displayName: 'Fast', kind: 'boolean', values: [
      { value: 'false', displayName: 'Off', increasesCost: false },
      { value: 'true', displayName: 'Fast', increasesCost: true }
    ] }
  ],
  variants: [
    { parameters: [{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'max' }, { id: 'fast', value: 'false' }], maxMode: false },
    { parameters: [{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'max' }, { id: 'fast', value: 'true' }], maxMode: false },
    { parameters: [{ id: 'context', value: '1m' }, { id: 'reasoning', value: 'max' }, { id: 'fast', value: 'false' }], maxMode: true }
  ]
}

function effortOf(selection: CursorModelSelection | undefined): string | undefined {
  return selection?.parameters.find((parameter) => parameter.id === 'effort')?.value
}

describe('run seats · per-session model config', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('saves Max → High, reopens as High, and launches with High', async () => {
    const persisted: CursorModelSelection[] = []
    const launched = vi.fn<(selection: CursorModelSelection) => void>()

    function Harness(): React.JSX.Element {
      const [selection, setSelection] = useState<CursorModelSelection>(() => structuredClone(opus))
      return (
        <RunSeats
          rows={[{ channelId: '3', name: '会话 3', pending: true }]}
          cursorModels={[opus]}
          selections={{ '3': selection }}
          busy={false}
          createLabel="一键创建会话（1）"
          cdpAutoHealEnabled={false}
          onCreate={() => launched(selection)}
          onModelSave={async (_channelId: string, next: CursorModelSelection) => {
            persisted.push(structuredClone(next))
            setSelection(structuredClone(next))
          }}
        />
      )
    }

    await act(async () => root.render(<Harness />))
    const open = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>(
      'button[aria-label="配置 CH-3 会话"]'
    )!

    await act(async () => open().click())
    const effortMax = document.querySelector<HTMLButtonElement>('button[aria-label="CH-3 弹层Effort Max"]')!
    expect(effortMax.getAttribute('aria-pressed')).toBe('true')
    expect(document.body.textContent).toContain('Extra High')
    expect(document.body.textContent).not.toContain('思考强度')

    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="CH-3 弹层Effort High"]')!.click())
    const save = Array.from(document.querySelectorAll<HTMLButtonElement>('.cursor-model-dialog button'))
      .find((button) => button.textContent === '保存')!
    await act(async () => save.click())

    expect(persisted).toHaveLength(1)
    expect(effortOf(persisted[0])).toBe('high')
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => open().click())
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="CH-3 弹层Effort High"]')?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="关闭会话配置"]')!.click())

    await act(async () => {
      const launch = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('一键创建会话'))!
      launch.click()
    })
    expect(launched).toHaveBeenCalledTimes(1)
    expect(effortOf(launched.mock.calls[0]?.[0])).toBe('high')
  })

  it('highlights and focuses the one-click action when goal guidance is active', async () => {
    await act(async () => root.render(
      <RunSeats
        rows={[{ channelId: '1', name: '会话 1', pending: true }, { channelId: '2', name: '会话 2', pending: true }]}
        cursorModels={[opus]}
        selections={{ '1': structuredClone(opus), '2': structuredClone(opus) }}
        busy={false}
        createLabel="一键创建会话（2）"
        guided
        cdpAutoHealEnabled={false}
        onCreate={() => {}}
        onModelSave={() => {}}
      />
    ))
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    expect(container.querySelector('.run-seats.is-guided')).not.toBeNull()
    expect(container.textContent).toContain('下一步')
    expect(container.textContent).toContain('确认模型后创建 2 个 Cursor 会话')
    const launch = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('一键创建会话'))!
    expect(document.activeElement).toBe(launch)
  })

  it('keeps the editor open when persistence fails', async () => {
    await act(async () => root.render(
      <RunSeats
        rows={[{ channelId: '3', name: '会话 3', pending: true }]}
        cursorModels={[opus]}
        selections={{ '3': structuredClone(opus) }}
        busy={false}
        createLabel="一键创建会话（1）"
        cdpAutoHealEnabled={false}
        onCreate={() => {}}
        onModelSave={async () => { throw new Error('落库失败') }}
      />
    ))
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="配置 CH-3 会话"]')!.click())
    const save = Array.from(document.querySelectorAll<HTMLButtonElement>('.cursor-model-dialog button'))
      .find((button) => button.textContent === '保存')!
    await act(async () => save.click())
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('落库失败')
  })

  it('mirrors Cursor linkage when GPT-5.6 Sol Fast conflicts with 1M', async () => {
    await act(async () => root.render(
      <RunSeats
        rows={[{ channelId: '1', name: '会话 1', pending: true }]}
        cursorModels={[gptSol]}
        selections={{ '1': structuredClone(gptSol) }}
        busy={false}
        createLabel="一键创建会话（1）"
        cdpAutoHealEnabled={false}
        onCreate={() => {}}
        onModelSave={() => {}}
      />
    ))
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="配置 CH-1 会话"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="CH-1 弹层Fast Fast"]')!.click())
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="CH-1 弹层Context 272K"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector<HTMLInputElement>('.cursor-model-dialog__max-mode input')?.checked).toBe(false)
    expect(document.body.textContent).toContain('Cursor 联动：Context → 272K · MAX Mode → Off')
  })
})
