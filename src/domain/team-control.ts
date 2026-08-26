import type { AgentSessionStatus } from './agent-session'
import {
  cursorComposerBindingMarker,
  type ComposerBindingMethod
} from './cursor-telemetry'
import type { AssignedAgentSkill } from './agent-skill'
import type { TeamFailoverRecord } from './team-failover'
import { TEAM_REPLY_STYLE_INSTRUCTION } from './team-reply-style'
import { QUNSHU_MCP_SERVER_NAME } from './channel-message'

export type TeamRunStatus =
  | 'draft'
  | 'ready'
  | 'launching'
  | 'running'
  | 'attention'
  | 'paused'
  | 'completed'

export type TeamRoleAccent = 'mint' | 'periwinkle' | 'apricot' | 'sky'

export type TeamLaunchStatus =
  | 'not_started'
  | 'sending'
  | 'delivered'
  | 'acknowledged'
  | 'uncertain'
  | 'failed'

export type TeamMemberReadiness =
  | 'unbound'
  | 'mcp_missing'
  | 'offline'
  | 'not_waiting'
  | 'ready'
  | 'launching'
  | 'active'
  | 'attention'

export interface TeamWorkspace {
  id: string
  name: string
  path: string
  createdAt: number
  updatedAt: number
}

export interface TeamRun {
  id: string
  workspaceId: string
  name: string
  goal: string
  templateId: string
  status: TeamRunStatus
  createdAt: number
  updatedAt: number
  launchedAt?: number
  /** 临时主控 SlotId：主控离线时由系统或手动指定，优先级高于角色模板。 */
  actingLeadSlotId?: string
}

export interface TeamRole {
  id: string
  runId: string
  key: string
  templateKey: string
  name: string
  mission: string
  instructions: string
  capabilities: string[]
  skills: AssignedAgentSkill[]
  accent: TeamRoleAccent
  order: number
}

/**
 * AgentSlot is the durable team member. A Cursor channel is only its current
 * runtime target and may be replaced by a later MCP generation.
 */
export interface AgentSlot {
  id: string
  runId: string
  roleId: string
  name: string
  avatarId: string
  channelId?: string
  order: number
  createdAt: number
  updatedAt: number
}

export interface RuntimeBinding {
  id: string
  workspaceId: string
  runId: string
  slotId: string
  channelId: string
  agentSessionId: string
  generation: string
  installedAt: number
  launchStatus: TeamLaunchStatus
  launchCommandId?: string
  launchDetail: string
  acknowledgedAt?: number
  lastCheckInAt?: number
  lastCheckInNote: string
  composerBindingKey: string
  composerId?: string
  composerBoundAt?: number
  composerBindingMethod?: ComposerBindingMethod
}

export interface TeamControlState {
  schemaVersion: 5
  revision: number
  activeWorkspaceId?: string
  workspaces: TeamWorkspace[]
  runs: TeamRun[]
  roles: TeamRole[]
  slots: AgentSlot[]
  bindings: RuntimeBinding[]
  updatedAt: number
}

export interface TeamMemberRuntime {
  channelId: string
  status: AgentSessionStatus
  online: boolean
  waiting: boolean
  queueDepth: number
  lastSeenAt?: number
  healthEvidence: string[]
  workingFiles: string[]
}

export interface TeamMemberView {
  slot: AgentSlot
  role: TeamRole
  binding?: RuntimeBinding
  runtime?: TeamMemberRuntime
  readiness: TeamMemberReadiness
}

export interface TeamPreflight {
  bridgeConnected: boolean
  workspaceBound: boolean
  goalDefined: boolean
  mcpInstalled: boolean
  agentsWaiting: boolean
  canLaunch: boolean
  blockers: string[]
}

export interface TeamRuntimeChannelView {
  channelId: string
  displayName: string
  status: AgentSessionStatus
  online: boolean
  waiting: boolean
  queueDepth: number
  registered: boolean
  assignedSlotId?: string
  agentSessionId?: string
  generation?: string
}

