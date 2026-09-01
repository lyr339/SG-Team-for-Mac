import type {
  CursorModelOption,
  CursorModelParameterDefinition,
  CursorModelSelection,
  CursorModelVariant
} from '../../domain/cursor-model'
import {
  cursorVariantResolvedMode,
  cursorVariantSupportsMode
} from '../../domain/cursor-model-variants'
import { formatTokenCount } from './format'

export function cursorModelSelectionFromOption(
  option: CursorModelOption | undefined
): CursorModelSelection | undefined {
  if (!option) return undefined
  return normalizeCursorModelSelection({
    modelId: option.modelId,
    displayName: option.displayName,
    parameters: structuredClone(option.parameters),
    maxMode: option.maxMode === true
  }, option)
}

export function cursorModelParameterLabel(definition: CursorModelParameterDefinition): string {
  // `displayName` 直接来自 Cursor 当前模型目录的 parameterDefinitions[].name。
  // 不在拾光侧按 id 翻译或猜测，避免 Cursor 新增/改名参数后语义漂移。
  return definition.displayName
}

export function cursorModelParameterValue(
  selection: CursorModelSelection | undefined,
  option: CursorModelOption,
  definition: CursorModelParameterDefinition
): string {
  return selection?.parameters.find((parameter) => parameter.id === definition.id)?.value
    ?? option.parameters.find((parameter) => parameter.id === definition.id)?.value
    ?? definition.values[0]?.value
    ?? ''
}

export function withCursorModelParameter(
  selection: CursorModelSelection,
  option: CursorModelOption,
  parameterId: string,
  value: string
): CursorModelSelection {
  const variant = bestCursorVariant(option, selection, { parameterId, value })
  if (variant) return selectionFromVariant(selection, option, variant)
  return {
    ...selection,
    parameters: [
      ...selection.parameters.filter((parameter) => parameter.id !== parameterId),
      { id: parameterId, value }
    ]
  }
}

export function withCursorModelMaxMode(
  selection: CursorModelSelection,
  option: CursorModelOption,
  maxMode: boolean
): CursorModelSelection {
  const variant = bestCursorVariant(option, selection, { maxMode })
  if (variant) return selectionFromVariant(selection, option, variant, maxMode)
  return {
    ...selection,
    maxMode: option.supportsNonMaxMode === false ? true : option.supportsMaxMode === true && maxMode
  }
}

function parameterMap(selection: Pick<CursorModelSelection, 'parameters'>): Map<string, string> {
  return new Map(selection.parameters.map((parameter) => [parameter.id, parameter.value]))
}

function selectionFromVariant(
  selection: CursorModelSelection,
  option: CursorModelOption,
  variant: CursorModelVariant,
  preferredMaxMode = selection.maxMode === true
): CursorModelSelection {
  const values = parameterMap(variant)
  return {
    ...selection,
    modelId: option.modelId,
    displayName: option.displayName,
    parameters: option.parameterDefinitions.flatMap((definition) => {
      const value = values.get(definition.id)
      return value === undefined ? [] : [{ id: definition.id, value }]
    }),
    maxMode: cursorVariantResolvedMode(option, variant, preferredMaxMode)
  }
}

function bestCursorVariant(
  option: CursorModelOption,
  selection: CursorModelSelection,
  constraint?: { parameterId: string; value: string } | { maxMode: boolean }
): CursorModelVariant | undefined {
  const variants = option.variants ?? []
  if (!variants.length) return undefined
  const current = parameterMap(selection)
  const candidates = variants.filter((variant) => {
    if (!constraint) return true
    if ('maxMode' in constraint) return cursorVariantSupportsMode(option, variant, constraint.maxMode)
    return parameterMap(variant).get(constraint.parameterId) === constraint.value
  })
  let best: CursorModelVariant | undefined
  let bestScore = Number.NEGATIVE_INFINITY
  for (const variant of candidates) {
    const values = parameterMap(variant)
    let score = cursorVariantResolvedMode(option, variant, selection.maxMode === true) === (selection.maxMode === true) ? 4 : 0
    for (const definition of option.parameterDefinitions) {
      if (constraint && 'parameterId' in constraint && definition.id === constraint.parameterId) continue
      if (values.get(definition.id) === current.get(definition.id)) score += 20
    }
    if (variant.isDefaultNonMaxConfig || variant.isDefaultMaxConfig) score += 1
    if (score > bestScore) {
      best = variant
      bestScore = score
    }
  }
  return best
}

