import type { AgentSkillCatalogEntry } from '../../../domain/agent-skill'
import type { TeamRoleTemplate } from '../../../domain/team-control'

export const MAX_AUTO_SKILLS_PER_ROLE = 6

export const AUTO_SKILL_DENYLIST = new Set([
  'create-subagent',
  'shell',
  'yeet'
])

export function defaultSkillIdsForRole(
  skills: AgentSkillCatalogEntry[],
  template: Pick<TeamRoleTemplate, 'recommendedSkills'>
): string[] {
  const installedByName = new Map(
    skills
      .filter((skill) => skill.installed && !skill.manualOnly && !AUTO_SKILL_DENYLIST.has(skill.name))
      .map((skill) => [skill.name, skill])
  )
  const result: string[] = []
  const seen = new Set<string>()
  for (const name of template.recommendedSkills) {
    if (seen.has(name)) continue
    seen.add(name)
    const skill = installedByName.get(name)
    if (!skill) continue
    result.push(skill.id)
    if (result.length >= MAX_AUTO_SKILLS_PER_ROLE) break
  }
  return result
}
