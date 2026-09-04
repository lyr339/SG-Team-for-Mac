import type { AgentSession } from '../domain/agent-session'
import type { ConversationEntry, ProcessBlock } from '../domain/conversation-entry'
import type { TaskPoolSnapshot, TeamTask } from '../domain/task-pool'
import type { TeamControlSnapshot } from '../domain/team-control'
import type { TeamCollaborationSnapshot, TeamMessage, TeamMessageKind } from '../domain/team-collaboration'
import type { TeamContinuitySnapshot } from '../domain/team-continuity'
import type { TeamMemorySnapshot } from '../domain/team-memory'
import type { AgentSkillCatalogEntry } from '../domain/agent-skill'
import type { TeamRoleTemplate } from '../domain/team-control'
import type { CursorAccountMetadata, CursorRuntimeAccountMatch } from '../domain/cursor-account'
import type { CursorMembershipStatus } from '../domain/cursor-membership'
import type { ManualTeamHandoffInput, ManualTeamHandoffResult, TeamHandoffOptions } from '../domain/team-handoff'
import type { CursorWorkspaceDetection } from '../domain/cursor-workspace'
import type { CursorModelOption, CursorModelSelection } from '../domain/cursor-model'
import type { AozaiCardStatus, AozaiProcessResult, AozaiProgressEvent } from '../domain/aozai-service'
import type { AgentLaunchPlan, AgentLaunchRequest } from '../domain/agent-launch'
import type { CdpAutoHealEvent, CursorCdpSettings } from '../domain/cursor-cdp'
import type { AccountAutomationRun, AccountAutomationSettings } from '../domain/account-automation'
import type { CursorUpdatePreferences, CursorUpdateWriteResult } from '../domain/cursor-update'
import type { CursorUsageSnapshot } from '../domain/cursor-usage'
import type { WorkspaceReviewFileDiff, WorkspaceReviewSummary } from '../domain/workspace-review'
import type { SessionHandoffContext, SessionHandoffRequest, SessionHandoffResult } from '../domain/session-handoff'

export type BridgeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'

/** 一回合的 Cursor 原生实时过程流。 */
export interface LiveProcessState {
  turn: string
  blocks: ProcessBlock[]
  /** 原生超长回合因传输上限折叠的步骤数。 */
  truncatedItemCount?: number
  startedAt: number
  updatedAt: number
  /**
   * 服务端确认的回合生成状态（RC-9）：Cursor 常把生成中的 Thinking 块标记为
   * done，靠「某块 running」猜测会把仍在生成的直播过程误判为历史——
   * 误判会跳过打字机播放器直接整段显示。渲染层以本字段为权威直播信号。
   */
  generating?: boolean
}

/** Cursor Composer 正在生成的原生回复；只存在于实时层，不写历史消息。 */
export interface LiveAgentResponseState {
  id: string
  channelId: string
  text: string
  status: 'streaming' | 'complete'
  startedAt: number
  updatedAt: number
}

export interface NativeProcessStreamStatus {
  state: 'connected' | 'reconnecting' | 'unavailable'
  detail: string
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
  /** 按通道映射的 Cursor 原生实时过程流。 */
  liveProcess?: Record<string, LiveProcessState>
  /** 按通道映射的 Cursor 原生流式回复。record_reply 落地后自动移除。 */
  liveAgentResponses?: Record<string, LiveAgentResponseState>
  /** Cursor 原生过程观察器健康度；断链时 UI 必须明确披露。 */
  nativeProcessStream?: NativeProcessStreamStatus
  protocolIssues: string[]
  cursorModels?: CursorModelOption[]
  updatedAt: number
}

export interface SendMessageInput {
  channelId: string
  text: string
  /** 主进程内部轮次栅栏；渲染层普通发送不填写。 */
  scopeRunId?: string
  /** 消息附件（图片/文件） */
  attachments?: import('../domain/conversation-entry').MessageAttachment[]
  /**
   * 静默投递：消息只进出站队列（Agent 可收到），不写入会话时间线。
   * 用于系统内部协作通知（如团队消息投递提醒），避免对用户刷屏。
   */
  silent?: boolean
  /**
   * 「等待新会话」：消息留给该席位重建/重启后的新会话，当前会话取不到。
   * 渲染层只填这个布尔；主进程按席位现任会话令牌换算为 holdSessionToken。
   */
  holdUntilNewSession?: boolean
  /** 主进程内部：保持位令牌（渲染层不填写）。 */
  holdSessionToken?: string
}

