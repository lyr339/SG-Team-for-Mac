import { ipcMain, type BrowserWindow } from 'electron'
import type { AgentSessionLauncher } from '../application/agent-session-launcher'
import type { AgentLaunchPlan, AgentLaunchRequest } from '../domain/agent-launch'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

const MAX_LAUNCH_CHANNELS = 16

export interface CursorCdpEnableResult {
  ok: boolean
  message: string
  /** 手动启用成功且 auto-heal 未开启时为 true：前端据此引导用户打开自动保持。 */
  suggestAutoHeal?: boolean
}

function launchRequestsOf(value: unknown): AgentLaunchRequest[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_LAUNCH_CHANNELS) {
    throw new Error('通道列表无效')
  }
  return value.map((item) => {
    const raw = typeof item === 'string' ? { channelId: item } : item
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('会话创建参数无效')
    const input = raw as Record<string, unknown>
    const channelId = typeof input.channelId === 'string' ? input.channelId.trim() : ''
    if (!/^\d{1,3}$/.test(channelId)) throw new Error('通道号无效')
    if (input.modelSelection === undefined) return { channelId }
    if (!input.modelSelection || typeof input.modelSelection !== 'object' || Array.isArray(input.modelSelection)) {
      throw new Error(`CH-${channelId} 模型配置无效`)
    }
    const model = input.modelSelection as Record<string, unknown>
    const modelId = typeof model.modelId === 'string' ? model.modelId.trim() : ''
    const displayName = typeof model.displayName === 'string' ? model.displayName.trim() : ''
    if (!modelId || modelId.length > 160 || !displayName || displayName.length > 160) {
      throw new Error(`CH-${channelId} 模型配置无效`)
    }
    if (!Array.isArray(model.parameters) || model.parameters.length > 32) {
      throw new Error(`CH-${channelId} 模型参数无效`)
    }
    const parameters = model.parameters.map((parameter) => {
      if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) {
        throw new Error(`CH-${channelId} 模型参数无效`)
      }
      const value = parameter as Record<string, unknown>
      const id = typeof value.id === 'string' ? value.id.trim() : ''
      const selected = typeof value.value === 'string' ? value.value : ''
      if (!id || id.length > 80 || !selected || selected.length > 160) {
        throw new Error(`CH-${channelId} 模型参数无效`)
      }
      return { id, value: selected }
    })
    return {
      channelId,
      modelSelection: { modelId, displayName, parameters, maxMode: model.maxMode === true }
    }
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
    return launcher.launch(launchRequestsOf(value), emitProgress)
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