export interface TeamControlSnapshot extends TeamControlState {
  activeRun?: TeamRun
  members: TeamMemberView[]
  runtimeChannels: TeamRuntimeChannelView[]
  standbyChannels: TeamRuntimeChannelView[]
  failovers: TeamFailoverRecord[]
  preflight: TeamPreflight
}

export interface WorkspaceTeamBundle {
  workspace: TeamWorkspace
  run: TeamRun
  roles: TeamRole[]
  slots: AgentSlot[]
}

export interface TeamRoleTemplate {
  key: string
  name: string
  slotName: string
  mission: string
  instructions: string
  capabilities: string[]
  recommendedSkills: string[]
  accent: TeamRoleAccent
  avatarId: string
}

export const TEAM_ROLE_TEMPLATES: TeamRoleTemplate[] = [
  {
    key: 'lead',
    name: '主控协调',
    slotName: '主控席',
    mission: '在用户明确要求开始执行后，把团队目标拆成可验收任务，维护依赖与优先级，并协调成员而不是包办实现。',
    instructions: '启动后先确认上下文并待命；只有收到用户明确开始、分配、拆任务或执行指令后，才创建可独立验收的任务。持续关注阻塞、冲突与验收结果；没有明确必要时不要越过实现或质量角色的边界。',
    capabilities: ['coordination', 'planning'],
    recommendedSkills: ['review', 'split-to-prs', 'doc-coauthoring', 'discernment-nudge'],
    accent: 'mint',
    avatarId: 'lead'
  },
  {
    key: 'builder',
    name: '架构实现',
    slotName: '实现席',
    mission: '负责架构边界与核心实现，产出可运行、可测试、可交接的代码。',
    instructions: '只领取能力匹配且依赖已满足的任务。修改前核对接口与现有约束；提交时写清文件、测试和遗留风险，不把代码存在当作完成。',
    capabilities: ['code', 'architecture'],
    recommendedSkills: ['mcp-builder', 'vercel-composition-patterns', 'vercel-react-best-practices', 'webapp-testing', 'gh-fix-ci'],
    accent: 'periwinkle',
    avatarId: 'architect'
  },
  {
    key: 'reviewer',
    name: '质量验证',
    slotName: '验收席',
    mission: '独立验证行为、边界和回归风险，用证据决定通过或打回。',
    instructions: '不要复述实现者结论。依据验收标准检查实际结果、失败路径和回归范围；证据不足时明确打回原因与复现步骤。',
    capabilities: ['qa', 'testing'],
    recommendedSkills: ['review', 'review-bugbot', 'review-security', 'webapp-testing', 'security-best-practices', 'gh-address-comments'],
    accent: 'apricot',
    avatarId: 'reviewer'
  },
  {
    key: 'frontend',
    name: '前端体验',
    slotName: '体验席',
    mission: '负责用户界面、交互状态、可访问性与视觉一致性，交付可验证的真实界面。',
    instructions: '保持现有设计系统，不制造重复信息和空壳交互；修改后必须在真实渲染环境验证核心流程与控制台健康。',
    capabilities: ['code', 'frontend', 'ux'],
    recommendedSkills: ['frontend-design', 'web-design-guidelines', 'webapp-testing', 'vercel-react-best-practices', 'vercel-composition-patterns'],
    accent: 'mint',
    avatarId: 'frontend'
  },
  {
    key: 'backend',
    name: '后端实现',
    slotName: '后端席',
    mission: '负责领域逻辑、服务边界、数据持久化与接口可靠性。',
    instructions: '优先维护事务边界、幂等性和迁移兼容；提交时提供接口、数据与失败路径测试证据。',
    capabilities: ['code', 'backend', 'database'],
    recommendedSkills: ['mcp-builder', 'claude-api', 'security-best-practices', 'review-security', 'webapp-testing'],
    accent: 'periwinkle',
    avatarId: 'architect'
  },
  {
    key: 'devops',
    name: 'DevOps',
    slotName: '运维席',
    mission: '负责构建、发布、运行监控和故障恢复，保障交付流水线稳定。',
    instructions: '所有变更必须可回滚、可观测、可重复；不得在证据不足时修改生产环境。',
    capabilities: ['devops', 'deployment', 'observability'],
    recommendedSkills: ['cloudflare-deploy', 'deploy-to-vercel', 'vercel-deploy', 'vercel-optimize', 'gh-fix-ci', 'sentry'],
    accent: 'sky',
    avatarId: 'devops'
  },
  {
    key: 'researcher',
    name: '研究分析',
    slotName: '研究席',
    mission: '负责资料检索、方案比较、需求澄清与证据整理，为主控提供可靠输入。',
    instructions: '区分事实、推断与建议；优先使用一手来源并留下可复查引用，不直接越权修改实现。',
    capabilities: ['research', 'analysis', 'documentation'],
    recommendedSkills: ['notion-research-documentation', 'doc-coauthoring', 'writing-guidelines', 'openai-docs', 'pdf'],
    accent: 'sky',
    avatarId: 'researcher'
  },
  {
    key: 'product',
    name: '产品需求',
    slotName: '产品席',
    mission: '负责目标澄清、用户流程、约束和验收口径，减少团队返工。',
    instructions: '把模糊需求转成可验证行为与边界，不替实现角色决定技术细节。',
    capabilities: ['product', 'requirements', 'documentation'],
    recommendedSkills: ['notion-spec-to-implementation', 'doc-coauthoring', 'internal-comms', 'writing-guidelines', 'brand-guidelines'],
    accent: 'apricot',
    avatarId: 'researcher'
  },
  {
    key: 'specialist',
    name: '专项实现',
    slotName: '专项席',
    mission: '承接拆分后的专项任务，与其他实现角色保持接口一致并主动报告冲突。',
    instructions: '严格按任务边界工作；开始前确认依赖，提交时提供验证证据。发现跨模块冲突时先报告。',
    capabilities: ['code', 'implementation'],
    recommendedSkills: ['mcp-builder', 'webapp-testing', 'review', 'gh-fix-ci'],
    accent: 'sky',
    avatarId: 'devops'
  }
]

