import type { TeamRunStatus } from '../../../domain/team-control'
import type { LobbyHeroStep } from './LobbyHero'

export function lobbyFlowStepsFor(input: {
  goal: string
  status: TeamRunStatus
  allMembersWaiting: boolean
}): readonly LobbyHeroStep[] {
  const launched = ['launching', 'running', 'attention', 'paused', 'completed'].includes(input.status)
  const completed = input.status === 'completed'
  const goalDefined = Boolean(input.goal.trim())
  return [
    { label: '团队目标', state: goalDefined ? 'done' : 'current' },
    { label: '启动团队', state: launched ? 'done' : goalDefined ? 'current' : 'todo' },
    { label: 'Agent 待命', state: completed || input.allMembersWaiting ? 'done' : launched ? 'current' : 'todo' },
    { label: '协作执行', state: completed ? 'done' : launched && input.allMembersWaiting ? 'current' : 'todo' }
  ]
}