export interface QueuedMessageRef {
  channelId: string
  /** 时间线条目 id（outbox:<id>）。 */
  entryId: string
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
  cursorModels?: CursorModelOption[]
  initialMembers?: CreateTeamMemberInput[]
}

export interface CreateTeamMemberInput {
  channelId: string
  roleTemplateKey: string
  avatarId: string
  skillIds: string[]
  modelSelection?: CursorModelSelection
  /** 独立席位：不入队，仅保留单聊与批量会话创建。 */
  solo?: boolean
}

export interface CreateTeamInput {
  draftId: string
  members: CreateTeamMemberInput[]
}

export interface CreateIndependentSessionsInput {
  workspacePath: string
  sessions: Array<{ modelSelection?: CursorModelSelection }>
}

export interface IndependentWorkspaceSelection {
  id: string
  name: string
  path: string
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
  importCursorAccountFromBrowser(): Promise<CursorAccountMetadata[]>
  /** 第一步「获取 Token」的指纹导入：读当前选中指纹浏览器 profile 的登录态（读毕关窗，cookie 留 profile）。 */
  importCursorAccountFromFingerprint(): Promise<CursorAccountMetadata[]>
  /** 打开选定的指纹浏览器窗口并导航到 cursor.com：用户可提前登录（cookie 落 profile，窗口不自动关）。 */
  openFingerprintLoginPage(): Promise<void>
  cleanupFingerprintEnvironment(): Promise<void>
  /** 查询并幂等确认当前指纹浏览器账号所需的受限模型数据政策。 */
  acknowledgeCursorModelDataPolicies(): Promise<{
    changed: boolean
    tokenUpdated: boolean
    modelIds: string[]
    message: string
  }>
  /**
   * 一键切换账号（FlyCursor「一键换号」同款时序）：确定性终止 Cursor → 独占写入
   * 登录态（cursorAuth/* 键）→ 重置账号绑定机器码（machineid 文件 +
   * storage.serviceMachineId + storage.json 遥测 4 键）→ 清理上一账号痕迹 →
   * 拉起 Cursor（恒附带 --remote-debugging-port，会话创建能力无缝恢复）。
   * 重启会断开全部拾光通道，UI 必须在调用前完成用户确认。
   */
  restartCursorWithAccount(accountId: string): Promise<{
    switched: boolean
    killedCursor: boolean
    relaunchMode: 'cdp' | 'plain' | 'failed'
    cdpPortReady?: boolean
    machineIdentityApplied: boolean
    backupDir?: string
    tokenExpiresAt?: number
    tokenExpired?: boolean
    runtimeVerified: boolean
  }>
  /**
   * 核对 Cursor 运行时登录态（state.vscdb cursorAuth）与拾光活跃账号是否同一账号
   * （JWT sub 比对；本地 SQLite 读，毫秒级）。发起会话前的闸门与大厅被动状态行共用。
   */
  verifyCursorRuntimeAccount(): Promise<CursorRuntimeAccountMatch>
  /**
   * 在线获取 Cursor 运行时账号的会员档位（api2.cursor.sh/auth/full_stripe_profile，
   * Bearer 运行时 token；token 明文只在主进程内）。批量会话发起闸门与手动刷新共用；
   * 失败返回 error 状态（fail-closed：过闸必须有权威结果）。
   */
  refreshCursorMembership(): Promise<CursorMembershipStatus>
  /** 按本地账号库存逐个读取加密凭据并在线查询档位；Token 不离开主进程。 */
  refreshCursorAccountMemberships(accountIds?: string[]): Promise<Record<string, CursorMembershipStatus>>
  getAozaiCardStatus(): Promise<AozaiCardStatus>
  saveAozaiCard(cardCode: string): Promise<AozaiCardStatus>
  clearAozaiCard(): Promise<AozaiCardStatus>
  refreshAozaiBalance(): Promise<AozaiCardStatus>
  processAozaiAccount(input: { accountId: string; requestId: string }): Promise<AozaiProcessResult>
  onAozaiProgress(listener: (event: AozaiProgressEvent) => void): () => void
  launchAgentSessions(requests: AgentLaunchRequest[]): Promise<AgentLaunchPlan>
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
  /** 列出指纹浏览器窗口（账号自动化链的浏览器宿主；失败时 message 说明客户端状态）。 */
  listAccountAutomationBitProfiles(): Promise<{ ok: boolean; profiles?: Array<{ id: string; name: string; seq?: number }>; message?: string }>
  /** Roxy API Key 状态（已保存时只回掩码）。 */
  getAccountAutomationRoxyApiKey(): Promise<{ saved: boolean; maskedKey?: string }>
  /** 保存 Roxy API Key（明文仅入主进程 userData 文件，不回显）。 */
  saveAccountAutomationRoxyApiKey(key: string): Promise<{ saved: boolean; maskedKey?: string }>
  onAccountAutomationProgress(listener: (run: AccountAutomationRun) => void): () => void
  /**
   * Windows 标题栏覆盖层（titleBarOverlay）颜色跟随应用主题；macOS 无覆盖层，
   * 调用静默生效。渲染层在主题生效与系统深浅色切换时同步。
   */
  setWindowChromeColorMode(mode: 'light' | 'dark'): Promise<boolean>
  getSnapshot(): Promise<DesktopSnapshot>
  sendMessage(input: SendMessageInput): Promise<SendMessageAccepted>
  /** 撤回仍在队列中的用户消息（已投递则返回 false）。 */
  withdrawQueuedMessage(input: QueuedMessageRef): Promise<boolean>
  /** 解除「等待新会话」保持位，消息回到普通排队。 */
  releaseQueuedMessage(input: QueuedMessageRef): Promise<boolean>
  /** 会话交接：定位该通道 Cursor 会话的上下文文档（转录）与可用投递方式。 */
  getSessionHandoffContext(input: { channelId: string }): Promise<SessionHandoffContext>
  /** 会话交接：把上下文文档路径（连同拾光会话记录）排进目标通道队列。 */
  deliverSessionHandoff(input: SessionHandoffRequest): Promise<SessionHandoffResult>
  /** 在系统文件管理器中显示该路径（仅允许拾光已解析出的文件）。 */
  revealPathInFolder(input: { path: string }): Promise<boolean>
  getTaskPoolSnapshot(): Promise<TaskPoolSnapshot>
  installTaskMcp(): Promise<McpInstallationResult>
  getTeamControlSnapshot(): Promise<TeamControlSnapshot>
  detectCursorWorkspace(): Promise<CursorWorkspaceDetection>
  prepareDetectedTeamWorkspace(): Promise<ChooseTeamWorkspaceResult>
  chooseTeamWorkspace(): Promise<ChooseTeamWorkspaceResult>
  createTeam(input: CreateTeamInput): Promise<TeamControlSnapshot>
  createIndependentSessions(input: CreateIndependentSessionsInput): Promise<TeamControlSnapshot>
  chooseIndependentWorkspace(): Promise<IndependentWorkspaceSelection | undefined>
  createNextTeamRun(): Promise<TeamControlSnapshot>
  /**
   * 显式结束当前运行（团队或独立批次）：run 进入 completed，本轮排队消息归档；
   * 携带会话令牌的旧 Cursor 会话在下一次轮询收到围栏终止指令并自行退出。
   */
  endActiveRun(): Promise<TeamControlSnapshot>
  prepareActiveTeamSetup(): Promise<TeamSetupDraft>
  updateTeamGoal(goal: string): Promise<TeamControlSnapshot>
  launchTeam(): Promise<TeamControlSnapshot>
  setSlotModelSelection(channelId: string, selection: CursorModelSelection): Promise<TeamControlSnapshot>
  getTeamCollaborationSnapshot(): Promise<TeamCollaborationSnapshot>
  getManualHandoffOptions(slotId: string): Promise<TeamHandoffOptions>
  manualHandoff(input: ManualTeamHandoffInput): Promise<{
    handoff: ManualTeamHandoffResult
    team: TeamControlSnapshot
  }>
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void
  /** 当前 TeamRun 的 Cursor 会话用量快照；结束冻结，下轮启动清零。 */
  getCursorUsageSnapshot(): Promise<CursorUsageSnapshot>
  onCursorUsageSnapshot(listener: (snapshot: CursorUsageSnapshot) => void): () => void
  /** 当前活动工作区的真实 Git 工作树审查摘要；右栏打开时按需读取。 */
  getWorkspaceReview(): Promise<WorkspaceReviewSummary>
  /** 按仓库相对路径读取单文件 unified diff；路径由主进程再次做工作区边界校验。 */
  getWorkspaceReviewFile(input: { path: string }): Promise<WorkspaceReviewFileDiff>
  onTaskPoolSnapshot(listener: (snapshot: TaskPoolSnapshot) => void): () => void
  onTeamControlSnapshot(listener: (state: TeamControlSnapshot) => void): () => void
  onTeamCollaborationSnapshot(listener: (state: TeamCollaborationSnapshot) => void): () => void
}