export const AGENT_AVATAR_IDS = ['lead', 'architect', 'reviewer', 'frontend', 'devops', 'researcher'] as const
export const ALL_TEAM_CAPABILITIES = [...new Set(
  TEAM_ROLE_TEMPLATES.flatMap((template) => template.capabilities)
)].sort()

export interface TeamMemberConfiguration {
  channelId: string
  roleTemplateKey: string
  avatarId: string
  skills: AssignedAgentSkill[]
}

function roleTemplateOf(key: string): TeamRoleTemplate {
  const template = TEAM_ROLE_TEMPLATES.find((candidate) => candidate.key === key.trim())
  if (!template) throw new Error(`未知团队角色模板：${key}`)
  return template
}

function uniqueChannelIds(values: string[]): string[] {
  return [...new Set(values.map(String).map((value) => value.trim()).filter((value) => /^\d+$/.test(value)))]
    .sort((left, right) => Number(left) - Number(right) || left.localeCompare(right))
}

export function emptyTeamControlState(): TeamControlState {
  return {
    schemaVersion: 5,
    revision: 0,
    workspaces: [],
    runs: [],
    roles: [],
    slots: [],
    bindings: [],
    updatedAt: Date.now()
  }
}

export function emptyTeamControlSnapshot(): TeamControlSnapshot {
  return {
    ...emptyTeamControlState(),
    members: [],
    runtimeChannels: [],
    standbyChannels: [],
    failovers: [],
    preflight: {
      bridgeConnected: false,
      workspaceBound: false,
      goalDefined: false,
      mcpInstalled: false,
      agentsWaiting: false,
      canLaunch: false,
      blockers: ['晴天通道尚未连接', '尚未绑定 Cursor 工作区']
    }
  }
}

