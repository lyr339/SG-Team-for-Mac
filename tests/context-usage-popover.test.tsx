// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ContextUsage } from '../src/domain/agent-session'
import { ContextUsagePopover } from '../src/renderer/src/ContextUsagePopover'

const usage: ContextUsage = {
  used: 18_900,
  limit: 200_000,
  ratio: 0.0945,
  breakdown: {
    totalUsedTokens: 18_900,
    maxTokens: 200_000,
    categories: [
      { id: 'system_prompt', label: 'System prompt', estimatedTokens: 488 },
      { id: 'tools', label: 'Tool definitions', estimatedTokens: 7_700 },
      { id: 'rules', label: 'Rules', estimatedTokens: 3_800 },
      { id: 'skills', label: 'Skills', estimatedTokens: 3_900 },
      { id: 'mcp', label: 'MCP & dynamic tools', estimatedTokens: 2_500 },
      { id: 'subagents', label: 'Subagent definitions', estimatedTokens: 264 },
      { id: 'conversation', label: 'Conversation', estimatedTokens: 217 }
    ]
  }
}

describe('ContextUsagePopover', () => {
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

  it('opens the Cursor-native category breakdown on pointer hover', async () => {
    await act(async () => root.render(<ContextUsagePopover usage={usage} />))
    const meter = container.querySelector<HTMLDivElement>('.context-meter')!
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => {
      meter.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('9% Full')
    expect(dialog.textContent).toContain('~18.9K / 200K Tokens')
    expect(dialog.textContent).toContain('System prompt')
    expect(dialog.textContent).toContain('Tool definitions')
    expect(dialog.textContent).toContain('MCP & dynamic tools')
    expect(dialog.textContent).toContain('Conversation')
    expect(dialog.textContent).not.toContain('本运行期计费 Token')
    expect(dialog.querySelector('.context-breakdown-bar > .is-tools')).not.toBeNull()
  })

  it('supports keyboard/click access and a truthful no-breakdown fallback', async () => {
    await act(async () => root.render(
      <ContextUsagePopover usage={{ used: 20_000, limit: 200_000, ratio: 0.1 }} />
    ))
    const trigger = container.querySelector<HTMLButtonElement>('.composer-context')!
    await act(async () => trigger.click())
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('20K / 200K Tokens')
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('等待 Cursor 写入分类统计')
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="关闭上下文统计"]')!.click())
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })
})
