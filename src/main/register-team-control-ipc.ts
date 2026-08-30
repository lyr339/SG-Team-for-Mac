import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { TeamControlService } from '../application/team-control-service'
import type { DesktopSessionBridge } from '../application/desktop-session-service'
import { CursorSkillCatalog } from '../infrastructure/cursor/cursor-skill-catalog'
import type { CursorWorkspaceDetector } from '../infrastructure/cursor/cursor-workspace-detector'
import { workspaceIdentityOf } from '../infrastructure/cursor/workspace-identity'
import { AGENT_AVATAR_IDS, TEAM_ROLE_TEMPLATES } from '../domain/team-control'
import { IPC, type CreateTeamInput, type TeamSetupDraft } from '../shared/desktop-api'
import type { CursorModelSelection } from '../domain/cursor-model'
import { resolveTeamSetupMembers } from '../application/team-setup'
import { assertTrustedSender } from './ipc-security'

const DEFAULT_LOCAL_CHANNEL_IDS = ['1', '2', '3']

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} 无效`)
  }
  return value.trim()
}

export function registerTeamControlIpc(
  service: TeamControlService,
  bridge: Pick<DesktopSessionBridge, 'getSnapshot'>,
  workspaceDetector: CursorWorkspaceDetector,
  getWindow: () => BrowserWindow | undefined
): () => void {
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
    return workspaceDetector.detect()
  })
  ipcMain.handle(IPC.teamControlPrepareDetectedWorkspace, (event) => {
    assertTrustedSender(event, getWindow)
    const detection = workspaceDetector.detect()
    if (detection.state === 'ambiguous') {
      throw new Error(detection.detail)
    }
    if (detection.state !== 'detected' || !detection.workspace) {
      throw new Error(detection.detail || '尚未识别到 Cursor 当前工程')
    }
    const workspace = detection.workspace
    const existing = service.getSnapshot().workspaces.some((item) => item.id === workspace.id)
    if (existing) {
      return { kind: 'existing', snapshot: service.setActiveWorkspace(workspace.id) } as const
    }
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
    const existing = service.getSnapshot().workspaces.some((item) => item.id === workspace.id)
    if (existing) {
      return { kind: 'existing', snapshot: service.setActiveWorkspace(workspace.id) } as const
    }
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
  ipcMain.handle(IPC.teamControlNextRun, (event) => {
    assertTrustedSender(event, getWindow)
    return service.createNextRun()
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
    ipcMain.removeHandler(IPC.teamControlNextRun)
    ipcMain.removeHandler(IPC.teamControlPrepareActiveSetup)
    ipcMain.removeHandler(IPC.teamControlUpdateGoal)
    ipcMain.removeHandler(IPC.teamControlLaunch)
    ipcMain.removeHandler(IPC.teamControlSetSlotModelSelection)
  }
}
