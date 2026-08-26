import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import type { AgentSkillCatalog, AgentSkillCatalogEntry, AgentSkillScope } from '../../domain/agent-skill'

const MAX_SKILLS = 500
const MAX_SKILL_FILE_BYTES = 256 * 1_024

type CatalogSeed = Pick<
  AgentSkillCatalogEntry,
  'name' | 'description' | 'source' | 'repository' | 'recommendedRoles' | 'manualOnly'
>

const CURSOR_BUILTINS: CatalogSeed[] = [
  ['automate', '创建由计划、Slack、GitHub 等事件触发的 Cursor 自动化。', ['lead', 'devops']],
  ['babysit', '持续监控 PR 并处理反馈、冲突和失败检查。', ['lead', 'reviewer', 'devops']],
  ['canvas', '创建可交互 React 工件。', ['frontend', 'product']],
  ['create-hook', '创建 Agent 生命周期 Hook。', ['devops', 'builder']],
  ['create-rule', '创建作用域明确的 Cursor Rule。', ['lead', 'builder']],
  ['create-skill', '创建符合规范的 Agent Skill。', ['lead', 'researcher']],
  ['create-subagent', '创建具有聚焦职责的自定义子 Agent。', ['lead']],
  ['cursor-blame', '调查 AI 生成变更及其提示来源。', ['reviewer', 'lead']],
  ['loop', '按指定间隔重复执行提示或技能。', ['devops', 'reviewer']],
  ['migrate-to-skills', '把动态规则和命令迁移为 Agent Skills。', ['lead']],
  ['review', '选择并执行适合的代码审查流程。', ['reviewer', 'lead']],
  ['review-bugbot', '使用 Bugbot 检查缺陷和回归。', ['reviewer']],
  ['review-security', '执行安全漏洞审查。', ['reviewer', 'backend']],
  ['sdk', '构建 Cursor SDK 应用与集成。', ['builder', 'backend']],
  ['shell', '把给定文本作为 shell 命令运行。', ['builder', 'devops']],
  ['split-to-prs', '把大型变更拆成更小的 Pull Request。', ['lead', 'builder']],
  ['statusline', '配置 Cursor CLI 状态栏。', ['devops']],
  ['update-cli-config', '更新 Cursor CLI 配置。', ['devops']],
  ['update-cursor-settings', '定位并更新 Cursor 或 VS Code 设置。', ['devops', 'frontend']]
].map(([name, description, recommendedRoles]) => ({
  name: name as string,
  description: description as string,
  source: 'cursor' as const,
  repository: 'https://cursor.com/docs/skills',
  recommendedRoles: recommendedRoles as string[],
  manualOnly: false
}))

const VERCEL_RECOMMENDED: CatalogSeed[] = [
  ['vercel-composition-patterns', '可扩展的 React 组合与组件 API 模式。', ['frontend', 'builder']],
  ['deploy-to-vercel', '把应用部署到 Vercel 并返回可访问地址。', ['devops']],
  ['vercel-react-best-practices', 'React 与 Next.js 性能和工程最佳实践。', ['frontend', 'builder', 'reviewer']],
  ['vercel-react-native-skills', 'React Native 与 Expo 性能实践。', ['frontend']],
  ['vercel-react-view-transitions', '使用 React View Transition API 构建原生感过渡。', ['frontend']],
  ['vercel-cli-with-tokens', '使用令牌安全操作 Vercel CLI。', ['devops']],
  ['vercel-optimize', '基于真实指标优化 Vercel 成本和性能。', ['devops', 'backend']],
  ['web-design-guidelines', '审查界面、可访问性和 Web 设计规范。', ['frontend', 'reviewer']],
  ['writing-guidelines', '审查文档和产品文字质量。', ['researcher', 'product', 'reviewer']]
].map(([name, description, recommendedRoles]) => ({
  name: name as string,
  description: description as string,
  source: 'vercel' as const,
  repository: 'https://github.com/vercel-labs/agent-skills',
  recommendedRoles: recommendedRoles as string[]
}))

