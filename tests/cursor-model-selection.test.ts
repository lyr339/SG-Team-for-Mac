import { describe, expect, it } from 'vitest'
import type { CursorModelOption, CursorModelSelection } from '../src/domain/cursor-model'
import {
  cursorModelAutomaticChanges,
  cursorModelSelectionSummary,
  fixedCursorModelContext,
  normalizeCursorModelSelection,
  withCursorModelParameter,
  withCursorModelMaxMode
} from '../src/renderer/src/cursor-model-selection'

const kimi: CursorModelOption = {
  modelId: 'kimi-k3',
  displayName: 'Kimi K3',
  selected: true,
  parameters: [{ id: 'reasoning', value: 'max' }],
  maxMode: false,
  supportsMaxMode: true,
  supportsNonMaxMode: true,
  contextTokenLimit: 1_048_576,
  contextTokenLimitForMaxMode: 1_048_576,
  optionLabels: [],
  parameterDefinitions: [{
    id: 'reasoning', displayName: 'Reasoning', kind: 'enum',
    values: [{ value: 'max', displayName: 'Max', increasesCost: false }]
  }]
}

describe('Cursor model MAX Mode selection', () => {
  it('does not confuse reasoning=max with MAX Mode', () => {
    const standard: CursorModelSelection = {
      modelId: kimi.modelId,
      displayName: kimi.displayName,
      parameters: kimi.parameters,
      maxMode: false
    }
    expect(fixedCursorModelContext(kimi, standard)).toBe('200K · Standard')
    expect(cursorModelSelectionSummary(standard, kimi)).toContain('MAX Mode Off')

    const max = withCursorModelMaxMode(standard, kimi, true)
    expect(max.maxMode).toBe(true)
    expect(max.parameters).toEqual([{ id: 'reasoning', value: 'max' }])
    expect(fixedCursorModelContext(kimi, max)).toBe('1.05M · MAX Mode')
    expect(cursorModelSelectionSummary(max, kimi)).toContain('MAX Mode On')
  })
})

const gptSol: CursorModelOption = {
  modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', selected: false,
  parameters: [
    { id: 'context', value: '272k' },
    { id: 'reasoning', value: 'medium' },
    { id: 'fast', value: 'false' }
  ],
  maxMode: false, supportsMaxMode: true, supportsNonMaxMode: true, optionLabels: [],
  parameterDefinitions: [
    { id: 'context', displayName: 'Context', kind: 'enum', values: [
      { value: '272k', displayName: '272K', increasesCost: false },
      { value: '1m', displayName: '1M', increasesCost: true }
    ] },
    { id: 'reasoning', displayName: 'Reasoning', kind: 'enum', values: [
      { value: 'medium', displayName: 'Medium', increasesCost: false },
      { value: 'max', displayName: 'Max', increasesCost: false }
    ] },
    { id: 'fast', displayName: 'Fast', kind: 'boolean', values: [
      { value: 'false', displayName: 'Off', increasesCost: false },
      { value: 'true', displayName: 'Fast', increasesCost: true }
    ] }
  ],
  variants: [
    { parameters: [{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'medium' }, { id: 'fast', value: 'false' }], maxMode: false, isDefaultNonMaxConfig: true },
    { parameters: [{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'medium' }, { id: 'fast', value: 'true' }], maxMode: false },
    { parameters: [{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'max' }, { id: 'fast', value: 'false' }], maxMode: false },
    { parameters: [{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'max' }, { id: 'fast', value: 'true' }], maxMode: false },
    { parameters: [{ id: 'context', value: '1m' }, { id: 'reasoning', value: 'medium' }, { id: 'fast', value: 'false' }], maxMode: true },
    { parameters: [{ id: 'context', value: '1m' }, { id: 'reasoning', value: 'max' }, { id: 'fast', value: 'false' }], maxMode: true }
  ],
  contextTokenLimit: 272_000,
  contextTokenLimitForMaxMode: 1_000_000
}

describe('Cursor model variant linkage', () => {
  const oneMillion: CursorModelSelection = {
    modelId: gptSol.modelId,
    displayName: gptSol.displayName,
    parameters: [
      { id: 'context', value: '1m' },
      { id: 'reasoning', value: 'max' },
      { id: 'fast', value: 'false' }
    ],
    maxMode: true
  }

  it('turning Fast on follows Cursor and drops 1M to 272K', () => {
    const next = withCursorModelParameter(oneMillion, gptSol, 'fast', 'true')
    expect(next.parameters).toEqual([
      { id: 'context', value: '272k' },
      { id: 'reasoning', value: 'max' },
      { id: 'fast', value: 'true' }
    ])
    expect(next.maxMode).toBe(false)
    expect(cursorModelAutomaticChanges(oneMillion, next, gptSol, 'fast'))
      .toEqual(['Context → 272K', 'MAX Mode → Off'])
  })

  it('selecting 1M while Fast is on follows Cursor and turns Fast off', () => {
    const fast = withCursorModelParameter(oneMillion, gptSol, 'fast', 'true')
    const next = withCursorModelParameter(fast, gptSol, 'context', '1m')
    expect(next.parameters.find((parameter) => parameter.id === 'fast')?.value).toBe('false')
    expect(next.parameters.find((parameter) => parameter.id === 'context')?.value).toBe('1m')
    expect(next.maxMode).toBe(true)
  })

  it('normalizes an old impossible 1M + Fast selection to a real Cursor variant', () => {
    const normalized = normalizeCursorModelSelection({
      ...oneMillion,
      parameters: oneMillion.parameters.map((parameter) => (
        parameter.id === 'fast' ? { ...parameter, value: 'true' } : parameter
      ))
    }, gptSol)
    expect(gptSol.variants?.some((variant) => (
      variant.maxMode === normalized.maxMode
      && JSON.stringify(variant.parameters) === JSON.stringify(normalized.parameters)
    ))).toBe(true)
  })
})
