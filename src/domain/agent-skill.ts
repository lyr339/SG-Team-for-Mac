export type AgentSkillScope = 'builtin' | 'project' | 'user'

export interface AssignedAgentSkill {
  id: string
  name: string
  description: string
  scope: AgentSkillScope
}

export interface AgentSkillCatalogEntry extends AssignedAgentSkill {
  installed: boolean
  source: 'cursor' | 'workspace' | 'user' | 'vercel' | 'anthropic'
  location?: string
  repository?: string
  recommendedRoles: string[]
  manualOnly?: boolean
}

export interface AgentSkillCatalog {
  scannedAt: number
  workspacePath: string
  entries: AgentSkillCatalogEntry[]
}
