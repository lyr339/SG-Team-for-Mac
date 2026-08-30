import type { TeamMemberConfiguration } from '../domain/team-control'
import type { CreateTeamInput, TeamSetupDraft } from '../shared/desktop-api'
import type { CursorModelOption, CursorModelSelection } from '../domain/cursor-model'

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} 无效`)
  }
  return value.trim()
}

function defaultModelSelection(models: CursorModelOption[]): CursorModelSelection | undefined {
  const option = models.find((model) => model.selected) ?? models[0]
  return option ? {
    modelId: option.modelId,
    displayName: option.displayName,
    parameters: structuredClone(option.parameters),
    maxMode: option.maxMode === true
  } : undefined
}

function resolveModelSelection(
  models: CursorModelOption[],
  raw: unknown
): CursorModelSelection | undefined {
  if (raw === undefined) return defaultModelSelection(models)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Cursor 模型配置无效')
  const candidate = raw as Partial<CursorModelSelection>
  const modelId = requiredText(candidate.modelId, 'modelId', 160)
  const option = models.find((model) => model.modelId === modelId)
  if (!option) throw new Error(`Cursor 模型不可用或已失效：${modelId}`)
  if (!Array.isArray(candidate.parameters)) throw new Error(`模型参数无效：${option.displayName}`)
  const requested = new Map<string, string>()
  for (const parameter of candidate.parameters) {
    if (!parameter || typeof parameter !== 'object') throw new Error(`模型参数无效：${option.displayName}`)
    const id = requiredText((parameter as { id?: unknown }).id, 'parameter.id', 80)
    const value = requiredText((parameter as { value?: unknown }).value, 'parameter.value', 160)
    if (requested.has(id)) throw new Error(`模型参数重复：${id}`)
    requested.set(id, value)
  }
  const definitions = new Map(option.parameterDefinitions.map((definition) => [definition.id, definition]))
  for (const [id, value] of requested) {
    const definition = definitions.get(id)
    if (!definition || !definition.values.some((entry) => entry.value === value)) {
      throw new Error(`模型参数不可用：${option.displayName} · ${id}=${value}`)
    }
  }
  const defaults = new Map(option.parameters.map((parameter) => [parameter.id, parameter.value]))
  const parameters = option.parameterDefinitions.flatMap((definition) => {
    const value = requested.get(definition.id) ?? defaults.get(definition.id) ?? definition.values[0]?.value
    return value === undefined ? [] : [{ id: definition.id, value }]
  })
  if (candidate.maxMode === true && option.supportsMaxMode === false) {
    throw new Error(`模型不支持 MAX Mode：${option.displayName}`)
  }
  const maxMode = option.supportsNonMaxMode === false ? true : candidate.maxMode === true
  if (option.variants?.length) {
    const selected = new Map(parameters.map((parameter) => [parameter.id, parameter.value]))
    const validVariant = option.variants.some((variant) => {
      const values = new Map(variant.parameters.map((parameter) => [parameter.id, parameter.value]))
      return variant.maxMode === maxMode
        && option.parameterDefinitions.every((definition) => values.get(definition.id) === selected.get(definition.id))
    })
    if (!validVariant) throw new Error(`Cursor 模型参数组合不可用：${option.displayName}`)
  }
  return {
    modelId: option.modelId,
    displayName: option.displayName,
    parameters,
    maxMode
  }
}

export function resolveTeamSetupMembers(
  draft: TeamSetupDraft,
  input: CreateTeamInput
): TeamMemberConfiguration[] {
  if (!Array.isArray(input.members) || !input.members.length) throw new Error('请至少选择一个 Agent 通道')
  if (input.members.length > 16) throw new Error('团队人数不能超过 16')
  const availableChannels = new Set(draft.channels.map((channel) => channel.channelId))
  const installedSkills = new Map(draft.skills.filter((skill) => skill.installed).map((skill) => [skill.id, skill]))
  const cursorModels = draft.cursorModels ?? []
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
    const solo = raw.solo === true
    const roleTemplateKey = requiredText(raw.roleTemplateKey, 'roleTemplateKey', 100)
    if (solo && roleTemplateKey !== 'solo') throw new Error('独立席位必须使用独立执行角色')
    if (!solo && roleTemplateKey === 'solo') throw new Error('团队席位不能使用独立执行角色')
    if (!Array.isArray(raw.skillIds) || raw.skillIds.some((id) => typeof id !== 'string')) {
      throw new Error(`CH-${channelId} 技能配置无效`)
    }
    const skills = (solo ? [] : [...new Set(raw.skillIds)]).map((id) => {
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
      roleTemplateKey,
      avatarId: requiredText(raw.avatarId, 'avatarId', 100),
      skills,
      modelSelection: resolveModelSelection(cursorModels, raw.modelSelection),
      solo
    }
  })
}
