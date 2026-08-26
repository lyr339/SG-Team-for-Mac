import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import { SessionRailCard } from '../src/renderer/src/SessionRailCard'

const session: AgentSession = {
  id: 'session-1',
  channelId: '1',
  generation: 1,
  displayName: '主控协调',
  roleName: '主控席',
  status: 'offline',
  currentTask: '',
  queueDepth: 2,
  connectionPhase: 'waiting',
  online: false,
  connected: false,
  waiting: false,
  deliveryMode: 'queued',
  workingFiles: [],
  healthEvidence: []
}

describe('SessionRailCard', () => {
  it('renders offline state for queue-sendable embedded sessions', () => {
    const html = renderToStaticMarkup(
      <SessionRailCard
        session={session}
        selected={false}
        onOpen={() => {}}
      />
    )

    expect(html).toContain('已离线')
    expect(html).toContain('排队 2')
    expect(html).not.toContain('待轮询')
    expect(html).toContain('rail-session-card__state is-offline')
  })
})
