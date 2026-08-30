import { describe, expect, it } from 'vitest'
import { modelProvider, modelProviderClass, modelProviderLabel } from '../src/renderer/src/model-provider'

describe('model provider visual identity', () => {
  it.each([
    ['claude-opus-5', 'Claude Opus 5', 'anthropic'],
    ['claude-fable-5', 'Claude Fable 5', 'anthropic'],
    ['gpt-5.6-sol', 'GPT-5.6 Sol', 'openai'],
    ['gpt-5.3-codex', 'Codex 5.3', 'openai'],
    ['gemini-3.7-flash', 'Gemini 3.7 Flash', 'google'],
    ['grok-4.6', 'Cursor Grok 4.6', 'xai'],
    ['kimi-k3', 'Kimi K3', 'moonshot'],
    ['glm-5.2', 'GLM 5.2', 'zhipu'],
    ['composer-2.5', 'Composer 2.5', 'cursor'],
    ['default', 'Auto', 'auto']
  ] as const)('%s maps to %s', (modelId, displayName, provider) => {
    expect(modelProvider(modelId, displayName)).toBe(provider)
    expect(modelProviderClass(modelId, displayName)).toBe(`provider-${provider}`)
  })

  it('has readable labels and a safe unknown fallback', () => {
    expect(modelProviderLabel('gpt-5.6-sol')).toBe('OpenAI')
    expect(modelProvider('future-model', 'Unknown Next')).toBe('other')
    expect(modelProviderClass('future-model')).toBe('provider-other')
  })
})
