import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_ACCOUNT_AUTOMATION_SETTINGS,
  normalizeAccountAutomationSettings,
  type AccountAutomationSettings
} from '../domain/account-automation'

interface AccountAutomationFile {
  version: 1
  settings: AccountAutomationSettings
}

/** 账号自动化设置的本地持久化（userData/account-automation.json，原子写）。 */
export class AccountAutomationSettingsStore {
  constructor(readonly path: string) {}

  load(): AccountAutomationSettings {
    try {
      if (!existsSync(this.path)) return { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS }
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AccountAutomationFile>
      if (parsed.version !== 1) return { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS }
      return normalizeAccountAutomationSettings(parsed.settings)
    } catch {
      return { ...DEFAULT_ACCOUNT_AUTOMATION_SETTINGS }
    }
  }

  save(settings: unknown): AccountAutomationSettings {
    const normalized = normalizeAccountAutomationSettings(settings)
    mkdirSync(dirname(this.path), { recursive: true })
    const file: AccountAutomationFile = { version: 1, settings: normalized }
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
    return normalized
  }
}
