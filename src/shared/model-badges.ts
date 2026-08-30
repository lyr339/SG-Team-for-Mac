/**
 * 模型运行配置徽章的规范化英文单一出口：主进程遥测解析（Cursor 读回）
 * 与逐会话选模投影（创建团队/批量发起时选定值）共用同一映射，
 * 保证「所选即所显」一一对应。
 */

export interface ModelBadgeParameter {
  id: string
  value: string
}

/** 映射到 Think 族徽章的参数 id（布尔开启 / 枚举档位）。 */
export const THINK_PARAMETER_IDS = new Set(['thinking', 'reasoning', 'effort'])
const OFF_PARAMETER_VALUES = new Set(['none', 'off', 'false', 'disabled'])
/** 标准上下文预算；不超过它视为默认配置，不出上下文徽章。 */
const STANDARD_CONTEXT_TOKENS = 200_000

export function readableParameterValue(value: string): string {
  const normalized = value.trim()
  if (/^\d+(?:\.\d+)?[km]$/i.test(normalized)) return normalized.toUpperCase()
  const labels: Record<string, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Max'
  }
  return labels[normalized.toLowerCase()] ?? normalized
}

export function contextTokensFromValue(value: string): number | undefined {
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([km])$/)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined
  return Math.round(amount * (match[2] === 'm' ? 1_000_000 : 1_000))
}

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * 规范化英文徽章，真实对应所选参数值：思考强度按档位出徽章
 * （medium→Think、high→High、max→Max），
 * 上下文仅 1M 等大窗口（>200K）出徽章；
 * 不取 Cursor 本地化 displayName，中文 UI 下仍为英文。
 */
export function englishParameterBadge(id: string, value: string, isBoolean: boolean): string | undefined {
  if (id === 'context') {
    const tokens = contextTokensFromValue(value)
    return tokens !== undefined && tokens > STANDARD_CONTEXT_TOKENS ? readableParameterValue(value) : undefined
  }
  if (THINK_PARAMETER_IDS.has(id)) {
    if (isBoolean) return value === 'true' ? 'Think' : undefined
    const normalized = value.trim().toLowerCase()
    if (OFF_PARAMETER_VALUES.has(normalized)) return undefined
    return normalized === 'medium' ? 'Think' : readableParameterValue(value)
  }
  if (isBoolean) return value === 'true' ? capitalizeFirst(id) : undefined
  return readableParameterValue(value)
}

/** 无目录定义时的种类推断：thinking/fast 为布尔，其余按枚举。 */
function inferredIsBoolean(id: string): boolean {
  return id === 'thinking' || id === 'fast'
}

/**
 * 由所选参数生成徽章列表；kinds 来自模型目录定义（可选，缺失时按推断）。
 * 同名参数字幕自然去重；独立的 MAX Mode 由渲染层明确显示为 `MAX Mode`，
 * 不再与 effort/reasoning 的 `Max` 混为同一个徽章。
 */
export function badgesFromParameters(
  parameters: ModelBadgeParameter[],
  kinds?: Map<string, 'boolean' | 'enum'>
): string[] {
  const labels: string[] = []
  const explicitThinking = parameters.find((parameter) => parameter.id === 'thinking')
  for (const parameter of parameters) {
    const kind = kinds?.get(parameter.id)
    const isBoolean = kind ? kind === 'boolean' : inferredIsBoolean(parameter.id)
    // reasoning 自身就是思考开关+强度；没有独立 thinking=false 时，
    // 会话徽章同时保留 Think 与具体强度（例如 Think · Max）。
    if (!isBoolean && THINK_PARAMETER_IDS.has(parameter.id)) {
      const normalized = parameter.value.trim().toLowerCase()
      const enabled = !OFF_PARAMETER_VALUES.has(normalized)
        && (parameter.id === 'thinking' || explicitThinking?.value !== 'false')
      if (enabled && !labels.includes('Think')) labels.push('Think')
    }
    const label = englishParameterBadge(parameter.id, parameter.value, isBoolean)
    if (label && !labels.includes(label)) labels.push(label)
  }
  return labels
}
