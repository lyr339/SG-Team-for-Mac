import type { TeamMemberConfiguration } from '../domain/team-control'
import type { CreateTeamInput, TeamSetupDraft } from '../shared/desktop-api'

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} 无效`)
  }
  return value.trim()
}

export function resolveTeamSetupMembers(
  draft: TeamSetupDraft,
  input: CreateTeamInput
): TeamMemberConfiguration[] {
  if (!Array.isArray(input.members) || !input.members.length) throw new Error('请至少选择一个 Agent 通道')
  if (input.members.length > 16) throw new Error('团队人数不能超过 16')
  const availableChannels = new Set(draft.channels.map((channel) => channel.channelId))
  const installedSkills = new Map(draft.skills.filter((skill) => skill.installed).map((skill) => [skill.id, skill]))
  const selectedChannels = new Set<string>()
  return input.members.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Agent 席位参数无效')
    const channelId = requiredText(raw.channelId, 'channelId', 20)
    // 统一服务器按 channel_id 识别通道：草稿之外的新数字通道号只在用户选入席位时创建。
    const isNewNumericChannel = /^\d{1,12}$/.test(channelId)
    if ((!availableChannels.has(channelId) && !isNewNumericChannel) || selectedChannels.has(channelId)) {
      throw new Error(`通道不可用或重复：CH-${channelId}`)
    }
    selectedChannels.add(channelId)
    if (!Array.isArray(raw.skillIds) || raw.skillIds.some((id) => typeof id !== 'string')) {
      throw new Error(`CH-${channelId} 技能配置无效`)
    }
    const skills = [...new Set(raw.skillIds)].map((id) => {
      const skill = installedSkills.get(id)
      if (!skill) throw new Error(`技能未安装或已失效：${id}`)
      return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        scope: skill.scope
      }
    })
    return {
      channelId,
      roleTemplateKey: requiredText(raw.roleTemplateKey, 'roleTemplateKey', 100),
      avatarId: requiredText(raw.avatarId, 'avatarId', 100),
      skills
    }
  })
}
