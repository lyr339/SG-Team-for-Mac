import { buildSoloLaunchHint, buildTeamLaunchHint, type TeamControlSnapshot } from '../domain/team-control'
import type { AgentLaunchPromptPort } from './agent-session-launcher'

export interface TeamAgentLaunchPromptSource {
  getSnapshot(): TeamControlSnapshot
  /** 投递启动提示前幂等推进 run 到 launching；缺省时仅依赖协议层 check_in 自愈兜底。 */
  ensureRunLaunched?(): void
}

/**
 * S4 底层注入：启动提示只保留一句话引导，
 * 角色职责/目标/规范经 MCP instructions 与 team_check_in 返回值注入。
 */
export function createTeamAgentLaunchPromptPort(source: TeamAgentLaunchPromptSource): AgentLaunchPromptPort {
  return {
    async fetchStartPrompt(channelId: string): Promise<string> {
      const normalizedChannelId = String(channelId ?? '').trim()
      if (!/^\d+$/.test(normalizedChannelId)) throw new Error('通道号无效')

      const team = source.getSnapshot()
      const run = team.activeRun
      if (!run) throw new Error('当前没有可启动的 TeamRun')
      const binding = team.bindings.find((candidate) =>
        candidate.runId === run.id && candidate.channelId === normalizedChannelId
      )
      if (!binding) throw new Error(`CH-${normalizedChannelId} 尚未安装 Team MCP`)
      const slot = team.slots.find((candidate) => candidate.id === binding.slotId)
      if (slot?.solo === true) return buildSoloLaunchHint({ channelId: normalizedChannelId })
      // 提示词承诺「已启动」并要求 Agent 立即 team_check_in；
      // 投递前必须让状态机事实进入 launching，否则 check_in 被白名单误拒（team_run_not_launched）。
      if (!run.goal.trim()) throw new Error('请先填写团队目标，再创建 Agent 会话')
      source.ensureRunLaunched?.()
      return buildTeamLaunchHint({ channelId: normalizedChannelId, binding })
    }
  }
}
