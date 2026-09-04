import type { AgentRegistrationBatch } from './agent-authorization'
import type { AgentCheckInReceipt, AgentPresenceStore } from './agent-presence'
import type {
  TeamControlState,
  TeamLaunchStatus,
  WorkspaceTeamBundle
} from '../domain/team-control'
import type { ComposerBindingMethod } from '../domain/cursor-telemetry'
import type { CursorModelSelection } from '../domain/cursor-model'
import type { AgentAuthorizationIdentity, AgentRegistration } from './agent-authorization'
import type { TeamFailoverRebindResult, TeamFailoverRecord, TeamFailoverStatus } from '../domain/team-failover'

export interface TeamControlRepository extends AgentPresenceStore {
  /** 轻量读取当前修订号；用于避免每个轮询消费者都全量装配团队状态。 */
  revision?(): number
  loadTeamControl(): TeamControlState
  upsertWorkspaceTeam(bundle: WorkspaceTeamBundle): void
  /** 单槽模型选定持久化（lobby 逐会话配置保存出口）。 */
  setSlotModelSelection(slotId: string, selection: CursorModelSelection, updatedAt?: number): void
  setActiveWorkspace(workspaceId: string): void
  updateRunGoal(runId: string, goal: string): void
  recordInstallation(batch: AgentRegistrationBatch): void
  beginLaunch(runId: string, at: number, bindingKey: string): void
  /** 幂等推进 run 到 launching（仅状态，不重置 bindings）；未达可启动条件时为空操作。 */
  ensureRunLaunching(runId: string, at: number): void
  recordLaunchDelivery(input: {
    runId: string
    slotId: string
    status: Extract<TeamLaunchStatus, 'sending' | 'delivered' | 'uncertain' | 'failed'>
    commandId?: string
    detail: string
  }): void
  recordComposerBinding(input: {
    runId: string
    slotId: string
    generation: string
    bindingKey: string
    composerId: string
    method: ComposerBindingMethod
    at: number
  }): boolean
  prepareComposerRelaunch(input: {
    runId: string
    slotId: string
    bindingKey: string
  }): boolean
  resolveAgentRuntimeIdentity(identityKey: string, runId?: string): AgentAuthorizationIdentity
  listAgentRegistrations(runId: string): AgentRegistration[]
  rebindSlotToStandby(input: {
    failoverId: string
    runId: string
    slotId: string
    expectedAgentSessionId: string
    replacementAgentSessionId: string
    reason: string
    detectedAt: number
    bindingKey: string
    checkpointId?: string
  }): TeamFailoverRebindResult
  rebindSlotFromMember(input: {
    failoverId: string
    runId: string
    slotId: string
    donorSlotId: string
    expectedAgentSessionId: string
    replacementAgentSessionId: string
    reason: string
    detectedAt: number
    bindingKey: string
    checkpointId?: string
  }): TeamFailoverRebindResult
  attachFailoverContext(input: {
    failoverId: string
    checkpointId?: string
    messageId: string
    taskIds: string[]
    at: number
  }): void
  updateFailoverStatus(input: {
    failoverId: string
    status: Extract<TeamFailoverStatus, 'completed' | 'failed'>
    reason?: string
    at: number
  }): void
  listFailovers(runId: string): TeamFailoverRecord[]
  /**
   * 把 launching/running/attention/paused 的 run 收尾为 completed（撤销注册、
   * 绑定标 failed）。`detail` 写入各绑定的 launch_detail，说明收尾原因（自动
   * 离线收尾 / 用户显式结束 / 被新运行替换）；draft/ready 不适用，返回 false。
   */
  completeRun(runId: string, at: number, detail?: string): boolean
  recordAgentCheckIn(
    identity: Parameters<AgentPresenceStore['recordAgentCheckIn']>[0],
    note: string
  ): AgentCheckInReceipt
  /** 设置或清除临时主控：主控离线时指定新的 acting lead。 */
  setActingLead(input: { runId: string; slotId: string | null; at: number }): boolean
  close(): void
}
