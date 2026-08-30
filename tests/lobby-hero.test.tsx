import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LobbyHero } from '../src/renderer/src/lobby/LobbyHero'
import { lobbyFlowStepsFor } from '../src/renderer/src/lobby/LobbyPage'

describe('LobbyHero', () => {
  it('renders the command area as a stateful process track', () => {
    const html = renderToStaticMarkup(
      <LobbyHero
        workspaceName="qingtian"
        runName="qingtian · 本轮运行"
        goal="拾光软件开发"
        status="running"
        steps={[
          { label: '团队目标', state: 'done' },
          { label: '启动团队', state: 'done' },
          { label: 'Agent 待命', state: 'current' },
          { label: '协作执行', state: 'todo' }
        ]}
        goalLocked
        busy={false}
        autoStartOnGoalSave={false}
        primaryLabel="检查待命状态"
        primaryHint="检测各通道待命状态"
        onSaveGoal={async () => {}}
        onReconfigure={() => {}}
        onPrimary={() => {}}
        onCreateNextRun={() => {}}
      />
    )

    expect(html).toContain('lobby-command__steps')
    expect(html).toContain('--flow-progress-ratio:0.6666666666666666')
    expect(html).toContain('aria-current="step"')
    expect(html).toContain('<i>✓</i>')
    expect(html).toContain('Agent 待命')
    expect(html).toContain('<small title="qingtian · 本轮运行">本轮运行</small>')
    expect(html).not.toContain('<small title="qingtian · 本轮运行">qingtian · 本轮运行</small>')
  })

  it('shows a completed run as a finished flow with next-run action', () => {
    const steps = lobbyFlowStepsFor({
      goal: '拾光软件开发',
      status: 'completed',
      allMembersWaiting: false
    })
    const html = renderToStaticMarkup(
      <LobbyHero
        workspaceName="qingtian"
        runName="qingtian · 本轮运行"
        goal="拾光软件开发"
        status="completed"
        steps={steps}
        goalLocked
        busy={false}
        autoStartOnGoalSave={false}
        primaryLabel="检查待命状态"
        primaryHint="检测各通道待命状态"
        onSaveGoal={async () => {}}
        onReconfigure={() => {}}
        onPrimary={() => {}}
        onCreateNextRun={() => {}}
      />
    )

    expect(steps.map((step) => step.state)).toEqual(['done', 'done', 'done', 'done'])
    expect(html).toContain('--flow-progress-ratio:1')
    expect(html).toContain('开始新一轮')
    expect(html).not.toContain('aria-current="step"')
  })

  it('renders an all-offline run as disconnected instead of collaborating', () => {
    const html = renderToStaticMarkup(
      <LobbyHero
        workspaceName="qingtian"
        runName="qingtian · 本轮运行"
        goal="软件开发"
        status="running"
        steps={lobbyFlowStepsFor({ goal: '软件开发', status: 'running', allMembersWaiting: false })}
        goalLocked
        busy={false}
        autoStartOnGoalSave={false}
        primaryLabel="检查待命状态"
        primaryHint="检测各通道待命状态"
        runStateLabel="全部 Agent 离线"
        runStateKind="offline"
        runStateHint="当前没有在线 Agent；可在下方重新创建会话"
        allowCreateNextRun
        onSaveGoal={async () => {}}
        onReconfigure={() => {}}
        onPrimary={() => {}}
        onCreateNextRun={() => {}}
      />
    )
    expect(html).toContain('is-offline')
    expect(html).toContain('全部 Agent 离线')
    expect(html).toContain('当前没有在线 Agent')
    expect(html).toContain('结束本轮并新建')
    expect(html).not.toContain('协作执行中')
  })
})
