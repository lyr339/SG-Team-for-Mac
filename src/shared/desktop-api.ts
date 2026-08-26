import type { AgentSession } from '../domain/agent-session'
import type { ConversationEntry, ProcessBlock } from '../domain/conversation-entry'
import type { TaskPoolSnapshot, TeamTask } from '../domain/task-pool'
import type { TeamControlSnapshot } from '../domain/team-control'
import type { TeamCollaborationSnapshot, TeamMessage, TeamMessageKind } from '../domain/team-collaboration'
import type { TeamContinuitySnapshot } from '../domain/team-continuity'
import type { TeamMemorySnapshot } from '../domain/team-memory'
import type { AgentSkillCatalogEntry } from '../domain/agent-skill'
import type { TeamRoleTemplate } from '../domain/team-control'
import type { CursorAccountMetadata } from '../domain/cursor-account'
import type { ManualTeamHandoffInput, ManualTeamHandoffResult, TeamHandoffOptions } from '../domain/team-handoff'
import type { CursorWorkspaceDetection } from '../domain/cursor-workspace'
import type { CursorModelOption } from '../domain/cursor-model'
import type { AozaiCardStatus, AozaiProcessResult, AozaiProgressEvent } from '../domain/aozai-service'
import type { AgentLaunchPlan } from '../domain/agent-launch'
import type { CdpAutoHealEvent, CursorCdpSettings } from '../domain/cursor-cdp'
import type { AccountAutomationRun, AccountAutomationSettings } from '../domain/account-automation'
import type { CursorUpdatePreferences, CursorUpdateWriteResult } from '../domain/cursor-update'

export type BridgeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'

/** 一回合的实时过程流：record_process 事件按 block.id upsert 聚合，回复归档后整体移除。 */
export interface LiveProcessState {
  turn: string
  blocks: ProcessBlock[]
  updatedAt: number
}

export interface BridgeConnection {
  state: BridgeConnectionState
  endpoint: string
  attempt: number
  lastError: string
}

export interface DesktopSnapshot {
  connection: BridgeConnection
  sessions: AgentSession[]
  conversations: Record<string, ConversationEntry[]>
  /**
   * 不进入会话时间线的投递回执（key = commandId）。
   * 用于系统内部通知等静默消息，让调度器能确认送达但不污染用户会话。
   */
  commandReceipts?: Record<string, ConversationEntry>
  /** 进行中的实时过程流（record_process 事件聚合，按通道）。回复归档后对应 turn 移除。 */
  liveProcess?: Record<string, LiveProcessState>
  protocolIssues: string[]
  cursorModels?: CursorModelOption[]
  updatedAt: number
}

export interface SendMessageInput {
  channelId: string
  text: string
  /** 消息附件（图片/文件） */
  attachments?: import('../domain/conversation-entry').MessageAttachment[]
  /**
   * 静默投递：消息只进出站队列（Agent 可收到），不写入会话时间线。
   * 用于系统内部协作通知（如团队消息投递提醒），避免对用户刷屏。
   */
  silent?: boolean
}

export interface SendMessageAccepted {
  commandId: string
}

export interface CreateDesktopTaskInput {
  title: string
  description?: string
  acceptance?: string
  priority?: number
  maxAttempts?: number
  dependsOnTaskIds?: string[]
  requiredCapabilities?: string[]
}

export interface SendDesktopTeamMessageInput {
  recipientSlotId: string
  kind: Exclude<TeamMessageKind, 'response'>
  subject?: string
  content: string
}

export interface TeamSetupChannel {
  channelId: string
  displayName: string
  status: AgentSession['status']
  online: boolean
  waiting: boolean
  queueDepth: number
}

export interface TeamSetupDraft {
  draftId: string
  workspaceId: string
  workspaceName: string
  workspacePath: string
  channels: TeamSetupChannel[]
  roleTemplates: TeamRoleTemplate[]
  avatarIds: string[]
  skills: AgentSkillCatalogEntry[]
  initialMembers?: CreateTeamMemberInput[]
}

export interface CreateTeamMemberInput {
  channelId: string
  roleTemplateKey: string
  avatarId: string
  skillIds: string[]
}

export interface CreateTeamInput {
  draftId: string
  members: CreateTeamMemberInput[]
}

export type ChooseTeamWorkspaceResult =
  | { cancelled: true }
  | { kind: 'existing'; snapshot: TeamControlSnapshot }
  | { kind: 'setup'; draft: TeamSetupDraft }

export type McpInstallationResult =
  | {
      ok: true
      workspacePath: string
      workspaceId: string
      runId: string
      configPath: string
      backupPath?: string
      serverNames: string[]
      autoInjected: boolean
      restartRequired: boolean
    }
  | { ok: false; cancelled: true }

