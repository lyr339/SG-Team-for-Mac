export type ModelProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'xai'
  | 'moonshot'
  | 'zhipu'
  | 'cursor'
  | 'auto'
  | 'other'

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  moonshot: 'Moonshot AI',
  zhipu: 'Zhipu AI',
  cursor: 'Cursor',
  auto: 'Auto routing',
  other: 'Other provider'
}

/**
 * 当前 Cursor 目录按模型 id 判定厂商；显示名作为旧记录/alias 的后备。
 * 顺序有语义：Codex 属 OpenAI，Cursor Grok 仍属 xAI，Composer 才属 Cursor。
 */
export function modelProvider(modelId?: string, displayName?: string): ModelProvider {
  const value = `${modelId ?? ''} ${displayName ?? ''}`.trim().toLowerCase()
  if (!value) return 'other'
  if (/\b(auto|default)\b/.test(value)) return 'auto'
  if (/\bclaude\b|\bfable\b|\b(anthropic)\b/.test(value)) return 'anthropic'
  if (/\bgpt[- ]|\bcodex\b|\bopenai\b/.test(value)) return 'openai'
  if (/\bgemini\b|\bgoogle\b/.test(value)) return 'google'
  if (/\bgrok\b|\bxai\b|\bx\.ai\b/.test(value)) return 'xai'
  if (/\bkimi\b|\bmoonshot\b/.test(value)) return 'moonshot'
  if (/\bglm\b|\bzhipu\b/.test(value)) return 'zhipu'
  if (/\bcomposer\b|\bcursor\b/.test(value)) return 'cursor'
  return 'other'
}

export function modelProviderClass(modelId?: string, displayName?: string): string {
  return `provider-${modelProvider(modelId, displayName)}`
}

export function modelProviderLabel(modelId?: string, displayName?: string): string {
  return PROVIDER_LABELS[modelProvider(modelId, displayName)]
}
