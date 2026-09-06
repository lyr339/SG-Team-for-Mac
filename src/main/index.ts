import { app, BrowserWindow, nativeImage, safeStorage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SqliteTaskPoolRepository } from '../infrastructure/task-pool/sqlite-task-pool-repository'
import { TaskPoolService } from '../application/task-pool-service'
import { registerSessionIpc } from './register-session-ipc'
import { registerTaskPoolIpc } from './register-task-pool-ipc'
import { registerMcpInstallerIpc } from './register-mcp-installer-ipc'
import { SqliteTeamControlRepository } from '../infrastructure/team-control/sqlite-team-control-repository'
import { TeamControlService } from '../application/team-control-service'
import { registerTeamControlIpc } from './register-team-control-ipc'
import { CursorComposerTelemetryReader } from '../infrastructure/cursor/cursor-composer-telemetry'
import { DesktopSessionService } from '../application/desktop-session-service'
import { SqliteTeamCollaborationRepository } from '../infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { TeamMessageDispatcher } from '../application/team-message-dispatcher'
import { SqliteTeamMemoryRepository } from '../infrastructure/team-memory/sqlite-team-memory-repository'
import { TeamCollaborationService } from '../application/team-collaboration-service'
import { TeamCollaborationSweeper } from '../application/team-collaboration-sweeper'
import { TeamMemoryService } from '../application/team-memory-service'
import { registerTeamCollaborationIpc } from './register-team-collaboration-ipc'
import { SqliteTeamContinuityRepository } from '../infrastructure/team-continuity/sqlite-team-continuity-repository'
import { SqliteChannelMessageRepository } from '../infrastructure/channel-messages/sqlite-channel-message-repository'
import { ChannelMessageRelay } from '../application/channel-message-relay'
import { reconcileGlobalChannelServers } from '../infrastructure/cursor/global-mcp-registrar'
import { resolveTaskMcpServerPath } from './task-mcp-runtime'
import { TeamContinuityService } from '../application/team-continuity-service'
import { TeamFailoverService } from '../application/team-failover-service'
import { registerTeamContinuityIpc } from './register-team-continuity-ipc'
import { TaskDispatcher } from '../application/task-dispatcher'
import { MemoryReviewCoordinator } from '../application/memory-review-coordinator'
import { TeamOrchestrator } from '../application/team-orchestrator'
import { CursorAccountVault } from '../application/cursor-account-vault'
import { cursorRuntimeMatchMessage, verifyCursorRuntimeAccountMatch } from '../application/cursor-runtime-account-verify'
import { registerCursorAccountIpc } from './register-cursor-account-ipc'
import { registerWindowChromeIpc, WINDOW_TOPBAR_HEIGHT } from './register-window-chrome-ipc'
import { AozaiCardVault } from '../application/aozai-card-vault'
import { AozaiService, type AozaiFetch } from '../application/aozai-service'
import { registerAozaiIpc } from './register-aozai-ipc'
import {
  initializeSafeStorageNamespace,
  selectSafeStorageNamespace
} from './safe-storage-namespace'
import { AgentSessionLauncher } from '../application/agent-session-launcher'
import { registerAgentLaunchIpc } from './register-agent-launch-ipc'
import { CursorCdpSessionCreator } from '../infrastructure/cursor/cursor-cdp-session-creator'
import { CursorStreamObserver } from '../infrastructure/cursor/cursor-stream-observer'
import { restartCursorWithCdp } from '../infrastructure/cursor/cursor-cdp-restart'
import { CursorCdpKeeper } from '../infrastructure/cursor/cursor-cdp-keeper'
import { CursorCdpSettingsStore } from '../application/cursor-cdp-settings-store'
import { registerCdpKeeperIpc } from './register-cdp-keeper-ipc'
import { CursorUsageTracker, cursorUsageRunDecision } from '../application/cursor-usage-tracker'
import { CursorUsageStore } from '../infrastructure/cursor/cursor-usage-store'
import { registerCursorUsageIpc } from './register-cursor-usage-ipc'
import { CursorUpdatePreferencesStore } from '../infrastructure/cursor/cursor-update-preferences'
import { registerCursorUpdateIpc } from './register-cursor-update-ipc'
import { CursorAccountDeleter } from '../infrastructure/cursor/cursor-account-deleter'
import { CursorTokenImporter } from '../infrastructure/cursor/cursor-token-importer'
import { CursorAccountProfileFetcher } from '../infrastructure/cursor/cursor-account-profile'
import { RoxyBrowserClient } from '../infrastructure/cursor/fingerprint/roxybrowser-client'
import { FingerprintAccountChannel } from '../infrastructure/cursor/fingerprint/fingerprint-account-channel'
import type { FingerprintBrowser } from '../infrastructure/cursor/fingerprint/fingerprint-browser'
import { ExternalBrowserAccountHost } from '../infrastructure/cursor/external-browser-account-host'
import type { AccountAutomationBrowserHost } from '../infrastructure/cursor/account-automation-browser-host'
import { AccountAutomationService } from '../application/account-automation-service'
import { AccountAutomationSettingsStore } from '../application/account-automation-store'
import { registerAccountAutomationIpc } from './register-account-automation-ipc'
import { LocalSessionBridge } from '../application/local-session-bridge'
import { IPC } from '../shared/desktop-api'
import { createTeamAgentLaunchPromptPort } from '../application/team-agent-launch-prompts'
import { WorkspaceReviewReader } from '../infrastructure/git/workspace-review-reader'
import { registerWorkspaceReviewIpc } from './register-workspace-review-ipc'
import { SessionHandoffService } from '../application/session-handoff-service'
import { RevealPathPolicy } from '../application/reveal-path-policy'
import { registerSessionHandoffIpc } from './register-session-handoff-ipc'
import { installLocalImageProtocol, registerLocalImageScheme } from './local-image-protocol'
import { resolveUserDataDirectory } from './user-data-directory'
import { homedir } from 'node:os'

