import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_CURSOR_CDP_SETTINGS,
  normalizeCursorCdpSettings,
  type CursorCdpSettings
} from '../domain/cursor-cdp'

interface CursorCdpSettingsFile {
  version: 1
  settings: CursorCdpSettings
}

/** CDP 设置的本地持久化（userData/cursor-cdp.json，原子写）。 */
export class CursorCdpSettingsStore {
  constructor(readonly path: string) {}

  load(): CursorCdpSettings {
    try {
      if (!existsSync(this.path)) return { ...DEFAULT_CURSOR_CDP_SETTINGS }
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CursorCdpSettingsFile>
      if (parsed.version !== 1) return { ...DEFAULT_CURSOR_CDP_SETTINGS }
      return normalizeCursorCdpSettings(parsed.settings)
    } catch {
      return { ...DEFAULT_CURSOR_CDP_SETTINGS }
    }
  }

  save(settings: unknown): CursorCdpSettings {
    const normalized = normalizeCursorCdpSettings(settings)
    mkdirSync(dirname(this.path), { recursive: true })
    const file: CursorCdpSettingsFile = { version: 1, settings: normalized }
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
    return normalized
  }
}