/** 将旧持久化值收敛到 Cursor 当前目录中最接近的真实 variant。 */
export function normalizeCursorModelSelection(
  selection: CursorModelSelection,
  option: CursorModelOption
): CursorModelSelection {
  const variants = option.variants ?? []
  if (!variants.length) return selection
  const current = parameterMap(selection)
  const exact = variants.find((variant) => {
    const values = parameterMap(variant)
    return option.parameterDefinitions.every((definition) => (
      values.get(definition.id) === current.get(definition.id)
    )) && cursorVariantSupportsMode(option, variant, selection.maxMode === true)
  })
  return selectionFromVariant(selection, option, exact ?? bestCursorVariant(option, selection)!, selection.maxMode === true)
}

/** 返回一次选择导致的 Cursor 自动联动项，仅用于向用户解释联动。 */
export function cursorModelAutomaticChanges(
  before: CursorModelSelection,
  after: CursorModelSelection,
  option: CursorModelOption,
  directlyChangedId: string
): string[] {
  const previous = parameterMap(before)
  const next = parameterMap(after)
  const changes = option.parameterDefinitions.flatMap((definition) => {
    if (definition.id === directlyChangedId || previous.get(definition.id) === next.get(definition.id)) return []
    const value = definition.values.find((candidate) => candidate.value === next.get(definition.id))
    return value ? [`${definition.displayName} → ${value.displayName}`] : []
  })
  if (directlyChangedId !== 'maxMode' && before.maxMode !== after.maxMode) {
    changes.push(`MAX Mode → ${after.maxMode ? 'On' : 'Off'}`)
  }
  return changes
}

/**
 * Cursor 的 MAX Mode 是独立于 reasoning 等模型参数的开关。关闭时 Composer 使用
 * 标准上下文预算（最高 200K）；开启后才使用目录中的最大上下文窗口。
 */
export function fixedCursorModelContext(
  option: CursorModelOption | undefined,
  selection?: CursorModelSelection
): string | undefined {
  if (!option?.contextTokenLimit) return undefined
  if (option.parameterDefinitions.some((definition) => definition.id === 'context')) return undefined
  const maxMode = selection?.maxMode === true
  const limit = maxMode
    ? option.contextTokenLimitForMaxMode ?? option.contextTokenLimit
    : option.supportsMaxMode
      ? Math.min(option.contextTokenLimit, 200_000)
      : option.contextTokenLimit
  return `${formatTokenCount(limit)} · ${option.supportsMaxMode ? maxMode ? 'MAX Mode' : 'Standard' : 'Fixed'}`
}

export function cursorModelSelectionSummary(
  selection: CursorModelSelection | undefined,
  option: CursorModelOption | undefined
): string {
  if (!selection || !option) return '使用 Cursor 当前配置'
  const parts = option.parameterDefinitions.flatMap((definition) => {
    const value = cursorModelParameterValue(selection, option, definition)
    const valueDefinition = definition.values.find((candidate) => candidate.value === value)
    if (!valueDefinition) return []
    const label = cursorModelParameterLabel(definition)
    return [label.toLowerCase() === valueDefinition.displayName.toLowerCase()
      ? label
      : `${label} ${valueDefinition.displayName}`]
  })
  if (option.supportsMaxMode) parts.push(`MAX Mode ${selection.maxMode ? 'On' : 'Off'}`)
  const fixed = fixedCursorModelContext(option, selection)
  if (fixed) parts.push(`Context ${fixed}`)
  return parts.length ? parts.join(' · ') : '默认参数'
}
