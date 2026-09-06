import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { TeamControlService } from '../application/team-control-service'
import type { DesktopSessionBridge } from '../application/desktop-session-service'
import { CursorSkillCatalog } from '../infrastructure/cursor/cursor-skill-catalog'
import type { CursorWorkspaceDetector } from '../infrastructure/cursor/cursor-workspace-detector'
import { workspaceIdentityOf } from '../infrastructure/cursor/workspace-identity'
import { AGENT_AVATAR_IDS, TEAM_ROLE_TEMPLATES, workspaceRunMode, type TeamControlSnapshot } from '../domain/team-control'
import { IPC, type CreateIndependentSessionsInput, type CreateTeamInput, type TeamSetupDraft } from '../shared/desktop-api'
import type { CursorModelSelection } from '../domain/cursor-model'
import { resolveIndependentSessionMembers, resolveTeamSetupMembers } from '../application/team-setup'
import { assertTrustedSender } from './ipc-security'
import type { CursorWorkspaceDetection } from '../domain/cursor-workspace'

/** 选中 workspace 是否正是当前独立 run 所在工程（existing 快照会死锁的场景）。 */
function isActiveIndependentWorkspace(snapshot: TeamControlSnapshot, workspaceId: string): boolean {
  return Boolean(snapshot.activeRun
    && snapshot.activeWorkspaceId === workspaceId
    && workspaceRunMode(snapshot.activeRun) === 'independent')
}

