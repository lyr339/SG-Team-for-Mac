import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CursorSkillCatalog } from '../src/infrastructure/cursor/cursor-skill-catalog'

function writeSkill(root: string, relativePath: string, frontmatter: string): void {
  const directory = join(root, relativePath)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), `---\n${frontmatter}\n---\n# Skill\n`)
}

describe('CursorSkillCatalog', () => {
  it('discovers nested project and user skills across every Cursor-compatible directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'qingtian-skill-catalog-'))
    const workspace = join(root, 'workspace')
    const userHome = join(root, 'home')
    mkdirSync(workspace, { recursive: true })
    writeSkill(workspace, '.cursor/skills/workflow/tdd', 'name: tdd\ndescription: Test-driven workflow for this project.')
    writeSkill(workspace, '.agents/skills/review/api-review', 'name: api-review\ndescription: Review API contracts and failure paths.')
    writeSkill(userHome, '.codex/skills/release', 'name: release\ndescription: Prepare safe releases.\ndisable-model-invocation: true')
    writeSkill(workspace, '.cursor/skills/invalid', 'name: INVALID NAME\ndescription: ignored')

    const catalog = new CursorSkillCatalog(userHome, () => 123).scan(workspace)
    expect(catalog).toMatchObject({ scannedAt: 123, workspacePath: workspace })
    expect(catalog.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'tdd', scope: 'project', source: 'workspace', installed: true }),
      expect.objectContaining({ name: 'api-review', scope: 'project', installed: true }),
      expect.objectContaining({ name: 'release', scope: 'user', manualOnly: true, installed: true }),
      expect.objectContaining({ name: 'review', scope: 'builtin', source: 'cursor', installed: true }),
      expect.objectContaining({ name: 'vercel-react-best-practices', source: 'vercel', installed: false }),
      expect.objectContaining({ name: 'mcp-builder', source: 'anthropic', installed: false })
    ]))
    expect(catalog.entries.some((entry) => entry.name === 'INVALID NAME')).toBe(false)
    expect(catalog.entries.length).toBeGreaterThanOrEqual(45)
  })

  it('lets an installed project skill override the same recommendation', () => {
    const root = mkdtempSync(join(tmpdir(), 'qingtian-skill-override-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeSkill(workspace, '.cursor/skills/mcp-builder', 'name: mcp-builder\ndescription: Project-specific MCP conventions.')
    const catalog = new CursorSkillCatalog(join(root, 'home')).scan(workspace)
    expect(catalog.entries.filter((entry) => entry.name === 'mcp-builder')).toEqual([
      expect.objectContaining({ installed: true, source: 'workspace', description: 'Project-specific MCP conventions.' })
    ])
  })

  it('parses large skills with YAML block chomping indicators', () => {
    const root = mkdtempSync(join(tmpdir(), 'qingtian-skill-large-'))
    const workspace = join(root, 'workspace')
    const userHome = join(root, 'home')
    mkdirSync(workspace, { recursive: true })
    writeSkill(userHome, '.codex/skills/large-reference', [
      'name: large-reference',
      'description: |-',
      `  ${'Large reference skill. '.repeat(4_000)}`
    ].join('\n'))

    const catalog = new CursorSkillCatalog(userHome).scan(workspace)
    expect(catalog.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'large-reference',
        installed: true,
        source: 'user',
        description: expect.stringContaining('Large reference skill.')
      })
    ]))
  })
})
