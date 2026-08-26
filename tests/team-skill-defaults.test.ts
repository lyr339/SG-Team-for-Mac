import { describe, expect, it } from 'vitest'
import type { AgentSkillCatalogEntry } from '../src/domain/agent-skill'
import { TEAM_ROLE_TEMPLATES } from '../src/domain/team-control'
import { AUTO_SKILL_DENYLIST, defaultSkillIdsForRole, MAX_AUTO_SKILLS_PER_ROLE } from '../src/renderer/src/team/team-skill-defaults'

function skill(name: string, options: Partial<AgentSkillCatalogEntry> = {}): AgentSkillCatalogEntry {
  return {
    id: options.id ?? `user:${name}`,
    name,
    description: options.description ?? name,
    scope: options.scope ?? 'user',
    installed: options.installed ?? true,
    source: options.source ?? 'user',
    recommendedRoles: options.recommendedRoles ?? [],
    manualOnly: options.manualOnly
  }
}

describe('team skill defaults', () => {
  it('assigns only bounded role recommendations instead of every installed skill', () => {
    const skills = [
      skill('a'),
      skill('b'),
      skill('c', { manualOnly: true }),
      skill('d'),
      skill('e'),
      skill('f'),
      skill('g'),
      skill('h'),
      skill('i'),
      skill('create-subagent'),
      skill('shell'),
      skill('yeet'),
      skill('missing-installed', { installed: false })
    ]

    expect(defaultSkillIdsForRole(skills, {
      recommendedSkills: ['a', 'create-subagent', 'b', 'c', 'shell', 'd', 'e', 'f', 'g', 'h', 'i', 'yeet', 'missing-installed']
    })).toEqual(['user:a', 'user:b', 'user:d', 'user:e', 'user:f', 'user:g'])
  })

  it('keeps every built-in role template under the automatic assignment cap', () => {
    const installed = new Set(TEAM_ROLE_TEMPLATES.flatMap((template) => template.recommendedSkills))
    const skills = [...installed].map((name) => skill(name))

    for (const template of TEAM_ROLE_TEMPLATES) {
      const ids = defaultSkillIdsForRole(skills, template)
      expect(ids.length).toBeLessThanOrEqual(MAX_AUTO_SKILLS_PER_ROLE)
      expect(ids.some((id) => AUTO_SKILL_DENYLIST.has(id.replace(/^user:/, '')))).toBe(false)
    }
  })

  it('gives specialist seats a small useful default set', () => {
    const specialist = TEAM_ROLE_TEMPLATES.find((template) => template.key === 'specialist')!
    const skills = ['mcp-builder', 'webapp-testing', 'review', 'gh-fix-ci'].map((name) => skill(name))
    expect(defaultSkillIdsForRole(skills, specialist)).toEqual([
      'user:mcp-builder',
      'user:webapp-testing',
      'user:review',
      'user:gh-fix-ci'
    ])
  })
})