export function createConfiguredTeamBundle(input: {
  workspaceId: string
  workspacePath: string
  workspaceName: string
  members: TeamMemberConfiguration[]
  runKey?: string
  now?: number
}): WorkspaceTeamBundle {
  const workspaceId = input.workspaceId.trim()
  const workspacePath = input.workspacePath.trim()
  const workspaceName = input.workspaceName.trim()
  if (!workspaceId || !workspacePath || !workspaceName) throw new Error('工作区信息不完整')

  const channelIds = uniqueChannelIds(input.members.map((member) => member.channelId))
  if (!channelIds.length || channelIds.length !== input.members.length) {
    throw new Error('团队通道不能为空、重复或无效')
  }
  const leadCount = input.members.filter((member) => member.roleTemplateKey === 'lead').length
  if (leadCount !== 1) throw new Error('团队必须且只能有 1 名主控协调')
  const now = input.now ?? Date.now()
  const runKey = input.runKey?.trim()
  if (runKey && !/^[a-zA-Z0-9_-]{8,80}$/.test(runKey)) throw new Error('TeamRun 标识无效')
  const runId = `team-run:${workspaceId}:${runKey ?? 'main'}`
  const identityScope = runKey ? `${workspaceId}:${runKey}` : workspaceId
  const occurrences = new Map<string, number>()
  const configured = input.members.map((member) => {
    const template = roleTemplateOf(member.roleTemplateKey)
    const count = (occurrences.get(template.key) ?? 0) + 1
    occurrences.set(template.key, count)
    const key = count === 1 && template.key !== 'specialist' ? template.key : `${template.key}-${count}`
    if (!AGENT_AVATAR_IDS.includes(member.avatarId as typeof AGENT_AVATAR_IDS[number])) {
      throw new Error(`未知 Agent 头像：${member.avatarId}`)
    }
    const skills = [...new Map(member.skills.map((skill) => [skill.id.trim(), {
      id: skill.id.trim(),
      name: skill.name.trim(),
      description: skill.description.trim().slice(0, 500),
      scope: skill.scope
    }])).values()].filter((skill) => skill.id && skill.name)
    return { member, template, key, skills, instanceNumber: count }
  })
  const roles: TeamRole[] = configured.map(({ template, key, skills, instanceNumber }, index) => ({
    id: `team-role:${identityScope}:${key}`,
    runId,
    key,
    templateKey: template.key,
    name: template.name
      + (template.key === 'specialist' || occurrences.get(template.key)! > 1 ? ` ${instanceNumber}` : ''),
    mission: template.mission,
    instructions: template.instructions,
    capabilities: [...template.capabilities],
    skills,
    accent: template.accent,
    order: index
  }))
  const slots: AgentSlot[] = roles.map((role, index) => ({
    id: `agent-slot:${identityScope}:${role.key}`,
    runId,
    roleId: role.id,
    name: configured[index]!.template.slotName
      + (role.templateKey === 'specialist' || occurrences.get(role.templateKey)! > 1 ? ` ${configured[index]!.instanceNumber}` : ''),
    avatarId: configured[index]!.member.avatarId,
    channelId: configured[index]!.member.channelId.trim(),
    order: index,
    createdAt: now,
    updatedAt: now
  }))

  return {
    workspace: {
      id: workspaceId,
      name: workspaceName,
      path: workspacePath,
      createdAt: now,
      updatedAt: now
    },
    run: {
      id: runId,
      workspaceId,
      name: `${workspaceName} · ${runKey ? '本轮运行' : '主运行'}`,
      goal: '',
      templateId: 'software-core-v1',
      status: 'draft',
      createdAt: now,
      updatedAt: now
    },
    roles,
    slots
  }
}