const DEFAULT_LOCAL_CHANNEL_IDS = ['1', '2', '3']

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} 无效`)
  }
  return value.trim()
}

export interface TeamControlIpcOptions {
  onRunEnded?: (snapshot: TeamControlSnapshot) => void | Promise<void>
  detectCurrentWorkspace?: () => Promise<CursorWorkspaceDetection>
  /** 一键会话创建是否仍在进行：创建/替换 run 期间换拓扑会让编排器对着错误的席位收尾。 */
  isSessionLaunchRunning?: () => boolean
}

export function registerTeamControlIpc(
  service: TeamControlService,
  bridge: Pick<DesktopSessionBridge, 'getSnapshot'>,
  workspaceDetector: CursorWorkspaceDetector,
  getWindow: () => BrowserWindow | undefined,
  options: TeamControlIpcOptions = {}
): () => void {
  const assertNoSessionLaunch = (): void => {
    if (options.isSessionLaunchRunning?.()) {
      throw new Error('一键会话创建正在进行，请等待其完成后再切换运行模式')
    }
  }
  const pendingDrafts = new Map<string, {
    draft: TeamSetupDraft
    expiresAt: number
  }>()
  const skillCatalog = new CursorSkillCatalog()
  const pruneDrafts = (): void => {
    const now = Date.now()
    for (const [id, pending] of pendingDrafts) {
      if (pending.expiresAt < now) pendingDrafts.delete(id)
    }
  }
  const prepareDraft = (
    workspace: { id: string; name: string; path: string },
    initialMembers?: TeamSetupDraft['initialMembers'],
    detectedChannelIds: string[] = []
  ): TeamSetupDraft => {
    pruneDrafts()
    const bridgeSnapshot = bridge.getSnapshot()
    const channelMap = new Map(bridgeSnapshot.sessions.map((session) => [session.channelId, {
      channelId: session.channelId,
      displayName: session.displayName,
      status: session.status,
      online: session.online,
      waiting: session.waiting,
      queueDepth: session.queueDepth
    }]))
    for (const channelId of detectedChannelIds) {
      if (!channelMap.has(channelId)) {
        channelMap.set(channelId, {
          channelId,
          displayName: `SG Team CH-${channelId}`,
          status: 'offline',
          online: false,
          waiting: false,
          queueDepth: 0
        })
      }
    }
    for (const member of initialMembers ?? []) {
      if (!channelMap.has(member.channelId)) {
        channelMap.set(member.channelId, {
          channelId: member.channelId,
          displayName: `SG Team CH-${member.channelId}`,
          status: 'offline',
          online: false,
          waiting: false,
          queueDepth: 0
        })
      }
    }
    if (!channelMap.size) {
      for (const channelId of DEFAULT_LOCAL_CHANNEL_IDS) {
        channelMap.set(channelId, {
          channelId,
          displayName: `SG Team CH-${channelId}`,
          status: 'offline',
          online: false,
          waiting: false,
          queueDepth: 0
        })
      }
    }
    const draft: TeamSetupDraft = {
      draftId: randomUUID(),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      channels: [...channelMap.values()].sort((left, right) => Number(left.channelId) - Number(right.channelId)),
      roleTemplates: structuredClone(TEAM_ROLE_TEMPLATES),
      avatarIds: [...AGENT_AVATAR_IDS],
      skills: skillCatalog.scan(workspace.path).entries,
      cursorModels: structuredClone(bridgeSnapshot.cursorModels ?? []),
      initialMembers
    }
    pendingDrafts.set(draft.draftId, { draft, expiresAt: Date.now() + 30 * 60 * 1_000 })
    return draft
  }

  ipcMain.handle(IPC.teamControlGet, (event) => {
    assertTrustedSender(event, getWindow)
    return service.getSnapshot()
  })
  ipcMain.handle(IPC.teamControlDetectWorkspace, (event) => {
    assertTrustedSender(event, getWindow)
    return options.detectCurrentWorkspace ? options.detectCurrentWorkspace() : workspaceDetector.detect()
  })
  ipcMain.handle(IPC.teamControlPrepareDetectedWorkspace, async (event) => {
    assertTrustedSender(event, getWindow)
    const detection = options.detectCurrentWorkspace ? await options.detectCurrentWorkspace() : workspaceDetector.detect()
    if (detection.state === 'ambiguous') {
      throw new Error(detection.detail)
    }
    if (detection.state !== 'detected' || !detection.workspace) {
      throw new Error(detection.detail || '尚未识别到 Cursor 当前工程')
    }
    const workspace = detection.workspace
    const snapshot = service.getSnapshot()
    const existing = snapshot.workspaces.some((item) => item.id === workspace.id)
    if (existing && !isActiveIndependentWorkspace(snapshot, workspace.id)) {
      return { kind: 'existing', snapshot: service.setActiveWorkspace(workspace.id) } as const
    }
    // 当前独立 run 的 workspace：existing 快照会把用户弹回独立拦截页（死锁），
    // 走组队草稿——createTeam 时 configureWorkspace 会原子替换独立 run。
    return {
      kind: 'setup',
      draft: prepareDraft(workspace, undefined, workspace.channelIds)
    } as const
  })
  ipcMain.handle(IPC.teamControlChooseWorkspace, async (event) => {
    assertTrustedSender(event, getWindow)
    const window = getWindow()
    if (!window) throw new Error('主窗口不可用')
    const selection = await dialog.showOpenDialog(window, {
      title: '选择拾光要管理的 Cursor 工作区',
      properties: ['openDirectory', 'createDirectory']
    })
    if (selection.canceled || !selection.filePaths[0]) return { cancelled: true } as const
    const workspace = workspaceIdentityOf(selection.filePaths[0])
    const snapshot = service.getSnapshot()
    const existing = snapshot.workspaces.some((item) => item.id === workspace.id)
    if (existing && !isActiveIndependentWorkspace(snapshot, workspace.id)) {
      return { kind: 'existing', snapshot: service.setActiveWorkspace(workspace.id) } as const
    }
    // 同上：选中当前独立 run 的 workspace 时必须进组队页，否则永远无法切回团队。
    const draft = prepareDraft(workspace)
    return { kind: 'setup', draft } as const
  })
  ipcMain.handle(IPC.teamControlPrepareActiveSetup, (event) => {
    assertTrustedSender(event, getWindow)
    const snapshot = service.getSnapshot()
    const run = snapshot.activeRun
    const workspace = snapshot.workspaces.find((item) => item.id === snapshot.activeWorkspaceId)
    if (!run || !workspace) throw new Error('当前没有可调整的团队')
    if (run.status === 'launching' || run.status === 'running') {
      throw new Error('团队正在运行，不能直接更换成员、角色或技能')
    }
    const initialMembers = snapshot.members.flatMap((member) => member.slot.channelId ? [{
      channelId: member.slot.channelId,
      roleTemplateKey: member.role.templateKey,
      avatarId: member.slot.avatarId,
      skillIds: member.role.skills.map((skill) => skill.id),
      modelSelection: member.slot.modelSelection
        ? structuredClone(member.slot.modelSelection)
        : undefined,
      solo: member.slot.solo === true
    }] : [])
    return prepareDraft(workspace, initialMembers)
  })
  ipcMain.handle(IPC.teamControlCreateTeam, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!value || typeof value !== 'object') throw new Error('组队参数无效')
    const input = value as Partial<CreateTeamInput>
    const draftId = requiredString(input.draftId, 'draftId', 100)
    const pending = pendingDrafts.get(draftId)
    if (!pending || pending.expiresAt < Date.now()) {
      pendingDrafts.delete(draftId)
      throw new Error('组队草稿已失效，请重新选择 Cursor 工作区')
    }
    assertNoSessionLaunch()
    const members = resolveTeamSetupMembers(pending.draft, input as CreateTeamInput)
    const snapshot = service.configureWorkspace({
      workspaceId: pending.draft.workspaceId,
      workspaceName: pending.draft.workspaceName,
      workspacePath: pending.draft.workspacePath,
      members
    })
    pendingDrafts.delete(draftId)
    return snapshot
  })
  ipcMain.handle(IPC.teamControlCreateIndependent, async (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('独立会话参数无效')
    const input = value as Partial<CreateIndependentSessionsInput>
    assertNoSessionLaunch()
    const workspacePath = requiredString(input.workspacePath, '工作区路径', 2_000)
    const workspace = workspaceIdentityOf(workspacePath)
    // 在替换旧 run / 签发新身份之前核对窗口；检测过程不产生业务写入。
    if (options.detectCurrentWorkspace) {
      const detected = await options.detectCurrentWorkspace()
      if (detected.state !== 'detected' || !detected.workspace) throw new Error(detected.detail)
      if (detected.workspace.id !== workspace.id) {
        throw new Error(`Cursor 当前工程为「${detected.workspace.name}」，创建配置仍为「${workspace.name}」。请按当前工程重新发起；原批次已保留。`)
      }
      assertNoSessionLaunch()
    }
    const members = resolveIndependentSessionMembers(
      bridge.getSnapshot().cursorModels ?? [],
      input as CreateIndependentSessionsInput
    )
    return service.configureIndependentWorkspace({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      members
    })
  })
  ipcMain.handle(IPC.teamControlChooseIndependentWorkspace, async (event) => {
    assertTrustedSender(event, getWindow)
    const window = getWindow()
    if (!window) throw new Error('主窗口不可用')
    const selection = await dialog.showOpenDialog(window, {
      title: '选择独立会话使用的 Cursor 工作区',
      properties: ['openDirectory', 'createDirectory']
    })
    return selection.canceled || !selection.filePaths[0]
      ? undefined
      : workspaceIdentityOf(selection.filePaths[0])
  })
  ipcMain.handle(IPC.teamControlNextRun, (event) => {
    assertTrustedSender(event, getWindow)
    return service.createNextRun()
  })
  ipcMain.handle(IPC.teamControlEndRun, async (event) => {
    assertTrustedSender(event, getWindow)
    assertNoSessionLaunch()
    const snapshot = service.endActiveRun()
    await options.onRunEnded?.(snapshot)
    return snapshot
  })
  ipcMain.handle(IPC.teamControlUpdateGoal, (event, goal: unknown) => {
    assertTrustedSender(event, getWindow)
    return service.updateGoal(requiredString(goal, '团队目标', 8_000))
  })
  ipcMain.handle(IPC.teamControlLaunch, (event) => {
    assertTrustedSender(event, getWindow)
    return service.launch()
  })
  ipcMain.handle(IPC.teamControlSetSlotModelSelection, (event, channelId: unknown, selection: unknown) => {
    assertTrustedSender(event, getWindow)
    return service.setSlotModelSelection(requiredString(channelId, '通道号', 12), selection as CursorModelSelection)
  })

  const unsubscribe = service.subscribe((snapshot) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.teamControlSnapshot, snapshot)
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.teamControlGet)
    ipcMain.removeHandler(IPC.teamControlDetectWorkspace)
    ipcMain.removeHandler(IPC.teamControlPrepareDetectedWorkspace)
    ipcMain.removeHandler(IPC.teamControlChooseWorkspace)
    ipcMain.removeHandler(IPC.teamControlCreateTeam)
    ipcMain.removeHandler(IPC.teamControlCreateIndependent)
    ipcMain.removeHandler(IPC.teamControlChooseIndependentWorkspace)
    ipcMain.removeHandler(IPC.teamControlNextRun)
    ipcMain.removeHandler(IPC.teamControlEndRun)
    ipcMain.removeHandler(IPC.teamControlPrepareActiveSetup)
    ipcMain.removeHandler(IPC.teamControlUpdateGoal)
    ipcMain.removeHandler(IPC.teamControlLaunch)
    ipcMain.removeHandler(IPC.teamControlSetSlotModelSelection)
  }
}