export interface QingtianDesktopApi {
  listCursorAccounts(): Promise<CursorAccountMetadata[]>
  saveCursorAccount(input: { label: string; token: string; makeActive?: boolean }): Promise<CursorAccountMetadata[]>
  selectCursorAccount(accountId: string): Promise<CursorAccountMetadata[]>
  removeCursorAccount(accountId: string): Promise<CursorAccountMetadata[]>
  importCursorAccountFromLocalCursor(): Promise<CursorAccountMetadata[]>
  webLoginCursorAccount(): Promise<CursorAccountMetadata[]>
  importCursorAccountFromBrowser(): Promise<CursorAccountMetadata[]>
  /**
   * 将选中账号注入 Cursor state.vscdb（写全三个 token key）。
   * restart 默认 false：重启 Cursor 会断开全部群枢通道，仅用户在 UI 确认后传 true。
   */
  injectCursorAccount(accountId: string, options?: { restart?: boolean }): Promise<{
    injected: boolean
    backupPath?: string
    requiresRestart: boolean
    cursorPid?: number
    hotSwapped?: boolean
    restartPerformed?: boolean
    hotSwapFailure?: string
    tokenExpiresAt?: number
    tokenExpired?: boolean
  }>
  getAozaiCardStatus(): Promise<AozaiCardStatus>
  saveAozaiCard(cardCode: string): Promise<AozaiCardStatus>
  clearAozaiCard(): Promise<AozaiCardStatus>
  refreshAozaiBalance(): Promise<AozaiCardStatus>
  processAozaiAccount(input: { accountId: string; requestId: string }): Promise<AozaiProcessResult>
  onAozaiProgress(listener: (event: AozaiProgressEvent) => void): () => void
  launchAgentSessions(channelIds: string[]): Promise<AgentLaunchPlan>
  getAgentLaunchPlan(): Promise<AgentLaunchPlan | undefined>
  onAgentLaunchProgress(listener: (plan: AgentLaunchPlan) => void): () => void
  enableCursorCdp(): Promise<{ ok: boolean; message: string; suggestAutoHeal?: boolean }>
  getCursorCdpSettings(): Promise<CursorCdpSettings>
  saveCursorCdpSettings(settings: CursorCdpSettings): Promise<CursorCdpSettings>
  getCursorUpdatePreferences(): Promise<CursorUpdatePreferences>
  setCursorAutoUpdateDisabled(disabled: boolean): Promise<CursorUpdateWriteResult>
  /** 用户取消 auto-heal 倒计时：本次 Cursor 启动不再自动重启。 */
  cancelCdpAutoHealCountdown(): Promise<void>
  onCdpAutoHealEvent(listener: (event: CdpAutoHealEvent) => void): () => void
  getAccountAutomationSettings(): Promise<AccountAutomationSettings>
  saveAccountAutomationSettings(settings: AccountAutomationSettings): Promise<AccountAutomationSettings>
  getAccountAutomationRun(): Promise<AccountAutomationRun>
  cancelAccountAutomation(): Promise<AccountAutomationRun>
  onAccountAutomationProgress(listener: (run: AccountAutomationRun) => void): () => void
  getSnapshot(): Promise<DesktopSnapshot>
  sendMessage(input: SendMessageInput): Promise<SendMessageAccepted>
  getTaskPoolSnapshot(): Promise<TaskPoolSnapshot>
  createTask(input: CreateDesktopTaskInput): Promise<TeamTask>
  cancelTask(taskId: string, reason?: string): Promise<TeamTask>
  approveTask(taskId: string): Promise<TeamTask>
  rejectTask(taskId: string, reason: string): Promise<TeamTask>
  installTaskMcp(): Promise<McpInstallationResult>
  getTeamControlSnapshot(): Promise<TeamControlSnapshot>
  detectCursorWorkspace(): Promise<CursorWorkspaceDetection>
  prepareDetectedTeamWorkspace(): Promise<ChooseTeamWorkspaceResult>
  chooseTeamWorkspace(): Promise<ChooseTeamWorkspaceResult>
  createTeam(input: CreateTeamInput): Promise<TeamControlSnapshot>
  createNextTeamRun(): Promise<TeamControlSnapshot>
  prepareActiveTeamSetup(): Promise<TeamSetupDraft>
  setActiveTeamWorkspace(workspaceId: string): Promise<TeamControlSnapshot>
  updateTeamGoal(goal: string): Promise<TeamControlSnapshot>
  launchTeam(): Promise<TeamControlSnapshot>
  getTeamCollaborationSnapshot(): Promise<TeamCollaborationSnapshot>
  sendTeamMessage(input: SendDesktopTeamMessageInput): Promise<TeamMessage>
  replyTeamMessage(messageId: string, content: string): Promise<TeamMessage>
  markTeamMessageRead(messageId: string): Promise<TeamMessage>
  getTeamContinuitySnapshot(): Promise<TeamContinuitySnapshot>
  getManualHandoffOptions(slotId: string): Promise<TeamHandoffOptions>
  manualHandoff(input: ManualTeamHandoffInput): Promise<{
    handoff: ManualTeamHandoffResult
    team: TeamControlSnapshot
  }>
  getTeamMemorySnapshot(): Promise<TeamMemorySnapshot>
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void
  onTaskPoolSnapshot(listener: (snapshot: TaskPoolSnapshot) => void): () => void
  onTeamControlSnapshot(listener: (state: TeamControlSnapshot) => void): () => void
  onTeamCollaborationSnapshot(listener: (state: TeamCollaborationSnapshot) => void): () => void
  onTeamContinuitySnapshot(listener: (state: TeamContinuitySnapshot) => void): () => void
  onTeamMemorySnapshot(listener: (state: TeamMemorySnapshot) => void): () => void
}