export function createDefaultTeamBundle(input: {
  workspaceId: string
  workspacePath: string
  workspaceName: string
  channelIds: string[]
  runKey?: string
  now?: number
}): WorkspaceTeamBundle {
  const channelIds = uniqueChannelIds(input.channelIds)
  return createConfiguredTeamBundle({
    ...input,
    members: channelIds.map((channelId, index) => {
      const templateKey = index === 0 ? 'lead' : index === 1 ? 'builder' : index === 2 ? 'reviewer' : 'specialist'
      const template = roleTemplateOf(templateKey)
      const avatarId = index < 3
        ? template.avatarId
        : AGENT_AVATAR_IDS[3 + ((index - 3) % (AGENT_AVATAR_IDS.length - 3))]!
      return { channelId, roleTemplateKey: templateKey, avatarId, skills: [] }
    }),
    runKey: input.runKey,
    now: input.now
  })
}

/**
 * 一句话启动提示（S4 底层注入）：作为 Cursor composer 唯一用户消息出现；
 * 角色职责/团队目标/协作规范全部经 MCP instructions 与 team_check_in
 * 返回值注入，不再占用会话可见内容。
 */
export function buildTeamLaunchHint(input: {
  channelId: string
  binding: RuntimeBinding
}): string {
  const { channelId, binding } = input
  return [
    `群枢协作通道 CH-${channelId} 已启动。`,
    `请先调用 ${QUNSHU_MCP_SERVER_NAME}.team_check_in({channel_id:'${channelId}'}) 领取角色职责与团队目标；`,
    `此后所有团队工具与通信保活均传同一 channel_id，并严格按 check_in 返回的指令工作。`,
    `本次 Cursor 会话绑定标记：${cursorComposerBindingMarker({ bindingKey: binding.composerBindingKey, channelId })}`
  ].join('')
}

