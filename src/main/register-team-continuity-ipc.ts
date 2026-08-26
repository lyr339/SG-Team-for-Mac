import { ipcMain, type BrowserWindow } from 'electron'
import type { TeamContinuityService } from '../application/team-continuity-service'
import type { TeamFailoverService } from '../application/team-failover-service'
import type { TeamControlService } from '../application/team-control-service'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

export function registerTeamContinuityIpc(
  service: TeamContinuityService,
  failover: TeamFailoverService,
  team: TeamControlService,
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.teamContinuityGet, (event) => {
    assertTrustedSender(event, getWindow)
    return service.getSnapshot()
  })
  ipcMain.handle(IPC.teamContinuityHandoffOptions, (event, slotId: unknown) => {
    assertTrustedSender(event, getWindow)
    if (typeof slotId !== 'string' || !slotId.trim() || slotId.length > 240) throw new Error('AgentSlot 无效')
    return failover.manualHandoffOptions(slotId)
  })
  ipcMain.handle(IPC.teamContinuityHandoff, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!value || typeof value !== 'object') throw new Error('交接参数无效')
    const input = value as Record<string, unknown>
    if (typeof input.sourceSlotId !== 'string' || !input.sourceSlotId.trim() || input.sourceSlotId.length > 240
      || typeof input.replacementAgentSessionId !== 'string' || !input.replacementAgentSessionId.trim()
      || input.replacementAgentSessionId.length > 240) {
      throw new Error('交接参数无效')
    }
    const handoff = failover.manualHandoff({
      sourceSlotId: input.sourceSlotId,
      replacementAgentSessionId: input.replacementAgentSessionId
    })
    return { handoff, team: team.getSnapshot() }
  })

  const unsubscribe = service.subscribe((snapshot) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.teamContinuitySnapshot, snapshot)
  })
  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.teamContinuityGet)
    ipcMain.removeHandler(IPC.teamContinuityHandoffOptions)
    ipcMain.removeHandler(IPC.teamContinuityHandoff)
  }
}