export const IPC = {
  cursorAccountsList: 'cursor-accounts:list',
  cursorAccountsSave: 'cursor-accounts:save',
  cursorAccountsSelect: 'cursor-accounts:select',
  cursorAccountsRemove: 'cursor-accounts:remove',
  cursorAccountsImportFromLocal: 'cursor-accounts:import-from-local',
  cursorAccountsImportFromBrowser: 'cursor-accounts:import-from-browser',
  cursorAccountsImportFromFingerprint: 'cursor-accounts:import-from-fingerprint',
  cursorAccountsOpenFingerprintLogin: 'cursor-accounts:open-fingerprint-login',
  cursorAccountsCleanupFingerprintEnvironment: 'cursor-accounts:cleanup-fingerprint-environment',
  cursorAccountsAcknowledgeModelDataPolicies: 'cursor-accounts:acknowledge-model-data-policies',
  cursorAccountsRestartWith: 'cursor-accounts:restart-with',
  cursorAccountsVerifyRuntime: 'cursor-accounts:verify-runtime',
  cursorAccountsRefreshMembership: 'cursor-accounts:refresh-membership',
  cursorAccountsRefreshMemberships: 'cursor-accounts:refresh-memberships',
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
  cursorUsageGet: 'cursor-usage:get',
  cursorUsageSnapshot: 'cursor-usage:snapshot',
  workspaceReviewGet: 'workspace-review:get',
  workspaceReviewFile: 'workspace-review:file',
  accountAutomationGetSettings: 'account-automation:get-settings',
  accountAutomationSaveSettings: 'account-automation:save-settings',
  accountAutomationGetRun: 'account-automation:get-run',
  accountAutomationCancel: 'account-automation:cancel',
  accountAutomationListBitProfiles: 'account-automation:list-bit-profiles',
  accountAutomationGetRoxyApiKey: 'account-automation:get-roxy-api-key',
  accountAutomationSaveRoxyApiKey: 'account-automation:save-roxy-api-key',
  accountAutomationProgress: 'account-automation:progress',
  windowSetChromeColorMode: 'window:set-chrome-color-mode',
  getSnapshot: 'sg-team-session:get-snapshot',
  sendMessage: 'sg-team-session:send-message',
  withdrawQueuedMessage: 'sg-team-session:withdraw-queued-message',
  releaseQueuedMessage: 'sg-team-session:release-queued-message',
  sessionHandoffContext: 'sg-team-session:handoff-context',
  sessionHandoffDeliver: 'sg-team-session:handoff-deliver',
  revealPathInFolder: 'sg-team-session:reveal-path',
  snapshot: 'sg-team-session:snapshot',
  taskPoolGet: 'task-pool:get',
  taskPoolSnapshot: 'task-pool:snapshot',
  taskMcpInstall: 'task-mcp:install',
  teamControlGet: 'team-control:get',
  teamControlDetectWorkspace: 'team-control:detect-workspace',
  teamControlPrepareDetectedWorkspace: 'team-control:prepare-detected-workspace',
  teamControlChooseWorkspace: 'team-control:choose-workspace',
  teamControlCreateTeam: 'team-control:create-team',
  teamControlCreateIndependent: 'team-control:create-independent',
  teamControlChooseIndependentWorkspace: 'team-control:choose-independent-workspace',
  teamControlNextRun: 'team-control:next-run',
  teamControlEndRun: 'team-control:end-run',
  teamControlPrepareActiveSetup: 'team-control:prepare-active-setup',
  teamControlUpdateGoal: 'team-control:update-goal',
  teamControlLaunch: 'team-control:launch',
  teamControlSetSlotModelSelection: 'team-control:set-slot-model-selection',
  teamControlSnapshot: 'team-control:snapshot',
  teamCollaborationGet: 'team-collaboration:get',
  teamCollaborationSnapshot: 'team-collaboration:snapshot',
  teamContinuityHandoffOptions: 'team-continuity:handoff-options',
  teamContinuityHandoff: 'team-continuity:handoff'
} as const