/** 角色简报：team_check_in 完整返回，属工具输出而非会话内容。 */
export function buildTeamRoleBriefing(input: {
  run: TeamRun
  role: TeamRole
  slot: AgentSlot
  binding: RuntimeBinding
}): string {
  const { run, role, slot, binding } = input
  const channelId = binding.channelId
  const server = QUNSHU_MCP_SERVER_NAME
  const ch = `{channel_id:'${channelId}'}`
  const telemetryMarker = cursorComposerBindingMarker({
    bindingKey: binding.composerBindingKey,
    channelId
  })
  const roleWorkflow = role.templateKey === 'lead'
    ? `3. 调用 ${server}.team_list_board ${ch} 了解当前任务板；启动后即使任务板为空，也只进入待命，不要依据团队目标自行调用 team_plan_tasks。只有收到用户明确要求“开始 / 分配 / 拆任务 / 执行”后，才创建带依赖、验收标准和目标 AgentSlot 的计划。`
    : role.templateKey === 'reviewer'
      ? `3. 优先调用 ${server}.team_list_reviews ${ch} 并领取独立验收；没有待验收项时，再调用 team_list_mine / team_list_available 检查其他质量任务。`
      : `3. 调用 ${server}.team_list_mine ${ch}；有 leased/running 任务就继续，否则调用 team_list_available 并按能力领取。`
  const executionWorkflow = role.templateKey === 'reviewer'
    ? '4. 验收必须独立复现并检查验收标准；用 team_renew_review 续租，最后用 team_submit_review 提交通过证据或明确打回原因。'
    : '4. 领取后调用 team_start_task；每个里程碑（实现完成、测试完成、遇到阻塞、返工完成）都必须 team_report_progress 上报，长任务定期续租；完成后 submit_for_review，不能自行宣布验收通过。'
  const collaborationWorkflow = role.templateKey === 'lead'
    ? '5. 收件箱优先：每次被唤醒（check_messages 投递、任何 team 工具调用后）先调用 team_list_inbox 处理未读上报；成员的进度/提交/失败/验收是你调度的唯一依据，忽略上报即失职。收到重要上报必须立即推进下一步（安排验收、打回返工、收尾）；只有出现新的可执行结论、阻塞、需要用户决策或用户明确询问时，才用 record_reply 向用户同步 1—3 句。无未读、已读重复、纯 keepalive、单纯“继续监控/继续轮询”必须静默续等，禁止制造可见消息堵塞队列。用户要求“全体/各角色/多人”回答时必须 team_broadcast + team_collect_responses 收真实回应，禁止代答。'
    : '5. 每轮先处理未读消息：调用 team_list_inbox / team_read_message；directive 或 question 必须用 team_respond_message 回应原 messageId。进度与结论除自动同步外，关键节点必须主动向主控上报（team_report_progress / team_send_message），静默干活即失职。'
  const skills = role.skills.length
    ? `已分配 Agent Skills：${role.skills.map((skill) => `/${skill.name}`).join('、')}。只在任务相关时按 Cursor Skills 机制调用，不要把技能名称当作已完成工作。`
    : '当前席位没有单独指定 Agent Skill；仍可按 Cursor 自动发现机制使用工作区内相关技能。'
  return [
    `你是群枢外置协作中枢中的「${role.name}」Agent。`,
    `稳定身份：${slot.id}；本次可替换运行时：CH-${channelId}；TeamRun：${run.id}。`,
    `本次 Cursor 会话绑定标记：${telemetryMarker}`,
    `团队目标：${run.goal}`,
    `核心职责：${role.mission}`,
    `工作边界：${role.instructions}`,
    TEAM_REPLY_STYLE_INSTRUCTION,
    skills,
    `所有团队工具与通信保活工具只调用 ${server}，且每次传 ${ch}；禁止调用其他通道。`,
    '按顺序执行：',
    `1. 本简报即启动回执；随后调用 ${server}.team_get_context ${ch}，只读取本轮团队上下文快照（稳定成员目录、未读协作消息、本轮已确认记忆）；不要读取或复述 Cursor 历史聊天。若有未读消息，先读取并处理。聊天记录本身不是团队记忆。`,
    roleWorkflow,
    executionWorkflow,
    collaborationWorkflow,
    `6. 单点 Agent 间指令与回应使用 team_send_message/team_respond_message，以 messageId 建立回执；禁止使用普通回复或 ${server} 冒充成员已响应。`,
    `7. 发现会影响团队后续工作的决策、约束、风险或经验时，调用 team_memory_propose 并附消息、任务或文件来源；主控与质量角色应在协作过程中处理待确认提案，不要求用户整理记忆。`,
    `8. 每轮开始时自定 turn 标识；过程中每次工具调用/关键思考后调用 record_process 流式上报（同 block.id 翻转状态，界面实时渲染）；只有处理真实用户消息并输出完整可见回复后，才调用 ${server}.record_reply ${ch}（带同一 turn 归档本轮过程）同步给用户，再调用 ${server}.check_messages ${ch} 等待下一条消息。内部协作通知只用 team_* 回执处理，不算用户可见回复；${server}.check_messages 返回 keepalive、无未读或已读重复时，不要输出可见回复、不要 record_reply，直接静默继续等待。`,
    role.templateKey === 'lead'
      ? '9. 只有任务板已经由用户明确启动/分配后，才主动调度、催办（team_send_message 询问成员）或处理真实上报；空任务板表示等待用户下一条指令，不要自动拆任务。向用户说明现状只用于状态真的变化、出现阻塞或用户询问，禁止重复发送同一进展。'
      : '9. 遇到额度耗尽、工具缺失或无法推进的阻塞：立即向主控 team_send_message 上报阻塞原因并说明已尝试的步骤，禁止沉默卡死。',
    '如果额度耗尽、授权失败、工具缺失或出现不可恢复错误：明确报告一次并停止自动重试，禁止制造无限调用循环。'
  ].join('\n')
}
