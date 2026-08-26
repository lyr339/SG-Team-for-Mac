import { ipcMain, type BrowserWindow } from 'electron'
import type { AgentSessionLauncher } from '../application/agent-session-launcher'
import type { AgentLaunchPlan } from '../domain/agent-launch'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

const MAX_LAUNCH_CHANNELS = 16

export interface CursorCdpEnableResult {
  ok: boolean
  message: string
  /** 手动启用成功且 auto-heal 未开启时为 true：前端据此引导用户打开自动保持。 */
  suggestAutoHeal?: boolean
}

function channelIdsOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_LAUNCH_CHANNELS) {
    throw new Error('通道列表无效')
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !/^\d{1,3}$/.test(item.trim())) throw new Error('通道号无效')
    return item.trim()
  })
}

export function registerAgentLaunchIpc(
  launcher: AgentSessionLauncher,
  enableCursorCdp: () => Promise<CursorCdpEnableResult>,
  getWindow: () => BrowserWindow | undefined
): () => void {
  const emitProgress = (plan: AgentLaunchPlan): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.agentLaunchProgress, plan)
  }

  ipcMain.handle(IPC.agentLaunchStart, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    return launcher.launch(channelIdsOf(value), emitProgress)
  })
  ipcMain.handle(IPC.agentLaunchGet, (event) => {
    assertTrustedSender(event, getWindow)
    return launcher.getPlan()
  })
  ipcMain.handle(IPC.agentLaunchEnableCdp, (event) => {
    assertTrustedSender(event, getWindow)
    return enableCursorCdp()
  })
  return () => {
    ipcMain.removeHandler(IPC.agentLaunchStart)
    ipcMain.removeHandler(IPC.agentLaunchGet)
    ipcMain.removeHandler(IPC.agentLaunchEnableCdp)
  }
}