const ANTHROPIC_RECOMMENDED: CatalogSeed[] = [
  ['academy-guide', '查找产品课程和学习资料。', ['researcher']],
  ['claude-api', 'Claude API、SDK、工具调用与模型配置参考。', ['backend', 'builder']],
  ['discernment-nudge', '在重要建议后追问事实、假设和遗漏。', ['lead', 'product', 'reviewer']],
  ['docx', '创建、读取和编辑 Word 文档。', ['researcher', 'product']],
  ['pdf', '读取、创建、检查和处理 PDF。', ['researcher']],
  ['pptx', '创建、读取和编辑演示文稿。', ['researcher', 'product']],
  ['xlsx', '创建、读取和分析电子表格。', ['researcher']],
  ['algorithmic-art', '使用 p5.js 创建确定性生成艺术。', ['frontend']],
  ['brand-guidelines', '应用一致的品牌颜色和字体规范。', ['frontend', 'product']],
  ['canvas-design', '创建精致静态视觉设计。', ['frontend']],
  ['doc-coauthoring', '结构化共创技术文档、提案和设计说明。', ['lead', 'researcher', 'product']],
  ['frontend-design', '构建具有明确视觉方向的真实产品界面。', ['frontend']],
  ['internal-comms', '撰写状态、事故、管理层更新等内部沟通。', ['lead', 'product']],
  ['mcp-builder', '设计和实现高质量 MCP Server。', ['backend', 'builder']],
  ['skill-creator', '创建、优化并评估 Agent Skill。', ['lead', 'researcher']],
  ['slack-gif-creator', '创建适合 Slack 的动画 GIF。', ['frontend']],
  ['theme-factory', '为文档、幻灯片和网页建立一致主题。', ['frontend', 'product']],
  ['web-artifacts-builder', '使用 React 等技术构建复杂 HTML 工件。', ['frontend', 'builder']],
  ['webapp-testing', '使用 Playwright 检查本地 Web 应用。', ['reviewer', 'frontend']]
].map(([name, description, recommendedRoles]) => ({
  name: name as string,
  description: description as string,
  source: 'anthropic' as const,
  repository: 'https://github.com/anthropics/skills',
  recommendedRoles: recommendedRoles as string[]
}))

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseSkillFile(path: string): { name: string; description: string; manualOnly: boolean } | undefined {
  if (statSync(path).size > MAX_SKILL_FILE_BYTES) return undefined
  const text = readFileSync(path, 'utf8')
  if (!text.startsWith('---')) return undefined
  const end = text.indexOf('\n---', 3)
  if (end < 0) return undefined
  const frontmatter = text.slice(3, end).split(/\r?\n/)
  const valueOf = (key: string): string => {
    const index = frontmatter.findIndex((line) => line.trimStart().startsWith(`${key}:`))
    if (index < 0) return ''
    const first = frontmatter[index]!.split(':').slice(1).join(':').trim()
    if (first && !/^[>|][+-]?$/.test(first)) return unquote(first)
    const continuation: string[] = []
    for (let cursor = index + 1; cursor < frontmatter.length; cursor += 1) {
      const line = frontmatter[cursor]!
      if (line && !/^\s/.test(line)) break
      if (line.trim()) continuation.push(line.trim())
    }
    return continuation.join(' ')
  }
  const name = valueOf('name') || basename(join(path, '..'))
  const description = valueOf('description')
  if (!/^[a-z0-9-]{1,100}$/.test(name) || !description) return undefined
  return {
    name,
    description: description.slice(0, 1_000),
    manualOnly: valueOf('disable-model-invocation') === 'true'
  }
}

function skillFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  const pending = [root]
  const visited = new Set<string>()
  while (pending.length && files.length < MAX_SKILLS) {
    const current = pending.pop()!
    let real: string
    try {
      real = realpathSync(current)
    } catch {
      continue
    }
    if (visited.has(real)) continue
    visited.add(real)
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory() || entry.isSymbolicLink() && existsSync(path) && statSync(path).isDirectory()) {
        pending.push(path)
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        files.push(path)
      }
    }
  }
  return files
}

function localEntries(root: string, scope: Exclude<AgentSkillScope, 'builtin'>): AgentSkillCatalogEntry[] {
  return skillFiles(root).flatMap((path) => {
    const parsed = parseSkillFile(path)
    if (!parsed) return []
    return [{
      id: `${scope}:${realpathSync(path)}`,
      name: parsed.name,
      description: parsed.description,
      scope,
      installed: true,
      source: scope === 'project' ? 'workspace' : 'user',
      location: path,
      recommendedRoles: [],
      manualOnly: parsed.manualOnly
    }]
  })
}

export class CursorSkillCatalog {
  constructor(
    private readonly userHome = homedir(),
    private readonly now: () => number = Date.now
  ) {}

  scan(workspacePath: string): AgentSkillCatalog {
    const workspaceRoots = ['.codex/skills', '.claude/skills', '.agents/skills', '.cursor/skills']
    const userRoots = ['.codex/skills', '.claude/skills', '.agents/skills', '.cursor/skills']
    const discoveredLocal = [
      ...workspaceRoots.flatMap((path) => localEntries(join(workspacePath, path), 'project')),
      ...userRoots.flatMap((path) => localEntries(join(this.userHome, path), 'user'))
    ]
    const local = [...new Map(discoveredLocal.map((entry) => [`${entry.scope}:${entry.name}`, entry])).values()]
    const installedNames = new Set(local.map((entry) => entry.name))
    const builtins: AgentSkillCatalogEntry[] = CURSOR_BUILTINS.map((seed) => ({
      ...seed,
      id: `builtin:${seed.name}`,
      scope: 'builtin',
      installed: true
    }))
    for (const entry of builtins) installedNames.add(entry.name)
    const recommended = [...VERCEL_RECOMMENDED, ...ANTHROPIC_RECOMMENDED]
      .filter((seed) => !installedNames.has(seed.name))
      .map((seed): AgentSkillCatalogEntry => ({
        ...seed,
        id: `recommended:${seed.source}:${seed.name}`,
        scope: 'project',
        installed: false
      }))
    const priority = (entry: AgentSkillCatalogEntry): number => {
      if (entry.scope === 'project' && entry.installed) return 0
      if (entry.scope === 'user' && entry.installed) return 1
      if (entry.scope === 'builtin') return 2
      return 3
    }
    return {
      scannedAt: this.now(),
      workspacePath,
      entries: [...local, ...builtins, ...recommended]
        .sort((left, right) => priority(left) - priority(right) || left.name.localeCompare(right.name))
    }
  }
}