let mainWindow: BrowserWindow | undefined
let disposeIpc: (() => void) | undefined
let disposeTaskPoolIpc: (() => void) | undefined
let disposeMcpInstallerIpc: (() => void) | undefined
let disposeTeamControlIpc: (() => void) | undefined
let disposeTeamCollaborationIpc: (() => void) | undefined
let disposeTeamContinuityIpc: (() => void) | undefined
let disposeRunContext: (() => void) | undefined
let disposeCursorAccountIpc: (() => void) | undefined
let disposeAozaiIpc: (() => void) | undefined
let disposeAgentLaunchIpc: (() => void) | undefined
let disposeAccountAutomationIpc: (() => void) | undefined
let disposeCdpKeeperIpc: (() => void) | undefined
let disposeCursorUsageIpc: (() => void) | undefined
let disposeCursorUpdateIpc: (() => void) | undefined
let disposeWindowChromeIpc: (() => void) | undefined
let disposeWorkspaceReviewIpc: (() => void) | undefined
let disposeSessionHandoffIpc: (() => void) | undefined
let cursorCdpKeeperRef: CursorCdpKeeper | undefined
/** 退出前清理账号自动化浏览器宿主（按当前设置解析：指纹=关窗断连；外部=noop）。 */
let accountBrowserHostDisposeRef: (() => Promise<void>) | undefined
let taskPoolRepository: SqliteTaskPoolRepository | undefined
let taskPoolService: TaskPoolService | undefined
let teamControlRepository: SqliteTeamControlRepository | undefined
let teamControlService: TeamControlService | undefined
let desktopSessionService: DesktopSessionService | undefined
let cursorStreamObserver: CursorStreamObserver | undefined
let cursorUsageTrackerRef: CursorUsageTracker | undefined
/** 当前 run 已绑定的 composer；窗口中的其他会话不进入本轮账。 */
let usageComposerIds = new Set<string>()
let teamCollaborationRepository: SqliteTeamCollaborationRepository | undefined
let teamMessageDispatcher: TeamMessageDispatcher | undefined
let teamMemoryRepository: SqliteTeamMemoryRepository | undefined
let teamCollaborationService: TeamCollaborationService | undefined
let teamCollaborationSweeper: TeamCollaborationSweeper | undefined
let teamMemoryService: TeamMemoryService | undefined
let teamContinuityRepository: SqliteTeamContinuityRepository | undefined
let teamContinuityService: TeamContinuityService | undefined
let channelMessageRepository: SqliteChannelMessageRepository | undefined
let channelMessageRelay: ChannelMessageRelay | undefined
let localSessionBridge: LocalSessionBridge | undefined
let teamFailoverService: TeamFailoverService | undefined
let teamOrchestrator: TeamOrchestrator | undefined
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) app.quit()

// 会话正文里的本地图片（`![说明](/tmp/shot.png)`）经 sg-image:// 协议读盘；标准协议必须在 ready 前注册。
registerLocalImageScheme()

// safeStorage 的 macOS Keychain 服务名绑定 app name。先固定到首发名称，
// 待 ready 后加载旧钥匙，再恢复当前品牌名；否则品牌升级会使历史密文全部失效。
selectSafeStorageNamespace(app)
// 上一代品牌的数据目录在此原地改名迁移（账号、团队、消息历史随目录一起搬）。
app.setPath('userData', resolveUserDataDirectory(app.getPath('appData'), app.isPackaged))

