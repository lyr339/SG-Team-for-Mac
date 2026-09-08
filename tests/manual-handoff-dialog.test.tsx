// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManualTeamHandoffOutcome, TeamHandoffOptions } from '../src/domain/team-handoff'
import { ManualHandoffDialog } from '../src/renderer/src/team/ManualHandoffDialog'

const leadAuthority: TeamHandoffOptions = {
  runId: 'run-a',
  sourceSlotId: 'slot-lead',
  sourceRoleName: '主控协调',
  sourceChannelId: '1',
  candidates: [{
    agentSessionId: 'agent-builder',
    kind: 'member',
    mode: 'lead_authority',
    channelId: '2',
    slotId: 'slot-builder',
    roleName: '架构实现',
    eligible: true,
    impact: '保留架构实现职责与现有任务，同时接管唯一主控权限'
  }]
}

const roleRebind: TeamHandoffOptions = {
  runId: 'run-a',
  sourceSlotId: 'slot-builder',
  sourceRoleName: '架构实现',
  sourceChannelId: '2',
  candidates: [{
    agentSessionId: 'agent-7',
    kind: 'standby',
    mode: 'role_rebind',
    channelId: '7',
    roleName: 'SG Team CH-7',
    eligible: true,
    impact: '备用 Agent 将直接接管，不会产生新的职责空缺'
  }]
}

describe('ManualHandoffDialog', () => {
  it('shows a real lead-authority takeover without implying the member role is vacated', () => {
    const html = renderToStaticMarkup(
      <ManualHandoffDialog options={leadAuthority} busy={false} error="" onClose={() => {}} onConfirm={async () => undefined} />
    )
    expect(html).toContain('交接 主控协调')
    expect(html).toContain('接管主控')
    expect(html).toContain('保留架构实现职责与现有任务')
  })

  it('offers the context handoff checked by default and explains what gets queued', () => {
    const html = renderToStaticMarkup(
      <ManualHandoffDialog options={roleRebind} busy={false} error="" onClose={() => {}} onConfirm={async () => undefined} />
    )
    expect(html).toContain('同时交接上下文文档')
    expect(html).toMatch(/<input type="checkbox" checked=""/)
    expect(html).toContain('把 CH-2 的 Cursor 会话转录与拾光会话记录路径作为一条消息排进接手者队列')
    expect(html).toContain('备用')
  })
})

describe('ManualHandoffDialog · 确认后的结果页', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })

  async function confirmWith(outcome: ManualTeamHandoffOutcome): Promise<ReturnType<typeof vi.fn>> {
    const onConfirm = vi.fn(async () => outcome)
    await act(async () => {
      root.render(<ManualHandoffDialog options={roleRebind} busy={false} error="" onClose={() => {}} onConfirm={onConfirm} onOpenSession={() => {}} />)
    })
    const confirm = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '确认交接')!
    await act(async () => { confirm.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })) })
    return onConfirm
  }

  it('passes the checkbox state through and shows both the migration and the queued context documents', async () => {
    const onConfirm = await confirmWith({
      handoff: { mode: 'role_rebind', messageId: 'm-1' },
      contextHandoff: {
        ok: true,
        result: { targetChannelId: '7', held: false, transcriptPath: '/t/composer.jsonl', recordPath: '/h/CH-2.md', commandId: 'c', issuedAt: 1 }
      }
    })
    expect(onConfirm).toHaveBeenCalledWith({ agentSessionId: 'agent-7', includeContext: true })
    const status = container.querySelector('[role="status"]')!
    expect(status.textContent).toContain('架构实现 已交给 SG Team CH-7 · CH-7')
    expect(status.textContent).toContain('上下文文档已排进 CH-7 的队列')
    expect(status.textContent).toContain('/t/composer.jsonl')
    expect(status.textContent).toContain('/h/CH-2.md')
    expect(Array.from(container.querySelectorAll('button')).map((button) => button.textContent)).toContain('打开 CH-7')
  })

  it('keeps the migration result and surfaces a failed context delivery as a warning', async () => {
    await confirmWith({
      handoff: { mode: 'role_rebind', messageId: 'm-1' },
      contextHandoff: { ok: false, error: 'CH-2 尚未绑定 Cursor Composer，找不到它的上下文文档' }
    })
    const warning = container.querySelector('.handoff-done p.is-warning')!
    expect(warning.textContent).toContain('上下文文档未投递：CH-2 尚未绑定 Cursor Composer')
    expect(warning.textContent).toContain('职责迁移不受影响')
  })
})
