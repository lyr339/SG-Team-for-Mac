export interface CursorModelParameter {
  id: string
  value: string
}

export interface CursorModelParameterValue {
  value: string
  displayName: string
  increasesCost: boolean
}

export interface CursorModelParameterDefinition {
  id: string
  displayName: string
  kind: 'boolean' | 'enum'
  values: CursorModelParameterValue[]
  tooltip?: string
}

export interface CursorModelSelection {
  modelId: string
  displayName: string
  parameters: CursorModelParameter[]
  maxMode?: boolean
}

/** Cursor 模型目录中的一个真实可选组合；参数间联动以 variants 为唯一依据。 */
export interface CursorModelVariant {
  parameters: CursorModelParameter[]
  maxMode: boolean
  isDefaultMaxConfig?: boolean
  isDefaultNonMaxConfig?: boolean
}

export interface CursorModelOption extends CursorModelSelection {
  selected: boolean
  optionLabels: string[]
  parameterDefinitions: CursorModelParameterDefinition[]
  variants?: CursorModelVariant[]
  supportsMaxMode?: boolean
  supportsNonMaxMode?: boolean
  contextTokenLimit?: number
  contextTokenLimitForMaxMode?: number
}
