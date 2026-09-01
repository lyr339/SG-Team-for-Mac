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

/**
 * Cursor 模型目录中的一个真实参数组合。目录存在 maxMode=true 条目时 maxMode
 * 参与组合约束；目录只有 false 条目但模型 supportsMaxMode 时，MAX Mode 是正交开关。
 */
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