function createWindow(): void {
  // 平台分离：mac 用 hiddenInset（红绿灯融入顶栏左侧）；win 用 hidden +
  // titleBarOverlay（系统绘制最小化/最大化/关闭，占据顶栏右上约 138px，
  // 渲染层以 --window-control-safe-right 避让；颜色由渲染层主题经 IPC 同步）。
  const isWindows = process.platform === 'win32'
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1_050,
    minHeight: 680,
    show: false,
    backgroundColor: '#ffffff',
    titleBarStyle: isWindows ? 'hidden' : 'hiddenInset',
    ...(isWindows ? {
      titleBarOverlay: {
        color: '#ffffff',
        symbolColor: '#171b24',
        height: WINDOW_TOPBAR_HEIGHT
      }
    } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const protocol = new URL(url).protocol
    if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (url !== current) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
}

function setMacDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'dock-icon.png')
    : join(__dirname, '../../build/icon-shiguang-1024.png')
  if (!existsSync(iconPath)) return
  try {
    const icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) app.dock.setIcon(icon)
  } catch (error) {
    // A Dock icon must never prevent the application window from starting.
    process.stderr.write(`[dock-icon] ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

if (hasSingleInstanceLock) app.whenReady().then(() => {
  initializeSafeStorageNamespace(safeStorage)
  installLocalImageProtocol()
  // Explicitly set the running Dock tile as well as the bundle icon. macOS can
  // otherwise keep showing a cached icon from an older build with the same ID.
  setMacDockIcon()
  const databasePath = join(app.getPath('userData'), 'task-pool.sqlite3')
  const cursorAccountVault = new CursorAccountVault(
    join(app.getPath('userData'), 'cursor-accounts.json'),
    {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value)
    }
  )
  const aozaiCardVault = new AozaiCardVault(
    join(app.getPath('userData'), 'aozai-card.json'),
    {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value)
    }
  )
  const aozaiFetch: AozaiFetch = async (url, init) => {
    const response = await fetch(url, init)
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const setCookie = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : [])
    return {
      ok: response.ok,
      status: response.status,
      json: () => response.json() as Promise<unknown>,
      getSetCookie: () => setCookie
    }
  }
  const aozaiService = new AozaiService(aozaiCardVault, aozaiFetch)
  taskPoolRepository = new SqliteTaskPoolRepository(databasePath)
  teamControlRepository = new SqliteTeamControlRepository(databasePath)
  teamCollaborationRepository = new SqliteTeamCollaborationRepository(databasePath)
  teamMemoryRepository = new SqliteTeamMemoryRepository(databasePath)
  teamContinuityRepository = new SqliteTeamContinuityRepository(databasePath)
  channelMessageRepository = new SqliteChannelMessageRepository(databasePath)
  channelMessageRelay = new ChannelMessageRelay(channelMessageRepository)
  channelMessageRelay.start()
  localSessionBridge = new LocalSessionBridge(channelMessageRelay)
  // S3-2：启动时幂等写入全局 ~/.cursor/mcp.json 原生条目（zhimo 同款载体），
  // Cursor 面板直接渲染 SG Team，无需任何手动安装步骤。
  try {
    const registration = reconcileGlobalChannelServers({
      command: process.execPath,
      serverPath: resolveTaskMcpServerPath({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath
      }),
      databasePath
    })
    if (registration.changed) {
      process.stderr.write(`[sg-team-global-mcp] registered ${registration.serverNames.join(', ')}\n`)
    }
  } catch (error) {
    process.stderr.write(`[sg-team-global-mcp] registration failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  const cursorTelemetry = new CursorComposerTelemetryReader()
  teamControlService = new TeamControlService(
    teamControlRepository,
    localSessionBridge,
    undefined,
    cursorTelemetry,
    teamCollaborationRepository
  )
  teamControlService.startWatcher()
  const cursorCdpCreator = new CursorCdpSessionCreator()
  desktopSessionService = new DesktopSessionService(
    localSessionBridge,
    teamControlService,
    cursorTelemetry,
    channelMessageRelay,
    cursorCdpCreator,
    // 原生 composer 计数：write hook 实时推送，既有 inspect 为同源补充；无新轮询。
    (input) => {
      const tracker = cursorUsageTrackerRef
      const usage = input.usage
      if (!tracker || !usage.generationId || !usageComposerIds.has(input.composerId)) return
      if (usage.inputTokens || usage.outputTokens || usage.cacheReadTokens || usage.cacheWriteTokens) {
        tracker.recordTurnSnapshot({ composerId: input.composerId, ...usage, occurredAt: input.observedAt })
      } else if (usage.contextTokensUsed) {
        tracker.recordRequestSample({ composerId: input.composerId, generationId: usage.generationId,
          modelId: usage.modelId, used: usage.contextTokensUsed, stopped: usage.stopped, occurredAt: input.observedAt })
      }
    }
  )
  desktopSessionService.startWatcher()
  // 过程流事件驱动层：Cursor 模型写入即时推送（写信号触发 inspect），
  // 轮询循环保留为流式粒度与兜底；observer 缺席时整体降级为纯轮询。
  // 用量通道：bundle 补丁在 turnEnded 推真实计费 token → 聚合器 → IPC 推送。
  const streamService = desktopSessionService
  // 观察器与会话创建共用同一目标解析（团队工作区窗口），避免多窗口时连错；
  // 定义必须先于 observer 构造（attach 同步段即调用）。
  const teamControlSnapshotForObserver = teamControlService
  const activeTeamWorkspacePath = (): string | undefined => {
    const snapshot = teamControlSnapshotForObserver.getSnapshot()
    return snapshot.workspaces.find((workspace) => workspace.id === snapshot.activeWorkspaceId)?.path
  }
  // 右栏「撤销」新增文件走系统回收站而非 rm，可找回。
  const workspaceReviewReader = new WorkspaceReviewReader(activeTeamWorkspacePath, {
    trashItem: (absolutePath) => shell.trashItem(absolutePath)
  })
  const cursorUsageStore = new CursorUsageStore(join(app.getPath('userData'), 'cursor-usage.json'))
  const initialUsageTeam = teamControlService.getSnapshot()
  usageComposerIds = new Set(initialUsageTeam.members.flatMap((member) => member.binding?.composerId ? [member.binding.composerId] : []))
  let usageRunId = initialUsageTeam.activeRun?.id
  let usageRunStatus = initialUsageTeam.activeRun?.status
  const initialUsageDecision = cursorUsageRunDecision(
    { runId: usageRunId, status: usageRunStatus },
    { runId: usageRunId, status: usageRunStatus }
  )
  const cursorUsageTracker = new CursorUsageTracker({
    // 事件不带模型：记录时向会话快照查该 composer 当前模型（查不到走默认价格档）。
    resolveModelForComposer: (composerId) => {
      const sessions = streamService.getSnapshot().sessions
      const session = sessions.find((candidate) => candidate.composerId === composerId)
      return session?.executionProfile?.modelId ?? session?.modelName
    },
    initialSnapshot: cursorUsageStore.load(usageRunId),
    persistSnapshot: (snapshot) => cursorUsageStore.save(usageRunId, snapshot),
    collecting: initialUsageDecision.collecting
  })
  cursorUsageTrackerRef = cursorUsageTracker
  cursorStreamObserver = new CursorStreamObserver({
    fetchPageSocketUrl: () => cursorCdpCreator.resolveWorkbenchSocket(activeTeamWorkspacePath()),
    onWriteSignal: (composerId) => streamService.notifyComposerWriteSignal(composerId),
    onProcessEvent: (event) => streamService.notifyNativeProcessSnapshot(event),
    onUsageEvent: (event) => { if (usageComposerIds.has(event.composerId)) cursorUsageTracker.record(event) },
    onUsageSample: (sample) => { if (usageComposerIds.has(sample.composerId)) cursorUsageTracker.recordRequestSample(sample) },
    onStatus: (status) => streamService.setNativeProcessStreamStatus(status)
  })
  void cursorStreamObserver.attach()
  const teamControlSnapshotSource = teamControlService
  // 账号自动化的浏览器宿主双路径（设置里按需切换，契约同构 AccountAutomationBrowserHost）：
  //   fingerprint：RoxyBrowser profile + CDP 直连（过 Cloudflare；preflight 读 token 内存级、
  //                奥仔期间连接保持热、导航刷新等 token 轮换后页内秒级删除）
  //   external：Edge/Chrome 旧三件套（cookie 库读取 / AppleScript 刷新与页内删除）
  const accountAutomationSettingsStore = new AccountAutomationSettingsStore(
    join(app.getPath('userData'), 'account-automation.json')
  )
  const roxyApiKeyPath = join(app.getPath('userData'), 'roxy-api-key.txt')
  const readRoxyApiKey = (): string | undefined => {
    try {
      return existsSync(roxyApiKeyPath) ? readFileSync(roxyApiKeyPath, 'utf8').trim() || undefined : undefined
    } catch {
      return undefined
    }
  }
  // 指纹浏览器统一 RoxyBrowser（比特已全面退役，mac/win 同一提供方，与平台无关）。
  // 不读设置、不可切换。缺 API Key 时仍返回 Roxy 客户端：UI 显示 Key 输入框引导补配。
  // 实例按 apiKey 缓存：通道的会话复用按「client 实例相等」判断，每次 new 会让
  // 缓存永不命中（每次操作重开 tab + 重连 ws，热连接提速失效）；Key 变更换新实例
  // 正好触发会话重开，语义自然正确。
  let cachedRoxyClient: RoxyBrowserClient | undefined
  let cachedRoxyApiKey: string | undefined
  const resolveFingerprintClient = (): FingerprintBrowser => {
    const apiKey = readRoxyApiKey() ?? (process.env.ROXY_API_KEY || '')
    if (!cachedRoxyClient || cachedRoxyApiKey !== apiKey) {
      cachedRoxyClient = new RoxyBrowserClient({ apiKey })
      cachedRoxyApiKey = apiKey
    }
    return cachedRoxyClient
  }
  // 官网账号资料识别（token → email/name）：导入时把 user_xxx 换成可读邮箱备注。
  const cursorAccountProfileFetcher = new CursorAccountProfileFetcher()
  const fingerprintAccountChannel = new FingerprintAccountChannel({
    // 提供方恒 Roxy，窗口 id 按设置实时解析——
    // 通道内部按「client 实例 + profileId」缓存会话，两者任一变化都会重开
    resolveClient: resolveFingerprintClient,
    resolveProfileId: () => accountAutomationSettingsStore.load().bitProfileId,
    shouldAcknowledgeModelDataPolicies: () => (
      accountAutomationSettingsStore.load().autoAcknowledgeModelDataPolicies !== false
    )
  })
  const externalBrowserHost = new ExternalBrowserAccountHost()
  // 每次操作实时解析当前宿主（用户可在设置里切「系统浏览器/指纹浏览器」）。
  // 系统浏览器宿主（Keychain cookie 读取 + Apple Events 页内删除）是 macOS 专属机制，
  // Windows 上即使旧设置残留 external 也恒走指纹浏览器。
  const resolveAccountBrowserHost = (): AccountAutomationBrowserHost => {
    const settings = accountAutomationSettingsStore.load()
    if (settings.browserHost === 'external' && process.platform !== 'win32') return externalBrowserHost
    return fingerprintAccountChannel
  }
  accountBrowserHostDisposeRef = () => resolveAccountBrowserHost().dispose()
  const accountAutomationService = new AccountAutomationService({
    settings: accountAutomationSettingsStore,
    aozai: aozaiService,
    cardVault: aozaiCardVault,
    accounts: cursorAccountVault,
    readBrowserToken: () => resolveAccountBrowserHost().readToken(),
    refreshBrowserToken: (previousToken) => resolveAccountBrowserHost().refresh(previousToken),
    // 运行态一致性硬闸（preflight 早查+复检都跑）：Cursor 登录 ≠ 活跃账号时中止，
    // 防「删错官网账号 / 会话僵尸」。vault_empty 视为通过——后续「尚未选择账号」闸会拦。
    verifyCursorRuntime: () => {
      const match = verifyCursorRuntimeAccountMatch({
        readRuntime: () => new CursorTokenImporter().import(),
        readActiveAccount: () => {
          const active = cursorAccountVault.list().find((account) => account.active)
          if (!active) return undefined
          return { token: cursorAccountVault.credential(active.id), label: active.label }
        }
      })
      return match.status === 'matched' || match.status === 'vault_empty'
        ? { ok: true }
        : { ok: false, reason: cursorRuntimeMatchMessage(match) }
    },
    deleter: new CursorAccountDeleter(),
    // 秒级通道（首选）：宿主各自的「刷新 + token 轮换守门 + 页内删除」实现
    inBrowserDeleter: {
      prepareRefresh: () => resolveAccountBrowserHost().prepareRefresh(),
      deleteWhenReady: () => resolveAccountBrowserHost().deleteWhenReady(),
      // 账号隔离清场（仅删除成功后由 service 调用；外部宿主无此能力时跳过）
      clearSiteData: () => resolveAccountBrowserHost().clearSiteData?.() ?? Promise.resolve(),
      // 完整收尾事务（指纹宿主）：页面卸载 → 关窗 → Roxy 缓存清理 → 指纹轮换。
      finalizeDeletedAccount: () => {
        const host = resolveAccountBrowserHost()
        return host.finalizeDeletedAccount?.() ?? host.clearSiteData?.() ?? Promise.resolve()
      },
      dispose: () => resolveAccountBrowserHost().dispose()
    }
  })
  const agentSessionLauncher = new AgentSessionLauncher(
    createTeamAgentLaunchPromptPort(teamControlSnapshotSource),
    cursorCdpCreator,
    {
      activeWorkspacePath: activeTeamWorkspacePath,
      bindingKeyForChannel: (channelId) => {
        const binding = teamControlSnapshotSource.getSnapshot().bindings.find((candidate) => candidate.channelId === channelId)
        return binding && !binding.composerId ? binding.composerBindingKey : undefined
      },
      modelSelectionForChannel: (channelId) => {
        const member = teamControlSnapshotSource.getSnapshot().members.find((candidate) => (
          (candidate.binding?.channelId ?? candidate.slot.channelId) === channelId
        ))
        return member?.slot.modelSelection ? structuredClone(member.slot.modelSelection) : undefined
      },
      prepareComposerRelaunch: (channelId) => teamControlService?.prepareComposerRelaunch(channelId)
    },
    desktopSessionService,
    {
      onAllTriggered: (plan) => accountAutomationService.onAllSessionsTriggered(plan.id),
      onFinished: (plan) => teamControlService?.settleAgentSessionLaunch(plan)
    }
  )
  // 协作通知与用户消息共用同一发送分流（内嵌通道走 SQLite，插件通道走 WS）
  teamMessageDispatcher = new TeamMessageDispatcher(
    teamCollaborationRepository,
    desktopSessionService,
    teamControlService
  )
  teamMessageDispatcher.start()
  teamCollaborationService = new TeamCollaborationService(
    teamCollaborationRepository,
    teamControlService
  )
  teamCollaborationService.startWatcher()
  teamCollaborationSweeper = new TeamCollaborationSweeper(
    teamCollaborationRepository,
    () => teamControlService!.getSnapshot()
  )
  teamCollaborationSweeper.startSweeper()
  teamMemoryService = new TeamMemoryService(teamMemoryRepository, teamControlService)
  taskPoolService = new TaskPoolService(taskPoolRepository, teamControlService)
  taskPoolService.startSweeper()
  taskPoolService.startWatcher()
  teamContinuityService = new TeamContinuityService(
    teamContinuityRepository,
    teamCollaborationRepository,
    {
      team: teamControlService,
      tasks: taskPoolService,
      collaboration: teamCollaborationService,
      memory: teamMemoryService
    }
  )
  const orchestrationError = (error: unknown): void => {
    process.stderr.write(`[team-orchestrator] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  }
  const taskDispatcher = new TaskDispatcher(
    taskPoolService,
    teamControlService,
    teamCollaborationRepository,
    orchestrationError
  )
  const memoryCoordinator = new MemoryReviewCoordinator(
    teamMemoryService,
    teamControlService,
    teamCollaborationRepository,
    orchestrationError
  )
  teamOrchestrator = new TeamOrchestrator(
    teamControlService,
    taskPoolService,
    teamCollaborationRepository,
    taskDispatcher,
    memoryCoordinator,
    orchestrationError
  )
  teamOrchestrator.start()
  teamFailoverService = new TeamFailoverService(
    teamControlRepository,
    teamControlService,
    taskPoolService,
    teamCollaborationRepository,
    teamContinuityService,
    { onerror: orchestrationError }
  )
  teamFailoverService.start()
  let activeRunId = teamControlService.getActiveRunId()
  disposeRunContext = teamControlService.subscribe((snapshot) => {
    const nextRunId = snapshot.activeRun?.id
    const nextRunStatus = snapshot.activeRun?.status
    if (nextRunId !== activeRunId) {
      activeRunId = nextRunId
      taskPoolService?.notifyRunChanged()
    }
    const usageDecision = cursorUsageRunDecision(
      { runId: usageRunId, status: usageRunStatus },
      { runId: nextRunId, status: nextRunStatus }
    )
    if (usageDecision.reset) usageRunId = nextRunId
    if (usageDecision.reset) {
      cursorUsageTracker.reset()
      cursorUsageTracker.setCollecting(true)
    }
    usageRunStatus = nextRunStatus
    usageComposerIds = new Set(snapshot.members.flatMap((member) => member.binding?.composerId ? [member.binding.composerId] : []))
    // 不跟随短暂在线/离线状态停采；用户明确结束时由 IPC 回调冻结。
  })
  disposeIpc = registerSessionIpc(desktopSessionService, () => mainWindow)
  const cursorCdpSettingsStore = new CursorCdpSettingsStore(join(app.getPath('userData'), 'cursor-cdp.json'))
  disposeCursorAccountIpc = registerCursorAccountIpc(
    cursorAccountVault,
    () => mainWindow,
    {
      // 系统浏览器导入与指纹导入共用同一资料识别实例（token → email/name）
      profileFetcher: cursorAccountProfileFetcher,
      // 切换必然重启 Cursor；恒附带调试端口拉起，免去用户再手动重启一次才能恢复会话创建。
      cdpPort: () => cursorCdpCreator.debugPort,
      workspacePath: activeTeamWorkspacePath,
      // keeper 在下方创建（cursorCdpKeeperRef 惰性引用）；抑制窗口覆盖
      // 终止链（~13s）+ 启动与端口就绪（~30s）+ 余量。
      suppressCdpAutoHeal: () => cursorCdpKeeperRef?.suppress(120_000),
      // 第一步「获取 Token」的指纹导入：开窗读 profile 登录态（内存级），读毕关窗省资源
      //（cookie 留 profile；后续自动化链会重新拉起）。拿到 token 顺手识别官网资料
      //（email/注册时间）——label 显示邮箱而不是 user_xxx；识别失败静默降级。
      // 识别与关窗并行（互不依赖），网络差时最多多等一个超时窗口。
      importFromFingerprint: async () => {
        const token = await fingerprintAccountChannel.readToken()
        const userId = token.includes('::') ? (token.split('::')[0] ?? '') : ''
        const [profile] = await Promise.all([
          cursorAccountProfileFetcher.fetch(token).catch(() => undefined),
          fingerprintAccountChannel.dispose().catch(() => {})
        ])
        return { token, userId, browserName: 'Roxy指纹', profile }
      },
      // 用户提前登录入口：打开选定窗口并导航 cursor.com，不关窗、会话留缓存
      //（登录后点导入直接热连接读 cookie；用户手动关窗由断链感知自动失效缓存）。
      openFingerprintLogin: () => fingerprintAccountChannel.openLoginPage(),
      cleanupFingerprintEnvironment: () => fingerprintAccountChannel.cleanupEnvironment(),
      acknowledgeModelDataPolicies: () => fingerprintAccountChannel.acknowledgeRequiredModelDataPolicies()
    }
  )
  disposeAozaiIpc = registerAozaiIpc(aozaiCardVault, aozaiService, cursorAccountVault, () => mainWindow)
  const cursorUpdatePreferencesStore = new CursorUpdatePreferencesStore()
  const cursorCdpKeeper = new CursorCdpKeeper({
    port: cursorCdpCreator.debugPort,
    isEnabled: () => cursorCdpSettingsStore.load().autoHealEnabled,
    workspacePath: activeTeamWorkspacePath,
    emit: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.cursorCdpAutoHealEvent, event)
      }
    }
  })
  cursorCdpKeeperRef = cursorCdpKeeper
  cursorCdpKeeper.start()
  disposeAgentLaunchIpc = registerAgentLaunchIpc(
    agentSessionLauncher,
    // 手动启用成功后，若 auto-heal 未开启则引导用户开启（前端据此提示）
    async () => {
      const result = await restartCursorWithCdp({
        port: cursorCdpCreator.debugPort,
        workspacePath: activeTeamWorkspacePath()
      })
      return {
        ...result,
        suggestAutoHeal: result.ok && !cursorCdpSettingsStore.load().autoHealEnabled
      }
    },
    () => mainWindow
  )
  disposeCdpKeeperIpc = registerCdpKeeperIpc(cursorCdpKeeper, cursorCdpSettingsStore, () => mainWindow)
  disposeCursorUsageIpc = registerCursorUsageIpc(cursorUsageTracker, () => mainWindow)
  disposeWorkspaceReviewIpc = registerWorkspaceReviewIpc(workspaceReviewReader, () => mainWindow, {
    // 工作区文件系统监听推送刷新信号；活动工作区切换时重绑。
    watchWorkspace: {
      workspacePath: activeTeamWorkspacePath,
      subscribeWorkspaceChange: (listener) => teamControlService!.subscribe(() => listener())
    }
  })
  // 会话交接：上下文文档 = Cursor 转录（遥测读取器定位），拾光会话记录落 userData/handoff。
  const handoffRoot = join(app.getPath('userData'), 'handoff')
  const sessionHandoffService = new SessionHandoffService({
    team: teamControlService,
    sessions: desktopSessionService,
    locateTranscript: (composerId, workspacePath) => cursorTelemetry.locateTranscript(composerId, workspacePath),
    conversationsOf: (channelId) => channelMessageRelay?.conversationsOf(channelId),
    handoffRoot,
    onerror: (error) => process.stderr.write(`[session-handoff] ${error instanceof Error ? error.message : String(error)}\n`)
  })
  // 「在 Finder 中显示」白名单：交接记录、Cursor 转录、通道附件（三处都是拾光自己写入/定位的文件）。
  const revealPolicy = new RevealPathPolicy([
    handoffRoot,
    process.env.SG_TEAM_CURSOR_PROJECTS_ROOT?.trim() || join(homedir(), '.cursor', 'projects'),
    join(app.getPath('userData'), 'channel-attachments')
  ], { allowImageFiles: true })
  disposeSessionHandoffIpc = registerSessionHandoffIpc(
    sessionHandoffService,
    desktopSessionService,
    revealPolicy,
    () => mainWindow,
    { downloadsPath: () => app.getPath('downloads') }
  )
  disposeCursorUpdateIpc = registerCursorUpdateIpc(cursorUpdatePreferencesStore, () => mainWindow)
  disposeWindowChromeIpc = registerWindowChromeIpc(() => mainWindow)
  disposeAccountAutomationIpc = registerAccountAutomationIpc(accountAutomationService, () => mainWindow, {
    // 窗口列表按当前设置的提供方实时拉取（Roxy 需先保存 API Key）
    listWindows: () => resolveFingerprintClient().listWindows(),
    readRoxyApiKey,
    saveRoxyApiKey: (key) => {
      try {
        mkdirSync(dirname(roxyApiKeyPath), { recursive: true })
        writeFileSync(roxyApiKeyPath, `${key.trim()}\n`, { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        process.stderr.write(`[roxy-api-key] 保存失败：${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  })
  disposeTaskPoolIpc = registerTaskPoolIpc(taskPoolService, () => mainWindow)
  disposeMcpInstallerIpc = registerMcpInstallerIpc(
    teamControlService,
    taskPoolRepository,
    () => mainWindow,
    channelMessageRepository
  )
  disposeTeamControlIpc = registerTeamControlIpc(
    teamControlService,
    desktopSessionService,
    () => mainWindow,
    { isSessionLaunchRunning: () => agentSessionLauncher.getPlan()?.state === 'running',
      detectCurrentWorkspace: () => cursorCdpCreator.detectCurrentWorkspace(),
      onRunEnded: async (ended) => {
        const endedRunId = ended.activeRun?.id
        const workspace = ended.workspaces.find((item) => item.id === ended.activeWorkspaceId)
        const ids = ended.members.flatMap((member) => member.binding?.composerId ? [member.binding.composerId] : [])
        try {
          // 用户结束前最后一次上下文可能尚未推送；只读补收，再冻结。探针自带超时。
          if (!workspace || usageRunId !== endedRunId) return
          const evidence = await cursorCdpCreator.inspectComposerRuntime(workspace.path, ids)
          if (usageRunId !== endedRunId) return
          for (const [composerId, row] of Object.entries(evidence)) {
            const usage = row.usage
            if (!usage?.generationId || !usageComposerIds.has(composerId)) continue
            if (usage.inputTokens || usage.outputTokens || usage.cacheReadTokens || usage.cacheWriteTokens) {
              cursorUsageTracker.recordTurnSnapshot({ composerId, ...usage, occurredAt: row.observedAt })
            } else if (usage.contextTokensUsed) {
              cursorUsageTracker.recordRequestSample({ composerId, generationId: usage.generationId,
                modelId: usage.modelId, used: usage.contextTokensUsed, stopped: true, occurredAt: row.observedAt })
            }
          }
        } catch {
          // 用量探测异常不影响已成功结束的运行，保留最后一笔数值。
        } finally {
          if (usageRunId === endedRunId) cursorUsageTracker.setCollecting(false)
        }
      } }
  )
  disposeTeamCollaborationIpc = registerTeamCollaborationIpc(
    teamCollaborationService,
    () => mainWindow
  )
  disposeTeamContinuityIpc = registerTeamContinuityIpc(
    teamFailoverService,
    teamControlService,
    () => mainWindow
  )
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void accountBrowserHostDisposeRef?.().catch(() => {})
  cursorStreamObserver?.dispose()
  cursorUsageTrackerRef?.dispose()
  desktopSessionService?.dispose()
  channelMessageRelay?.stop()
  teamFailoverService?.stop()
  teamOrchestrator?.stop()
  teamMessageDispatcher?.dispose()
  teamContinuityService?.dispose()
  teamCollaborationService?.dispose()
  teamCollaborationSweeper?.stopSweeper()
  teamMemoryService?.dispose()
  localSessionBridge?.dispose()
  taskPoolService?.stopSweeper()
  taskPoolService?.stopWatcher()
  disposeIpc?.()
  disposeTaskPoolIpc?.()
  disposeMcpInstallerIpc?.()
  disposeTeamControlIpc?.()
  disposeTeamCollaborationIpc?.()
  disposeTeamContinuityIpc?.()
  disposeRunContext?.()
  disposeCursorAccountIpc?.()
  disposeAozaiIpc?.()
  disposeAgentLaunchIpc?.()
  disposeAccountAutomationIpc?.()
  disposeCdpKeeperIpc?.()
  disposeCursorUsageIpc?.()
  disposeCursorUpdateIpc?.()
  disposeWindowChromeIpc?.()
  disposeWorkspaceReviewIpc?.()
  disposeSessionHandoffIpc?.()
  cursorCdpKeeperRef?.stop()
  teamControlService?.dispose()
  teamControlRepository?.close()
  channelMessageRepository?.close()
  teamCollaborationRepository?.close()
  teamMemoryRepository?.close()
  teamContinuityRepository?.close()
  taskPoolRepository?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