export const IPC = {
  cursorAccountsList: 'cursor-accounts:list',
  cursorAccountsSave: 'cursor-accounts:save',
  cursorAccountsSelect: 'cursor-accounts:select',
  cursorAccountsRemove: 'cursor-accounts:remove',
  cursorAccountsImportFromLocal: 'cursor-accounts:import-from-local',
  cursorAccountsWebLogin: 'cursor-accounts:web-login',
  cursorAccountsImportFromBrowser: 'cursor-accounts:import-from-browser',
  cursorAccountsInject: 'cursor-accounts:inject',
  aozaiGetCardStatus: 'aozai:get-card-status',
  aozaiSaveCard: 'aozai:save-card',
  aozaiClearCard: 'aozai:clear-card',
  aozaiRefreshBalance: 'aozai:refresh-balance',
  aozaiProcessAccount: 'aozai:process-account',
  aozaiProgress: 'aozai:progress',
  agentLaunchStart: 'agent-launch:start',
  agentLaunchGet: 'agent-launch:get',
  agentLaunchProgress: 'agent-launch:progress',
  agentLaunchEnableCdp: 'agent-launch:enable-cdp',
  cursorCdpGetSettings: 'cursor-cdp:get-settings',
  cursorCdpSaveSettings: 'cursor-cdp:save-settings',
  cursorUpdateGetPreferences: 'cursor-update:get-preferences',
  cursorUpdateSetAutoUpdateDisabled: 'cursor-update:set-auto-update-disabled',
  cursorCdpCancelCountdown: 'cursor-cdp:cancel-countdown',
  cursorCdpAutoHealEvent: 'cursor-cdp:auto-heal-event',
  accountAutomationGetSettings: 'account-automation:get-settings',
  accountAutomationSaveSettings: 'account-automation:save-settings',
  accountAutomationGetRun: 'account-automation:get-run',
  accountAutomationCancel: 'account-automation:cancel',
  accountAutomationProgress: 'account-automation:progress',
  getSnapshot: 'qunshu-session:get-snapshot',
  sendMessage: 'qunshu-session:send-message',
  snapshot: 'qunshu-session:snapshot',
  taskPoolGet: 'task-pool:get',
  taskPoolCreate: 'task-pool:create',
  taskPoolCancel: 'task-pool:cancel',
  taskPoolApprove: 'task-pool:approve',
  taskPoolReject: 'task-pool:reject',
  taskPoolSnapshot: 'task-pool:snapshot',
  taskMcpInstall: 'task-mcp:install',
  teamControlGet: 'team-control:get',
  teamControlDetectWorkspace: 'team-control:detect-workspace',
  teamControlPrepareDetectedWorkspace: 'team-control:prepare-detected-workspace',
  teamControlChooseWorkspace: 'team-control:choose-workspace',
  teamControlCreateTeam: 'team-control:create-team',
  teamControlNextRun: 'team-control:next-run',
  teamControlPrepareActiveSetup: 'team-control:prepare-active-setup',
  teamControlSetWorkspace: 'team-control:set-workspace',
  teamControlUpdateGoal: 'team-control:update-goal',
  teamControlLaunch: 'team-control:launch',
  teamControlSnapshot: 'team-control:snapshot',
  teamCollaborationGet: 'team-collaboration:get',
  teamCollaborationSend: 'team-collaboration:send',
  teamCollaborationReply: 'team-collaboration:reply',
  teamCollaborationRead: 'team-collaboration:read',
  teamCollaborationSnapshot: 'team-collaboration:snapshot',
  teamContinuityGet: 'team-continuity:get',
  teamContinuityHandoffOptions: 'team-continuity:handoff-options',
  teamContinuityHandoff: 'team-continuity:handoff',
  teamContinuitySnapshot: 'team-continuity:snapshot',
  teamMemoryGet: 'team-memory:get',
  teamMemorySnapshot: 'team-memory:snapshot'
} as const
