export interface CursorUpdatePreferences {
  settingsPath: string
  updateMode?: string
  autoUpdateDisabled: boolean
  settingsExists: boolean
  updatedAt?: number
}

export interface CursorUpdateWriteResult extends CursorUpdatePreferences {
  changed: boolean
  backupPath?: string
}
