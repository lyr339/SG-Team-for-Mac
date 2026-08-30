import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ManualHandoffDialog } from '../src/renderer/src/team/ManualHandoffDialog'

describe('ManualHandoffDialog', () => {
  it('shows a real lead-authority takeover without implying the member role is vacated', () => {
    const html = renderToStaticMarkup(
      <ManualHandoffDialog
        options={{
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
        }}
        busy={false}
        error=""
        onClose={() => {}}
        onConfirm={async () => {}}
      />
    )
    expect(html).toContain('交接 主控协调')
    expect(html).toContain('接管主控')
    expect(html).toContain('保留架构实现职责与现有任务')
  })
})
