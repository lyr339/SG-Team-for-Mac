/**
 * 设计走查入口：mock 掉 preload API，在纯浏览器里渲染完整应用。
 * 仅供 preview.html 使用，不进入生产构建，不连接任何端口。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { AccountAutomationRun } from '../../../domain/account-automation'
import type { ConversationEntry } from '../../../domain/conversation-entry'
import { AGENT_AVATAR_IDS, TEAM_ROLE_TEMPLATES, createConfiguredTeamBundle, emptyTeamControlSnapshot } from '../../../domain/team-control'
import type { TeamRunStatus } from '../../../domain/team-control'
import type { QingtianDesktopApi, TeamSetupDraft } from '../../../shared/desktop-api'
import { App } from '../App'
import { applyAppearancePreferences, readAppearancePreferences } from '../appearance-preferences'
import {
  collaborationSnapshot,
  continuitySnapshot,
  desktopSnapshot,
  memorySnapshot,
  taskPoolSnapshot,
  teamControlSnapshot
} from './mock-data'
import '../claude-theme.css'
import '../styles.css'
import '../team-v2.css'
import '../team-setup.css'
import '../lobby/lobby.css'
import '../controls.css'
import '../workspace-inspector.css'

type Listener<T> = (snapshot: T) => void

const previewParameters = new URLSearchParams(window.location.search)
const setupMode = previewParameters.get('setup') === '1'
const detectedWorkspaceMode = previewParameters.get('detectedWorkspace') === '1'
const activeExecutingMode = previewParameters.get('activeExecuting') === '1'
const manualHandoffMode = previewParameters.get('handoff') === '1'
const offlineSessionsPreviewMode = previewParameters.get('offlineSessions') === '1'
const messageFormatPreviewMode = previewParameters.get('messageFormat') === '1'
const requestedRunStatus = previewParameters.get('runStatus')
// 账号自动化走查场景：?automation=countdown|processing|importing|deleting|done|failed|cancelled
const automationScene = (['countdown', 'processing', 'importing', 'deleting', 'done', 'failed', 'cancelled'] as const)
  .find((phase) => phase === previewParameters.get('automation'))
const previewNow = Date.now()
const automationSceneRun: AccountAutomationRun | undefined = automationScene ? ({
  countdown: { phase: 'countdown', message: '将在 6.5s 后自动处理当前账号（可取消）', remainingSec: 6.5, planId: 'preview-plan', startedAt: previewNow - 3_500 },
  processing: { phase: 'processing', message: '奥仔：正在提交 Session Token 处理…', planId: 'preview-plan', startedAt: previewNow - 12_000 },
  importing: { phase: 'importing', message: '会话已失效，正在刷新浏览器会话获取新 Token…', planId: 'preview-plan', startedAt: previewNow - 26_000 },
  deleting: { phase: 'deleting', message: '奥仔已完成，正在刷新浏览器会话并秒级加固账号…', planId: 'preview-plan', startedAt: previewNow - 31_000 },
  done: { phase: 'done', message: '自动化完成：已处理、账号已加固（浏览器会话内秒级执行）、本地记录已移除', planId: 'preview-plan', startedAt: previewNow - 47_000, finishedAt: previewNow - 5_000 },
  failed: { phase: 'failed', message: '奥仔处理失败：卡密余额不足，请先充值或更换卡密（本地账号已保留）', planId: 'preview-plan', startedAt: previewNow - 22_000, finishedAt: previewNow - 8_000 },
  cancelled: { phase: 'cancelled', message: '已取消本次自动化', planId: 'preview-plan', startedAt: previewNow - 9_000, finishedAt: previewNow - 4_000 }
} as const)[automationScene] : undefined
const previewRunStatus = (['draft', 'ready', 'launching', 'running', 'attention', 'paused', 'completed'] as TeamRunStatus[])
  .find((status) => status === requestedRunStatus)
const setupSkill = (name: string, description: string, source: 'cursor' | 'workspace' | 'user' | 'vercel' | 'anthropic', installed = true) => ({
  id: installed ? `${source}:${name}` : `recommended:${source}:${name}`,
  name,
  description,
  scope: source === 'cursor' ? 'builtin' as const : source === 'user' ? 'user' as const : 'project' as const,
  installed,
  source,
  recommendedRoles: [] as string[]
})
const setupDraft: TeamSetupDraft = {
  draftId: 'preview-team-setup',
  workspaceId: 'wedge-demo',
  workspaceName: 'wedge-demo',
  workspacePath: '/Users/demo/Workspace/wedge-demo',
  channels: Array.from({ length: 5 }, (_, index) => ({
    channelId: String(index + 1),
    displayName: `SG Team CH-${index + 1}`,
    status: offlineSessionsPreviewMode ? 'offline' as const : index === 2 || index === 4 ? 'idle' as const : 'waiting' as const,
    online: !offlineSessionsPreviewMode,
    waiting: !offlineSessionsPreviewMode && index !== 2 && index !== 4,
    queueDepth: index === 1 ? 1 : 0
  })),
  roleTemplates: structuredClone(TEAM_ROLE_TEMPLATES),
  avatarIds: [...AGENT_AVATAR_IDS],
  cursorModels: structuredClone(desktopSnapshot.cursorModels ?? []),
  skills: [
    setupSkill('review', '自动选择并执行代码审查流程。', 'cursor'),
    setupSkill('review-security', '检查安全漏洞与权限边界。', 'cursor'),
    setupSkill('split-to-prs', '把大型变更拆成可审查 PR。', 'cursor'),
    setupSkill('frontend-design', '构建具有明确视觉方向的真实界面。', 'workspace'),
    setupSkill('webapp-testing', '使用 Playwright 验证本地界面。', 'workspace'),
    setupSkill('mcp-builder', '设计和实现高质量 MCP Server。', 'user'),
    setupSkill('doc-coauthoring', '结构化共创技术说明。', 'user'),
    setupSkill('vercel-react-best-practices', 'React 性能和工程最佳实践。', 'vercel', false),
    setupSkill('web-design-guidelines', '审查 Web 设计与可访问性。', 'vercel', false)
  ]
}
const detectedSetupDraft: TeamSetupDraft = detectedWorkspaceMode ? {
  ...structuredClone(setupDraft),
  draftId: 'preview-detected-workspace',
  workspaceId: 'detected-property-app',
  workspaceName: '物业管理',
  workspacePath: '/Users/demo/Workspace/物业管理',
  channels: setupDraft.channels.slice(0, 4)
} : setupDraft

const initialTeam = structuredClone(setupMode ? emptyTeamControlSnapshot() : teamControlSnapshot)
if (activeExecutingMode && initialTeam.activeRun) {
  initialTeam.members = initialTeam.members.map((member) => ({
    ...member,
    runtime: member.runtime ? { ...member.runtime, online: true, waiting: false } : member.runtime,
    readiness: 'active' as const
  }))
  initialTeam.preflight = {
    ...initialTeam.preflight,
    agentsWaiting: false,
    canLaunch: false,
    blockers: ['并非所有 Agent 通道都已在线待命', '团队已经运行']
  }
}
if (previewRunStatus && initialTeam.activeRun) {
  initialTeam.activeRun = { ...initialTeam.activeRun, status: previewRunStatus }
  initialTeam.runs = initialTeam.runs.map((run) => (
    run.id === initialTeam.activeRun?.id ? { ...run, status: previewRunStatus } : run
  ))
  if (previewRunStatus === 'launching') {
    initialTeam.bindings = initialTeam.bindings.map((binding, index) => ({
      ...binding,
      launchStatus: index === 0 ? 'acknowledged' as const : 'delivered' as const
    }))
    initialTeam.members = initialTeam.members.map((member, index) => ({
      ...member,
      binding: member.binding ? {
        ...member.binding,
        launchStatus: index === 0 ? 'acknowledged' as const : 'delivered' as const
      } : member.binding,
      readiness: index === 0 ? 'active' as const : 'launching' as const
    }))
  } else if (previewRunStatus === 'completed') {
    initialTeam.members = initialTeam.members.map((member) => ({
      ...member,
      runtime: member.runtime ? { ...member.runtime, online: false, waiting: false } : member.runtime,
      readiness: 'offline' as const
    }))
    initialTeam.runtimeChannels = initialTeam.runtimeChannels.map((channel) => ({
      ...channel,
      online: false,
      waiting: false,
      status: 'offline' as const
    }))
    initialTeam.standbyChannels = initialTeam.standbyChannels.map((channel) => ({
      ...channel,
      online: false,
      waiting: false,
      status: 'offline' as const
    }))
  }
  initialTeam.preflight = {
    ...initialTeam.preflight,
    mcpInstalled: false,
    agentsWaiting: false,
    canLaunch: false,
    blockers: ['Agent MCP 尚未接入全部本轮通道', '并非所有 Agent 通道都已在线待命']
  }
}
if (manualHandoffMode && initialTeam.activeRun) {
  initialTeam.activeRun = { ...initialTeam.activeRun, status: 'attention' }
  initialTeam.runs = initialTeam.runs.map((run) => run.id === initialTeam.activeRun?.id ? { ...run, status: 'attention' } : run)
  initialTeam.members = initialTeam.members.map((member, index) => ({
    ...member,
    runtime: member.runtime ? {
      ...member.runtime,
      online: index !== 0,
      waiting: index !== 0,
      queueDepth: 0,
      status: index === 0 ? 'offline' as const : 'waiting' as const
    } : member.runtime,
    readiness: index === 0 ? 'offline' as const : 'active' as const
  }))
  initialTeam.runtimeChannels = initialTeam.runtimeChannels.map((channel, index) => ({
    ...channel,
    online: index !== 0,
    waiting: index !== 0,
    queueDepth: 0,
    status: index === 0 ? 'offline' as const : 'waiting' as const
  }))
  initialTeam.standbyChannels = []
}

const state = {
  desktop: structuredClone(desktopSnapshot),
  memory: structuredClone(memorySnapshot),
  team: initialTeam
}
if (messageFormatPreviewMode) {
  const example = state.desktop.conversations['2']?.find((entry) => entry.id === 'e5')
  state.desktop.conversations = example ? { '2': [example] } : {}
}
if (previewRunStatus === 'completed') {
  state.desktop.sessions = state.desktop.sessions.map((session) => ({
    ...session,
    status: 'offline',
    online: false,
    connected: false,
    waiting: false
  }))
  state.team.members = state.team.members.map((member) => ({
    ...member,
    runtime: member.runtime ? {
      ...member.runtime,
      status: 'offline',
      online: false,
      waiting: false,
      connectionPhase: 'cursor_stopped'
    } : member.runtime,
    readiness: 'offline'
  }))
}
if (offlineSessionsPreviewMode) {
  const template = state.desktop.sessions[0]!
  const existing = new Set(state.desktop.sessions.map((session) => session.channelId))
  state.desktop.sessions = [
    ...state.desktop.sessions,
    ...detectedSetupDraft.channels
      .filter((channel) => !existing.has(channel.channelId))
      .map((channel) => ({
        ...template,
        id: `preview-channel-${channel.channelId}`,
        channelId: channel.channelId,
        displayName: channel.displayName,
        roleName: '未绑定外置团队'
      }))
  ].map((session) => ({
    ...session,
    status: 'offline',
    online: false,
    connected: false,
    waiting: false,
    queueDepth: 0
  }))
}
if (manualHandoffMode) {
  state.desktop.sessions = state.desktop.sessions.map((session, index) => ({
    ...session,
    status: index === 0 ? 'offline' : 'waiting',
    online: index !== 0,
    connected: index !== 0,
    waiting: index !== 0,
    queueDepth: 0
  }))
}
const previewTasks = structuredClone(taskPoolSnapshot)
if (previewRunStatus === 'completed') {
  for (const task of Object.values(previewTasks.tasks)) {
    if (!['done', 'failed', 'cancelled'].includes(task.status)) {
      task.status = 'cancelled'
      task.failureReason = '本轮全部 Agent 已离线，未完成任务自动取消'
    }
  }
  for (const attempt of Object.values(previewTasks.attempts)) {
    if (['leased', 'running', 'review'].includes(attempt.status)) attempt.status = 'cancelled'
  }
  for (const review of Object.values(previewTasks.reviews)) {
    if (review.status === 'queued' || review.status === 'leased') review.status = 'cancelled'
  }
}
const desktopListeners = new Set<Listener<typeof state.desktop>>()
const memoryListeners = new Set<Listener<typeof state.memory>>()
const teamListeners = new Set<Listener<typeof state.team>>()
let previewCursorAccounts: Array<{
  id: string; label: string; maskedToken: string; active: boolean; createdAt: number; updatedAt: number
}> = [
  { id: 'preview-acc-1', label: 'work@example.com', maskedToken: '••••9f2k', active: true, createdAt: previewNow - 40 * 60_000, updatedAt: previewNow - 5 * 60_000 },
  { id: 'preview-acc-2', label: 'spare@example.com', maskedToken: '••••41qz', active: false, createdAt: previewNow - 90 * 60_000, updatedAt: previewNow - 30 * 60_000 }
]

function pushDesktop(): void {
  state.desktop = { ...state.desktop, updatedAt: Date.now() }
  for (const listener of desktopListeners) listener(structuredClone(state.desktop))
}

function pushMemory(): void {
  state.memory = { ...state.memory, revision: state.memory.revision + 1, updatedAt: Date.now() }
  for (const listener of memoryListeners) listener(structuredClone(state.memory))
}

function pushTeam(): void {
  for (const listener of teamListeners) listener(structuredClone(state.team))
}

const api: QingtianDesktopApi = {
  listCursorAccounts: async () => structuredClone(previewCursorAccounts),
  saveCursorAccount: async ({ label, token }) => {
    const at = Date.now()
    previewCursorAccounts = previewCursorAccounts.map((account) => ({ ...account, active: false }))
    previewCursorAccounts.push({
      id: `preview-cursor-account-${at}`,
      label: label.trim(),
      maskedToken: `••••${token.trim().slice(-4)}`,
      active: true,
      createdAt: at,
      updatedAt: at
    })
    return structuredClone(previewCursorAccounts)
  },
  selectCursorAccount: async (accountId) => {
    previewCursorAccounts = previewCursorAccounts.map((account) => ({ ...account, active: account.id === accountId }))
    return structuredClone(previewCursorAccounts)
  },
  removeCursorAccount: async (accountId) => {
    const wasActive = previewCursorAccounts.find((account) => account.id === accountId)?.active
    previewCursorAccounts = previewCursorAccounts.filter((account) => account.id !== accountId)
    if (wasActive && previewCursorAccounts[0]) previewCursorAccounts[0].active = true
    return structuredClone(previewCursorAccounts)
  },
  importCursorAccountFromLocalCursor: async () => {
    return api.saveCursorAccount({
      label: 'preview@example.com（本机 Cursor）',
      token: 'preview-local-cursor-token'
    })
  },
  importCursorAccountFromBrowser: async () => {
    return api.saveCursorAccount({
      label: 'user_preview_0001（Microsoft Edge）',
      token: 'user_preview_0001::preview-browser-token'
    })
  },
  restartCursorWithAccount: async () => ({
    switched: true,
    killedCursor: true,
    relaunchMode: 'cdp' as const,
    cdpPortReady: true,
    machineIdentityApplied: true,
    runtimeVerified: true,
    backupDir: `/backup/account-switch-${Date.now()}`
  }),
  verifyCursorRuntimeAccount: async () => ({ status: 'matched' as const, cursorLabel: 'preview@cursor.com', activeLabel: 'preview@cursor.com' }),
  refreshCursorMembership: async () => ({ state: 'ok' as const, profile: { tier: 'pro' as const, raw: 'pro', trialEligible: false, isTeamMember: false, lastPaymentFailed: false, fetchedAt: Date.now() } }),
  refreshCursorAccountMemberships: async (accountIds) => Object.fromEntries(
    previewCursorAccounts
      .filter((account) => !accountIds || accountIds.includes(account.id))
      .map((account, index) => [account.id, {
        state: 'ok' as const,
        profile: { tier: index === 0 ? 'free' as const : 'pro' as const, raw: index === 0 ? 'free' : 'pro', fetchedAt: Date.now() }
      }])
  ),
  getAozaiCardStatus: async () => automationSceneRun
    ? { saved: true, maskedCode: '••••6l8Q', type: '50次卡', remaining: 46 }
    : { saved: false },
  saveAozaiCard: async () => ({ saved: true, maskedCode: '••••6l8Q', type: '50次卡', remaining: 46 }),
  clearAozaiCard: async () => ({ saved: false }),
  refreshAozaiBalance: async () => ({ saved: true, maskedCode: '••••6l8Q', type: '50次卡', remaining: 46 }),
  processAozaiAccount: async () => ({ ok: true, message: '处理成功', remaining: 45 }),
  onAozaiProgress: () => () => {},
  launchAgentSessions: async (requests) => ({
    id: 'preview-launch',
    state: 'done',
    items: requests.map((request) => ({
      channelId: request.channelId,
      modelSelection: request.modelSelection,
      stage: 'done' as const,
      message: '会话已就绪',
      composerId: `preview-composer-${request.channelId}`
    })),
    startedAt: Date.now(),
    finishedAt: Date.now()
  }),
  getAgentLaunchPlan: async () => undefined,
  onAgentLaunchProgress: () => () => {},
  enableCursorCdp: async () => ({ ok: true, message: 'Cursor 已重启并启用会话创建端口（9333）' }),
  getCursorCdpSettings: async () => ({ autoHealEnabled: false }),
  saveCursorCdpSettings: async (settings) => settings,
  getCursorUpdatePreferences: async () => ({
    settingsPath: '/Users/demo/Library/Application Support/Cursor/User/settings.json',
    updateMode: undefined,
    autoUpdateDisabled: false,
    settingsExists: true
  }),
  setCursorAutoUpdateDisabled: async (disabled) => ({
    settingsPath: '/Users/demo/Library/Application Support/Cursor/User/settings.json',
    updateMode: disabled ? 'none' : undefined,
    autoUpdateDisabled: disabled,
    settingsExists: true,
    changed: true
  }),
  cancelCdpAutoHealCountdown: async () => {},
  onCdpAutoHealEvent: () => () => {},
  getAccountAutomationSettings: async () => ({ enabled: Boolean(automationSceneRun), delaySec: 10, postProcessDelaySec: 10 }),
  saveAccountAutomationSettings: async (settings) => settings,
  getAccountAutomationRun: async () => automationSceneRun ?? { phase: 'idle' as const, message: '', startedAt: 0 },
  cancelAccountAutomation: async () => ({ phase: 'cancelled' as const, message: '已取消本次自动化', startedAt: 0, finishedAt: Date.now() }),
  listAccountAutomationBitProfiles: async () => ({
    ok: true,
    profiles: [
      { id: 'bit-proxy', name: '代理', seq: 1 },
      { id: 'bit-direct', name: '直连', seq: 2 }
    ]
  }),
  getAccountAutomationRoxyApiKey: async () => ({ saved: true, maskedKey: '6192****eada' }),
  saveAccountAutomationRoxyApiKey: async () => ({ saved: true, maskedKey: '6192****eada' }),
  importCursorAccountFromFingerprint: async () => {
    return api.saveCursorAccount({
      label: 'user_preview_0001（Roxy指纹）',
      token: 'user_preview_0001::preview-fingerprint-token'
    })
  },
  openFingerprintLoginPage: async () => {},
  cleanupFingerprintEnvironment: async () => {},
  acknowledgeCursorModelDataPolicies: async () => ({
    changed: false,
    tokenUpdated: false,
    modelIds: ['claude-fable-5'],
    message: 'claude-fable-5 的数据政策已确认，无需重复提交'
  }),
  onAccountAutomationProgress: () => () => {},
  getSnapshot: async () => structuredClone(state.desktop),
  sendMessage: async ({ channelId, text }) => {
    const entry: ConversationEntry = {
      id: `preview-${Date.now()}`,
      channelId,
      role: 'user',
      text,
      timestamp: Date.now(),
      status: 'complete',
      source: 'desktop'
    }
    state.desktop.conversations = {
      ...state.desktop.conversations,
      [channelId]: [...(state.desktop.conversations[channelId] ?? []), entry]
    }
    pushDesktop()
    return { commandId: entry.id }
  },
  getTaskPoolSnapshot: async () => structuredClone(previewTasks),
  installTaskMcp: async () => ({
    ok: true,
    workspacePath: detectedSetupDraft.workspacePath,
    workspaceId: detectedSetupDraft.workspaceId,
    runId: state.team.activeRun?.id ?? 'preview-run',
    configPath: `${detectedSetupDraft.workspacePath}/.cursor/mcp.json`,
    serverNames: ['SG Team'],
    autoInjected: true,
    restartRequired: false
  }),
  getTeamControlSnapshot: async () => structuredClone(state.team),
  detectCursorWorkspace: async () => ({
    state: 'detected',
    source: 'running-qingtian-mcp',
    confidence: 'certain',
    workspace: {
      id: detectedSetupDraft.workspaceId,
      name: detectedSetupDraft.workspaceName,
      path: detectedSetupDraft.workspacePath,
      cursorWorkspaceId: 'preview-cursor-workspace',
      channelIds: detectedSetupDraft.channels.map((channel) => channel.channelId)
    },
    candidates: [],
    detail: '预览中的 Cursor 工作区',
    observedAt: Date.now()
  }),
  prepareDetectedTeamWorkspace: async () => setupMode || detectedWorkspaceMode
    ? ({ kind: 'setup', draft: structuredClone(detectedSetupDraft) })
    : ({ kind: 'existing', snapshot: structuredClone(state.team) }),
  chooseTeamWorkspace: async () => setupMode ? ({ kind: 'setup', draft: structuredClone(setupDraft) }) : ({ cancelled: true }),
  createTeam: async (input) => {
    if (setupMode) {
      const skillById = new Map(setupDraft.skills.map((skill) => [skill.id, skill]))
      const configured = createConfiguredTeamBundle({
        workspaceId: setupDraft.workspaceId,
        workspaceName: setupDraft.workspaceName,
        workspacePath: setupDraft.workspacePath,
        now: Date.now(),
        members: input.members.map((member) => ({
          channelId: member.channelId,
          roleTemplateKey: member.roleTemplateKey,
          avatarId: member.avatarId,
          solo: member.solo,
          modelSelection: member.modelSelection,
          skills: member.skillIds.flatMap((id) => {
            const skill = skillById.get(id)
            return skill ? [{ id: skill.id, name: skill.name, description: skill.description, scope: skill.scope }] : []
          })
        }))
      })
      const run = { ...configured.run, goal: '预览团队目标', status: 'ready' as const }
      const members = configured.slots.map((slot, index) => {
        const role = configured.roles.find((candidate) => candidate.id === slot.roleId)!
        const runtime = desktopSnapshot.sessions.find((session) => session.channelId === slot.channelId)
        const binding = {
          id: `preview-binding-${slot.channelId}`, workspaceId: configured.workspace.id, runId: run.id,
          slotId: slot.id, channelId: slot.channelId!, agentSessionId: `preview:ch-${slot.channelId}:g1`,
          generation: 'g1', installedAt: Date.now(), launchStatus: 'not_started' as const,
          launchDetail: '', lastCheckInNote: '', composerBindingKey: `preview-${slot.channelId}`
        }
        return {
          slot, role, binding,
          runtime: runtime ? {
            channelId: runtime.channelId, status: runtime.status, online: runtime.online,
            waiting: runtime.waiting, queueDepth: runtime.queueDepth, lastSeenAt: runtime.lastSeenAt,
            healthEvidence: runtime.healthEvidence, workingFiles: runtime.workingFiles
          } : undefined,
          readiness: runtime?.online ? runtime.waiting ? 'ready' as const : 'active' as const : 'offline' as const
        }
      })
      state.team = {
        ...emptyTeamControlSnapshot(),
        revision: 1,
        activeWorkspaceId: configured.workspace.id,
        workspaces: [configured.workspace],
        runs: [run],
        roles: configured.roles,
        slots: configured.slots,
        bindings: members.map((member) => member.binding),
        updatedAt: Date.now(),
        activeRun: run,
        members,
        runtimeChannels: members.map((member) => ({
          channelId: member.binding.channelId,
          displayName: `SG Team CH-${member.binding.channelId}`,
          status: member.runtime?.status ?? 'offline',
          online: member.runtime?.online ?? false,
          waiting: member.runtime?.waiting ?? false,
          queueDepth: member.runtime?.queueDepth ?? 0,
          registered: true,
          assignedSlotId: member.slot.id,
          agentSessionId: member.binding.agentSessionId,
          generation: member.binding.generation
        })),
        preflight: {
          bridgeConnected: true, workspaceBound: true, goalDefined: true,
          mcpInstalled: false, agentsWaiting: false, canLaunch: false,
          blockers: ['Agent MCP 尚未接入全部本轮通道', '并非所有团队通道都已在线待命']
        }
      }
    } else {
      state.team = structuredClone(teamControlSnapshot)
    }
    pushTeam()
    return structuredClone(state.team)
  },
  createIndependentSessions: async (input) => {
    const configured = createConfiguredTeamBundle({
      workspaceId: detectedSetupDraft.workspaceId,
      workspaceName: detectedSetupDraft.workspaceName,
      workspacePath: input.workspacePath,
      mode: 'independent',
      now: Date.now(),
      members: input.sessions.map((session, index) => ({
        channelId: String(index + 1), roleTemplateKey: 'solo', avatarId: AGENT_AVATAR_IDS[(index + 5) % AGENT_AVATAR_IDS.length]!,
        skills: [], solo: true, modelSelection: session.modelSelection
      }))
    })
    const bindings = configured.slots.map((slot) => ({
      id: `preview-independent-binding-${slot.channelId}`, workspaceId: configured.workspace.id, runId: configured.run.id,
      slotId: slot.id, channelId: slot.channelId!, agentSessionId: `preview-independent:ch-${slot.channelId}:g1`,
      generation: 'g1', installedAt: Date.now(), launchStatus: 'not_started' as const,
      launchDetail: '', lastCheckInNote: '', composerBindingKey: `preview-independent-${slot.channelId}`
    }))
    const members = configured.slots.map((slot, index) => ({
      slot,
      role: configured.roles[index]!,
      binding: bindings[index],
      runtime: undefined,
      readiness: 'offline' as const
    }))
    state.team = {
      ...emptyTeamControlSnapshot(), revision: state.team.revision + 1,
      activeWorkspaceId: configured.workspace.id, workspaces: [configured.workspace], runs: [configured.run],
      roles: configured.roles, slots: configured.slots, bindings, activeRun: configured.run, members,
      runtimeChannels: bindings.map((binding) => ({
        channelId: binding.channelId, displayName: `SG Team CH-${binding.channelId}`, status: 'offline' as const,
        online: false, waiting: false, queueDepth: 0, registered: true, assignedSlotId: binding.slotId,
        agentSessionId: binding.agentSessionId, generation: binding.generation
      })),
      preflight: {
        bridgeConnected: true, workspaceBound: true, goalDefined: false, mcpInstalled: true,
        agentsWaiting: false, canLaunch: false, blockers: []
      },
      updatedAt: Date.now()
    }
    pushTeam()
    return structuredClone(state.team)
  },
  chooseIndependentWorkspace: async () => ({
    id: detectedSetupDraft.workspaceId,
    name: detectedSetupDraft.workspaceName,
    path: detectedSetupDraft.workspacePath
  }),
  createNextTeamRun: async () => {
    state.desktop = { ...state.desktop, conversations: {}, updatedAt: Date.now() }
    state.team = {
      ...structuredClone(teamControlSnapshot),
      runs: teamControlSnapshot.runs.map((run) => ({ ...run, goal: '', status: 'draft' as const })),
      activeRun: teamControlSnapshot.activeRun
        ? { ...teamControlSnapshot.activeRun, goal: '', status: 'draft' as const }
        : undefined,
      failovers: []
    }
    pushDesktop()
    pushTeam()
    return structuredClone(state.team)
  },
  endActiveRun: async () => {
    state.team = {
      ...state.team,
      runs: state.team.runs.map((run) => (
        run.id === state.team.activeRun?.id ? { ...run, status: 'completed' as const, updatedAt: Date.now() } : run
      )),
      activeRun: state.team.activeRun
        ? { ...state.team.activeRun, status: 'completed' as const, updatedAt: Date.now() }
        : undefined
    }
    pushTeam()
    return structuredClone(state.team)
  },
  prepareActiveTeamSetup: async () => structuredClone({
    ...setupDraft,
    draftId: 'preview-team-reconfigure',
    initialMembers: teamControlSnapshot.members.map((member) => ({
      channelId: member.slot.channelId!,
      roleTemplateKey: member.role.templateKey,
      avatarId: member.slot.avatarId,
      skillIds: member.role.skills.map((skill) => skill.id),
      solo: member.slot.solo === true,
      modelSelection: member.slot.modelSelection
    }))
  }),
  updateTeamGoal: async (goal) => {
    state.team = {
      ...state.team,
      revision: state.team.revision + 1,
      activeRun: state.team.activeRun ? { ...state.team.activeRun, goal, updatedAt: Date.now() } : undefined,
      runs: state.team.runs.map((run) => run.id === state.team.activeRun?.id
        ? { ...run, goal, updatedAt: Date.now() }
        : run)
    }
    pushTeam()
    return structuredClone(state.team)
  },
  launchTeam: async () => structuredClone(state.team),
  setSlotModelSelection: async () => structuredClone(state.team),
  getTeamCollaborationSnapshot: async () => structuredClone(collaborationSnapshot),
  getManualHandoffOptions: async (slotId) => {
    const source = state.team.members.find((member) => member.slot.id === slotId)
    if (!source?.binding) throw new Error('待交接角色不存在')
    return {
      runId: state.team.activeRun!.id,
      sourceSlotId: source.slot.id,
      sourceRoleName: source.role.name,
      sourceChannelId: source.binding.channelId,
      candidates: [
        ...state.team.standbyChannels.filter((channel) => channel.agentSessionId).map((channel) => ({
          agentSessionId: channel.agentSessionId!,
          kind: 'standby' as const,
          mode: 'role_rebind' as const,
          channelId: channel.channelId,
          roleName: channel.displayName,
          eligible: channel.online && channel.waiting && channel.queueDepth === 0,
          blocker: !channel.online ? '备用 Agent 已离线' : !channel.waiting ? '备用 Agent 尚未待命' : channel.queueDepth ? `队列中还有 ${channel.queueDepth} 条消息` : undefined,
          impact: '备用 Agent 将直接接管，不会产生新的职责空缺'
        })),
        ...state.team.members.filter((member) => member.slot.solo !== true && member.slot.id !== source.slot.id && member.binding && member.runtime?.online).map((member) => ({
        agentSessionId: member.binding!.agentSessionId,
        kind: 'member' as const,
        mode: source.role.templateKey === 'lead' ? 'lead_authority' as const : 'role_rebind' as const,
        channelId: member.binding!.channelId,
        slotId: member.slot.id,
        roleName: member.role.name,
        avatarId: member.slot.avatarId,
        eligible: source.role.templateKey === 'lead'
          ? true
          : member.runtime!.waiting && member.runtime!.queueDepth === 0 && member.role.templateKey !== 'lead',
        blocker: source.role.templateKey !== 'lead' && member.role.templateKey === 'lead'
          ? '不能挪走当前唯一主控'
          : undefined,
        impact: source.role.templateKey === 'lead'
          ? `保留${member.role.name}职责与现有任务，同时接管唯一主控权限`
          : `${member.role.name}席将转为离线空缺`
        }))
      ]
    }
  },
  manualHandoff: async ({ sourceSlotId, replacementAgentSessionId }) => {
    const source = state.team.members.find((member) => member.slot.id === sourceSlotId)!
    const donor = state.team.members.find((member) => member.binding?.agentSessionId === replacementAgentSessionId)
    const standby = state.team.standbyChannels.find((channel) => channel.agentSessionId === replacementAgentSessionId)
    const sourceBinding = source.binding!
    if (source.role.templateKey === 'lead' && donor) {
      state.team = {
        ...state.team,
        revision: state.team.revision + 1,
        activeRun: state.team.activeRun
          ? { ...state.team.activeRun, actingLeadSlotId: donor.slot.id, updatedAt: Date.now() }
          : undefined,
        runs: state.team.runs.map((run) => run.id === state.team.activeRun?.id
          ? { ...run, actingLeadSlotId: donor.slot.id, updatedAt: Date.now() }
          : run)
      }
      pushTeam()
      return {
        handoff: {
          mode: 'lead_authority' as const,
          messageId: 'preview-lead-authority-message',
          actingLeadSlotId: donor.slot.id,
          recoveredTaskIds: []
        },
        team: structuredClone(state.team)
      }
    }
    const sourceChannel = sourceBinding.channelId
    const replacementChannelId = donor?.binding?.channelId ?? standby!.channelId
    const replacementAgentSessionIdResolved = donor?.binding?.agentSessionId ?? standby!.agentSessionId!
    source.binding = {
      ...sourceBinding,
      channelId: replacementChannelId,
      agentSessionId: replacementAgentSessionIdResolved,
      slotId: source.slot.id,
      launchStatus: 'sending'
    }
    source.slot = { ...source.slot, channelId: replacementChannelId, avatarId: donor?.slot.avatarId ?? source.slot.avatarId }
    source.runtime = donor?.runtime
      ? { ...donor.runtime, channelId: replacementChannelId }
      : { channelId: replacementChannelId, status: 'waiting', online: true, waiting: true, queueDepth: 0, lastSeenAt: Date.now(), healthEvidence: ['备用 Agent 已接管'], workingFiles: [] }
    source.readiness = 'launching'
    if (donor?.binding) {
      donor.binding = { ...sourceBinding, slotId: donor.slot.id, launchStatus: 'failed' }
      donor.slot = { ...donor.slot, channelId: sourceChannel }
      donor.runtime = donor.runtime ? { ...donor.runtime, channelId: sourceChannel, online: false, waiting: false, status: 'offline' } : donor.runtime
      donor.readiness = 'offline'
    }
    const failover = {
      id: `team-handoff:manual:preview`, workspaceId: sourceBinding.workspaceId,
      runId: sourceBinding.runId, slotId: source.slot.id, roleName: source.role.name,
      fromChannelId: sourceChannel, fromAgentSessionId: sourceBinding.agentSessionId,
      toChannelId: replacementChannelId, toAgentSessionId: replacementAgentSessionIdResolved,
      status: 'waiting_for_agent' as const, reason: '用户手动交接', taskIds: [],
      detectedAt: Date.now(), updatedAt: Date.now()
    }
    state.team = {
      ...state.team,
      revision: state.team.revision + 1,
      activeRun: state.team.activeRun ? { ...state.team.activeRun, status: 'attention' } : undefined,
      standbyChannels: standby ? state.team.standbyChannels.filter((channel) => channel.agentSessionId !== replacementAgentSessionId) : state.team.standbyChannels,
      failovers: [failover, ...state.team.failovers]
    }
    pushTeam()
    return {
      handoff: {
        mode: 'role_rebind',
        failover,
        messageId: 'preview-handoff-message', vacatedSlotId: donor?.slot.id
      },
      team: structuredClone(state.team)
    }
  },
  setWindowChromeColorMode: async () => true,
  onSnapshot: (listener) => {
    desktopListeners.add(listener)
    return () => desktopListeners.delete(listener)
  },
  // 用量预览：每个已绑定 Composer 都有独立累计，便于走查工作台顶部统计。
  getCursorUsageSnapshot: async () => Object.fromEntries(state.desktop.sessions.flatMap((session, index) => (
    session.composerId ? [[session.composerId, {
      composerId: session.composerId,
      turns: index + 2,
      inputTokens: 12_168 * (index + 1),
      outputTokens: 42 * (index + 1),
      cacheReadTokens: 3_968 * (index + 1),
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.0421 * (index + 1),
      pricedModel: session.executionProfile?.displayName ?? 'Claude Sonnet',
      lastTurnAt: previewNow
    }]] : []
  ))),
  getWorkspaceReview: async () => ({
    state: 'ready',
    workspaceName: 'wedge-demo',
    additions: 21,
    deletions: 8,
    revision: 'preview-review-1',
    updatedAt: Date.now(),
    files: [
      { path: 'src/renderer/src/SessionWorkspace.tsx', status: 'modified', staged: false, unstaged: true, additions: 14, deletions: 5 },
      { path: 'src/renderer/src/styles.css', status: 'modified', staged: false, unstaged: true, additions: 7, deletions: 3 }
    ]
  }),
  getWorkspaceReviewFile: async ({ path, previousPath }) => ({
    state: 'ready', path, previousPath, truncated: false,
    hunks: [{
      header: '@@ -628 +628 @@', skippedBefore: 627,
      lines: [
        { kind: 'context', text: '.session-usage { display: inline-flex; }', oldLine: 628, newLine: 628 },
        { kind: 'deletion', text: '.session-usage__label { font-size: 9px; }', oldLine: 629 },
        { kind: 'addition', text: '.session-usage__label { font-size: 11px; }', newLine: 629 }
      ]
    }]
  }),
  onCursorUsageSnapshot: () => () => {},
  onTaskPoolSnapshot: () => () => {},
  onTeamControlSnapshot: (listener) => {
    teamListeners.add(listener)
    return () => teamListeners.delete(listener)
  },
  onTeamCollaborationSnapshot: () => () => {}
}

window.qingtianDesktop = api
applyAppearancePreferences(readAppearancePreferences())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
