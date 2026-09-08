import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import { SessionHandoffDialog, sortHandoffTargets, targetRelation } from '../src/renderer/src/SessionHandoffDialog'

function session(channelId: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: `sg-channel:${channelId}`,
    channelId,
    generation: 0,
    displayName: `独立席 ${channelId}`,
    roleName: '独立席',
    roleTemplateKey: 'solo',
    status: 'waiting',
    currentTask: '',
    queueDepth: 0,
    connectionPhase: 'waiting',
    online: true,
    connected: true,
    waiting: true,
    workingFiles: [],
    healthEvidence: [],
    ...overrides
  }
}

describe('SessionHandoffDialog', () => {
  it('renders the source seat, the self target, other sessions ordered online-first and the note field', () => {
    const html = renderToStaticMarkup(
      <SessionHandoffDialog
        session={session('1', { composerId: 'c-1' })}
        sessions={[
          session('1', { composerId: 'c-1' }),
          session('3', { online: false, connected: false, waiting: false, status: 'offline' }),
          session('2', { waiting: false, status: 'running' })
        ]}
        loadContext={() => new Promise(() => {})}
        deliver={() => Promise.reject(new Error('not in test'))}
        onClose={() => {}}
      />
    )
    expect(html).toContain('交接会话上下文')
    expect(html).toContain('独立席 1 · CH-1')
    expect(html).toContain('正在定位 Cursor 转录文件…')
    expect(html).toContain('本会话 · CH-1')
    expect(html).toContain('等待新会话：当前 Agent 取不到')
    // 其他会话：在线忙碌的 CH-2 排在离线的 CH-3 之前，状态说明各自如实
    expect(html.indexOf('独立席 2 · CH-2')).toBeLessThan(html.indexOf('独立席 3 · CH-3'))
    // displayName 已含通道号时不重复拼接
    expect(html).not.toContain('CH-1 · CH-1')
    expect(html).toContain('运行中：排在当前任务之后')
    expect(html).toContain('离线：消息会留在它的队列，恢复后送达')
    expect(html).toContain('交接说明')
    expect(html).toContain('随消息一并送达')
    // 上下文尚未定位完成时不能投递
    expect(html).toMatch(/<button disabled=""[^>]*>投递到 CH-1（等待新会话）<\/button>/)
  })

  it('orders team candidates same-role first, then standby, then by liveness; and tags the relation', () => {
    const source = session('2', { displayName: '架构实现 · CH-2', roleName: '实现席', roleTemplateKey: 'builder' })
    const candidates = [
      session('3', { displayName: '质量验证 · CH-3', roleName: '验收席', roleTemplateKey: 'reviewer' }),
      session('4', { displayName: '架构实现 2 · CH-4', roleName: '实现席 2', roleTemplateKey: 'builder', online: false, connected: false, waiting: false, status: 'offline' }),
      session('1', { displayName: '主控协调 · CH-1', roleName: '主控席', roleTemplateKey: 'lead', waiting: false, status: 'running' }),
      session('7', { displayName: 'SG Team CH-7', roleName: '未绑定外置团队', roleTemplateKey: undefined })
    ]
    const standby = new Set(['7'])
    expect(sortHandoffTargets(source, [source, ...candidates], standby).map((candidate) => candidate.channelId))
      .toEqual(['4', '7', '3', '1'])
    expect(targetRelation(source, candidates[1]!, standby)).toBe('same-role')
    expect(targetRelation(source, candidates[3]!, standby)).toBe('standby')
    expect(targetRelation(source, candidates[0]!, standby)).toBeUndefined()
    // 独立席位之间不算「同角色」
    expect(targetRelation(session('1'), session('2'), standby)).toBeUndefined()

    const html = renderToStaticMarkup(
      <SessionHandoffDialog
        session={source}
        sessions={[source, ...candidates]}
        standbyChannelIds={['7']}
        loadContext={() => new Promise(() => {})}
        deliver={() => Promise.reject(new Error('not in test'))}
        onClose={() => {}}
      />
    )
    expect(html).toContain('同角色 · 离线：消息会留在它的队列，恢复后送达')
    expect(html).toContain('备用通道 · 待命中：立即投递')
    expect(html.indexOf('架构实现 2 · CH-4')).toBeLessThan(html.indexOf('SG Team CH-7'))
    expect(html.indexOf('SG Team CH-7')).toBeLessThan(html.indexOf('质量验证 · CH-3'))
  })
})
