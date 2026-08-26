import { app, BrowserWindow, nativeImage, safeStorage, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
import { TeamMemoryService } from '../application/team-memory-service'
import { registerTeamCollaborationIpc } from './register-team-collaboration-ipc'
import { SqliteTeamContinuityRepository } from '../infrastructure/team-continuity/sqlite-team-continuity-repository'
import { SqliteChannelMessageRepository } from '../infrastructure/channel-messages/sqlite-channel-message-repository'
import { ChannelMessageRelay } from '../application/channel-message-relay'
import { reconcileGlobalChannelServers } from '../infrastructure/cursor/global-mcp-registrar'
import { uninstallRetiredBridgeExtension } from './legacy-cleanup'
import { resolveTaskMcpServerPath } from './task-mcp-runtime'
import { TeamContinuityService } from '../application/team-continuity-service'
import { TeamFailoverService } from '../application/team-failover-service'
import { registerTeamContinuityIpc } from './register-team-continuity-ipc'
import { registerTeamMemoryIpc } from './register-team-memory-ipc'
import { TaskDispatcher } from '../application/task-dispatcher'
import { MemoryReviewCoordinator } from '../application/memory-review-coordinator'
import { TeamOrchestrator } from '../application/team-orchestrator'
import { CursorAccountVault } from '../application/cursor-account-vault'
import { registerCursorAccountIpc } from './register-cursor-account-ipc'
import { AozaiCardVault } from '../application/aozai-card-vault'
import { AozaiService, type AozaiFetch } from '../application/aozai-service'
import { registerAozaiIpc } from './register-aozai-ipc'
import { AgentSessionLauncher } from '../application/agent-session-launcher'
import { registerAgentLaunchIpc } from './register-agent-launch-ipc'
import { CursorCdpSessionCreator } from '../infrastructure/cursor/cursor-cdp-session-creator'
import { restartCursorWithCdp } from '../infrastructure/cursor/cursor-cdp-restart'
import { CursorCdpKeeper } from '../infrastructure/cursor/cursor-cdp-keeper'
import { CursorCdpSettingsStore } from '../application/cursor-cdp-settings-store'
import { registerCdpKeeperIpc } from './register-cdp-keeper-ipc'
import { CursorUpdatePreferencesStore } from '../infrastructure/cursor/cursor-update-preferences'
import { registerCursorUpdateIpc } from './register-cursor-update-ipc'
import { CursorAccountDeleter } from '../infrastructure/cursor/cursor-account-deleter'
import { CursorBrowserTokenReader } from '../infrastructure/cursor/cursor-browser-token-reader'
import { CursorBrowserSessionRefresher } from '../infrastructure/cursor/cursor-browser-session-refresher'
import { CursorInBrowserAccountDeleter } from '../infrastructure/cursor/cursor-in-browser-account-deleter'
import { AccountAutomationService } from '../application/account-automation-service'
import { AccountAutomationSettingsStore } from '../application/account-automation-store'
import { registerAccountAutomationIpc } from './register-account-automation-ipc'
import { CursorWorkspaceDetector } from '../infrastructure/cursor/cursor-workspace-detector'
import { LocalSessionBridge } from '../application/local-session-bridge'
import { IPC } from '../shared/desktop-api'
import { createTeamAgentLaunchPromptPort } from '../application/team-agent-launch-prompts'

let mainWindow: BrowserWindow | undefined
let disposeIpc: (() => void) | undefined
let disposeTaskPoolIpc: (() => void) | undefined
let disposeMcpInstallerIpc: (() => void) | undefined
let disposeTeamControlIpc: (() => void) | undefined
let disposeTeamCollaborationIpc: (() => void) | undefined
let disposeTeamContinuityIpc: (() => void) | undefined
let disposeTeamMemoryIpc: (() => void) | undefined
let disposeRunContext: (() => void) | undefined
let disposeCursorAccountIpc: (() => void) | undefined
let disposeAozaiIpc: (() => void) | undefined
let disposeAgentLaunchIpc: (() => void) | undefined
let disposeAccountAutomationIpc: (() => void) | undefined
let disposeCdpKeeperIpc: (() => void) | undefined
let disposeCursorUpdateIpc: (() => void) | undefined
let cursorCdpKeeperRef: CursorCdpKeeper | undefined
let taskPoolRepository: SqliteTaskPoolRepository | undefined
let taskPoolService: TaskPoolService | undefined
let teamControlRepository: SqliteTeamControlRepository | undefined
let teamControlService: TeamControlService | undefined
let desktopSessionService: DesktopSessionService | undefined
let teamCollaborationRepository: SqliteTeamCollaborationRepository | undefined
let teamMessageDispatcher: TeamMessageDispatcher | undefined
let teamMemoryRepository: SqliteTeamMemoryRepository | undefined
let teamCollaborationService: TeamCollaborationService | undefined
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

app.setName('群枢')
app.setPath(
  'userData',
  join(app.getPath('appData'), app.isPackaged ? 'qingtian-team' : 'qingtian-team-dev')
)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1_050,
    minHeight: 680,
    show: false,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hiddenInset',
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
    : join(__dirname, '../../build/icon-team-1024.png')
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
  // Cursor 面板直接渲染 qunshu-ch-N，无需任何手动安装步骤。
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
      process.stderr.write(`[qunshu-global-mcp] registered ${registration.serverNames.join(', ')}\n`)
    }
  } catch (error) {
    process.stderr.write(`[qunshu-global-mcp] registration failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  // S3-3：尽力卸载退役的桥接扩展（失败静默）。
  void uninstallRetiredBridgeExtension((line) => process.stderr.write(`${line}\n`))
  const cursorTelemetry = new CursorComposerTelemetryReader()
  const cursorWorkspaceDetector = new CursorWorkspaceDetector()
  teamControlService = new TeamControlService(
    teamControlRepository,
    localSessionBridge,
    undefined,
    cursorTelemetry,
    teamCollaborationRepository
  )
  teamControlService.startWatcher()
  desktopSessionService = new DesktopSessionService(
    localSessionBridge,
    teamControlService,
    cursorTelemetry
  )
  desktopSessionService.startWatcher()
  const cursorCdpCreator = new CursorCdpSessionCreator()
  const teamControlSnapshotSource = teamControlService
  const activeTeamWorkspacePath = (): string | undefined => {
    const snapshot = teamControlSnapshotSource.getSnapshot()
    return snapshot.workspaces.find((workspace) => workspace.id === snapshot.activeWorkspaceId)?.path
  }
  const browserSessionRefresher = new CursorBrowserSessionRefresher({
    readToken: () => new CursorBrowserTokenReader().read().token,
    // 速度调优（自动化链实测）：cookie 无页面交互不可能自行轮换，
    // 自更新窗口只保留 1s「零打扰」幸运窗口；轮询 500ms 降低感知粒度
    selfUpdateWindowMs: 1_000,
    pollIntervalMs: 500,
    // cookie 落盘依赖 Chromium 后台批量写 SQLite；实机可超过 45s。
    // 该路径只在秒级页面内删除通道失败后启用，宁可多等也不要误判失败。
    refreshTimeoutMs: 90_000
  })
  const accountAutomationService = new AccountAutomationService({
    settings: new AccountAutomationSettingsStore(join(app.getPath('userData'), 'account-automation.json')),
    aozai: aozaiService,
    cardVault: aozaiCardVault,
    accounts: cursorAccountVault,
    readBrowserToken: () => new CursorBrowserTokenReader().read().token,
    refreshBrowserToken: (previousToken) => browserSessionRefresher.refresh(previousToken),
    deleter: new CursorAccountDeleter(),
    // 秒级通道：会话已失效时在浏览器会话内直接删除（绕开 cookie 落盘 ~20s 等待）；
    // 需 Edge 勾选「视图 → Developer → Allow JavaScript from Apple Events」，未开则自动回退轮换通道
    inBrowserDeleter: new CursorInBrowserAccountDeleter()
  })
  const agentSessionLauncher = new AgentSessionLauncher(
    createTeamAgentLaunchPromptPort(teamControlSnapshotSource),
    cursorCdpCreator,
    {
      activeWorkspacePath: activeTeamWorkspacePath,
      bindingKeyForChannel: (channelId) => {
        const binding = teamControlSnapshotSource.getSnapshot().bindings.find((candidate) => candidate.channelId === channelId)
        return binding && !binding.composerId ? binding.composerBindingKey : undefined
      }
    },
    desktopSessionService,
    { onAllTriggered: (plan) => accountAutomationService.onAllSessionsTriggered(plan.id) }
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
  teamMemoryService = new TeamMemoryService(teamMemoryRepository, teamControlService)
  teamMemoryService.startWatcher()
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
    if (nextRunId === activeRunId) return
    activeRunId = nextRunId
    taskPoolService?.notifyRunChanged()
  })
  disposeIpc = registerSessionIpc(desktopSessionService, () => mainWindow)
  disposeCursorAccountIpc = registerCursorAccountIpc(cursorAccountVault, () => mainWindow)
  disposeAozaiIpc = registerAozaiIpc(aozaiCardVault, aozaiService, cursorAccountVault, () => mainWindow)
  const cursorCdpSettingsStore = new CursorCdpSettingsStore(join(app.getPath('userData'), 'cursor-cdp.json'))
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
  disposeCursorUpdateIpc = registerCursorUpdateIpc(cursorUpdatePreferencesStore, () => mainWindow)
  disposeAccountAutomationIpc = registerAccountAutomationIpc(accountAutomationService, () => mainWindow)
  disposeTaskPoolIpc = registerTaskPoolIpc(taskPoolService, () => mainWindow)
  disposeMcpInstallerIpc = registerMcpInstallerIpc(
    teamControlService,
    taskPoolRepository,
    () => mainWindow,
    channelMessageRepository
  )
  disposeTeamControlIpc = registerTeamControlIpc(
    teamControlService,
    localSessionBridge,
    cursorWorkspaceDetector,
    () => mainWindow
  )
  disposeTeamCollaborationIpc = registerTeamCollaborationIpc(
    teamCollaborationService,
    () => mainWindow
  )
  disposeTeamContinuityIpc = registerTeamContinuityIpc(
    teamContinuityService,
    teamFailoverService,
    teamControlService,
    () => mainWindow
  )
  disposeTeamMemoryIpc = registerTeamMemoryIpc(teamMemoryService, () => mainWindow)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  desktopSessionService?.dispose()
  channelMessageRelay?.stop()
  teamFailoverService?.stop()
  teamOrchestrator?.stop()
  teamMessageDispatcher?.dispose()
  teamContinuityService?.dispose()
  teamCollaborationService?.dispose()
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
  disposeTeamMemoryIpc?.()
  disposeRunContext?.()
  disposeCursorAccountIpc?.()
  disposeAozaiIpc?.()
  disposeAgentLaunchIpc?.()
  disposeAccountAutomationIpc?.()
  disposeCdpKeeperIpc?.()
  disposeCursorUpdateIpc?.()
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
