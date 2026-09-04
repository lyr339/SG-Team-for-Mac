import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type DesktopSnapshot,
  type QingtianDesktopApi
} from '../shared/desktop-api'

const markRendererPlatform = (): void => {
  document.documentElement.dataset.platform = process.platform
}

if (document.documentElement) {
  markRendererPlatform()
} else {
  window.addEventListener('DOMContentLoaded', markRendererPlatform, { once: true })
}

const api: QingtianDesktopApi = {
  listCursorAccounts: () => ipcRenderer.invoke(IPC.cursorAccountsList),
  saveCursorAccount: (input) => ipcRenderer.invoke(IPC.cursorAccountsSave, input),
  selectCursorAccount: (accountId) => ipcRenderer.invoke(IPC.cursorAccountsSelect, accountId),
  removeCursorAccount: (accountId) => ipcRenderer.invoke(IPC.cursorAccountsRemove, accountId),
  importCursorAccountFromLocalCursor: () => ipcRenderer.invoke(IPC.cursorAccountsImportFromLocal),
  importCursorAccountFromBrowser: () => ipcRenderer.invoke(IPC.cursorAccountsImportFromBrowser),
  importCursorAccountFromFingerprint: () => ipcRenderer.invoke(IPC.cursorAccountsImportFromFingerprint),
  openFingerprintLoginPage: () => ipcRenderer.invoke(IPC.cursorAccountsOpenFingerprintLogin),
  cleanupFingerprintEnvironment: () => ipcRenderer.invoke(IPC.cursorAccountsCleanupFingerprintEnvironment),
  acknowledgeCursorModelDataPolicies: () => ipcRenderer.invoke(IPC.cursorAccountsAcknowledgeModelDataPolicies),
  restartCursorWithAccount: (accountId) => ipcRenderer.invoke(IPC.cursorAccountsRestartWith, accountId),
  verifyCursorRuntimeAccount: () => ipcRenderer.invoke(IPC.cursorAccountsVerifyRuntime),
  refreshCursorMembership: () => ipcRenderer.invoke(IPC.cursorAccountsRefreshMembership),
  refreshCursorAccountMemberships: (accountIds) => ipcRenderer.invoke(IPC.cursorAccountsRefreshMemberships, accountIds),
  getAozaiCardStatus: () => ipcRenderer.invoke(IPC.aozaiGetCardStatus),
  saveAozaiCard: (cardCode) => ipcRenderer.invoke(IPC.aozaiSaveCard, cardCode),
  clearAozaiCard: () => ipcRenderer.invoke(IPC.aozaiClearCard),
  refreshAozaiBalance: () => ipcRenderer.invoke(IPC.aozaiRefreshBalance),
  processAozaiAccount: (input) => ipcRenderer.invoke(IPC.aozaiProcessAccount, input),
  launchAgentSessions: (requests) => ipcRenderer.invoke(IPC.agentLaunchStart, requests),
  getAgentLaunchPlan: () => ipcRenderer.invoke(IPC.agentLaunchGet),
  enableCursorCdp: () => ipcRenderer.invoke(IPC.agentLaunchEnableCdp),
  getCursorCdpSettings: () => ipcRenderer.invoke(IPC.cursorCdpGetSettings),
  saveCursorCdpSettings: (settings) => ipcRenderer.invoke(IPC.cursorCdpSaveSettings, settings),
  getCursorUpdatePreferences: () => ipcRenderer.invoke(IPC.cursorUpdateGetPreferences),
  setCursorAutoUpdateDisabled: (disabled) => ipcRenderer.invoke(IPC.cursorUpdateSetAutoUpdateDisabled, disabled),
  cancelCdpAutoHealCountdown: () => ipcRenderer.invoke(IPC.cursorCdpCancelCountdown),
  onCdpAutoHealEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload)
    ipcRenderer.on(IPC.cursorCdpAutoHealEvent, wrapped)
    return () => ipcRenderer.off(IPC.cursorCdpAutoHealEvent, wrapped)
  },
  getAccountAutomationSettings: () => ipcRenderer.invoke(IPC.accountAutomationGetSettings),
  saveAccountAutomationSettings: (settings) => ipcRenderer.invoke(IPC.accountAutomationSaveSettings, settings),
  getAccountAutomationRun: () => ipcRenderer.invoke(IPC.accountAutomationGetRun),
  cancelAccountAutomation: () => ipcRenderer.invoke(IPC.accountAutomationCancel),
  listAccountAutomationBitProfiles: () => ipcRenderer.invoke(IPC.accountAutomationListBitProfiles),
  getAccountAutomationRoxyApiKey: () => ipcRenderer.invoke(IPC.accountAutomationGetRoxyApiKey),
  saveAccountAutomationRoxyApiKey: (key) => ipcRenderer.invoke(IPC.accountAutomationSaveRoxyApiKey, key),
  onAccountAutomationProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, run: Parameters<typeof listener>[0]): void => listener(run)
    ipcRenderer.on(IPC.accountAutomationProgress, wrapped)
    return () => ipcRenderer.off(IPC.accountAutomationProgress, wrapped)
  },
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  sendMessage: (input) => ipcRenderer.invoke(IPC.sendMessage, input),
  getTaskPoolSnapshot: () => ipcRenderer.invoke(IPC.taskPoolGet),
  installTaskMcp: () => ipcRenderer.invoke(IPC.taskMcpInstall),
  getTeamControlSnapshot: () => ipcRenderer.invoke(IPC.teamControlGet),
  detectCursorWorkspace: () => ipcRenderer.invoke(IPC.teamControlDetectWorkspace),
  prepareDetectedTeamWorkspace: () => ipcRenderer.invoke(IPC.teamControlPrepareDetectedWorkspace),
  chooseTeamWorkspace: () => ipcRenderer.invoke(IPC.teamControlChooseWorkspace),
  createTeam: (input) => ipcRenderer.invoke(IPC.teamControlCreateTeam, input),
  createIndependentSessions: (input) => ipcRenderer.invoke(IPC.teamControlCreateIndependent, input),
  chooseIndependentWorkspace: () => ipcRenderer.invoke(IPC.teamControlChooseIndependentWorkspace),
  createNextTeamRun: () => ipcRenderer.invoke(IPC.teamControlNextRun),
  endActiveRun: () => ipcRenderer.invoke(IPC.teamControlEndRun),
  prepareActiveTeamSetup: () => ipcRenderer.invoke(IPC.teamControlPrepareActiveSetup),
  updateTeamGoal: (goal) => ipcRenderer.invoke(IPC.teamControlUpdateGoal, goal),
  launchTeam: () => ipcRenderer.invoke(IPC.teamControlLaunch),
  setSlotModelSelection: (channelId, selection) => ipcRenderer.invoke(
    IPC.teamControlSetSlotModelSelection,
    channelId,
    selection
  ),
  getTeamCollaborationSnapshot: () => ipcRenderer.invoke(IPC.teamCollaborationGet),
  setWindowChromeColorMode: (mode) => ipcRenderer.invoke(IPC.windowSetChromeColorMode, mode),
  getManualHandoffOptions: (slotId) => ipcRenderer.invoke(IPC.teamContinuityHandoffOptions, slotId),
  manualHandoff: (input) => ipcRenderer.invoke(IPC.teamContinuityHandoff, input),
  onSnapshot: (listener: (snapshot: DesktopSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DesktopSnapshot): void => listener(snapshot)
    ipcRenderer.on(IPC.snapshot, handler)
    return () => ipcRenderer.removeListener(IPC.snapshot, handler)
  },
  getCursorUsageSnapshot: () => ipcRenderer.invoke(IPC.cursorUsageGet),
  onCursorUsageSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]): void => listener(snapshot)
    ipcRenderer.on(IPC.cursorUsageSnapshot, handler)
    return () => ipcRenderer.removeListener(IPC.cursorUsageSnapshot, handler)
  },
  onTaskPoolSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]): void => listener(snapshot)
    ipcRenderer.on(IPC.taskPoolSnapshot, handler)
    return () => ipcRenderer.removeListener(IPC.taskPoolSnapshot, handler)
  },
  onTeamControlSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]): void => listener(state)
    ipcRenderer.on(IPC.teamControlSnapshot, handler)
    return () => ipcRenderer.removeListener(IPC.teamControlSnapshot, handler)
  },
  onTeamCollaborationSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]): void => listener(state)
    ipcRenderer.on(IPC.teamCollaborationSnapshot, handler)
    return () => ipcRenderer.removeListener(IPC.teamCollaborationSnapshot, handler)
  },
  onAozaiProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload)
    ipcRenderer.on(IPC.aozaiProgress, handler)
    return () => ipcRenderer.removeListener(IPC.aozaiProgress, handler)
  },
  onAgentLaunchProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, plan: Parameters<typeof listener>[0]): void => listener(plan)
    ipcRenderer.on(IPC.agentLaunchProgress, handler)
    return () => ipcRenderer.removeListener(IPC.agentLaunchProgress, handler)
  }
}

contextBridge.exposeInMainWorld('qingtianDesktop', api)
