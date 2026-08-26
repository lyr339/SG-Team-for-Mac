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
}

export interface CursorModelOption extends CursorModelSelection {
  selected: boolean
  optionLabels: string[]
  parameterDefinitions: CursorModelParameterDefinition[]
  contextTokenLimit?: number
}
