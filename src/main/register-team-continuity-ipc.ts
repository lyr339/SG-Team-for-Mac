import { ipcMain, type BrowserWindow } from 'electron'
import type { TeamFailoverService } from '../application/team-failover-service'
import type { TeamControlService } from '../application/team-control-service'
import { manualHandoffWithContext, type ManualHandoffWithContextPorts } from '../application/manual-handoff-with-context'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

/**
 * 连续性 IPC：手动交接入口（快照读取由恢复流程在主进程内部完成，
 * 自动检查点由 TeamContinuityService 自身的 watcher 驱动，均不经渲染层）。
 * 「同时交接上下文文档」在主进程内与迁移串成一次调用（见 manualHandoffWithContext）。
 */
export function registerTeamContinuityIpc(
  failover: TeamFailoverService,
  team: TeamControlService,
  getWindow: () => BrowserWindow | undefined,
  sessionHandoff: ManualHandoffWithContextPorts['handoff']
): () => void {
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
      || input.replacementAgentSessionId.length > 240
      || (input.includeContext !== undefined && typeof input.includeContext !== 'boolean')) {
      throw new Error('交接参数无效')
    }
    const outcome = manualHandoffWithContext(
      { failover, team, handoff: sessionHandoff },
      {
        sourceSlotId: input.sourceSlotId,
        replacementAgentSessionId: input.replacementAgentSessionId,
        includeContext: input.includeContext === true
      }
    )
    return { ...outcome, team: team.getSnapshot() }
  })

  return () => {
    ipcMain.removeHandler(IPC.teamContinuityHandoffOptions)
    ipcMain.removeHandler(IPC.teamContinuityHandoff)
  }
}
