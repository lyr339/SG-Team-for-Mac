import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CursorUpdatePreferencesStore } from '../src/infrastructure/cursor/cursor-update-preferences'

function tempSettingsPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'qingtian-cursor-update-')), 'settings.json')
}

describe('CursorUpdatePreferencesStore', () => {
  it('reports missing settings as inherited Cursor defaults', () => {
    const path = tempSettingsPath()
    const store = new CursorUpdatePreferencesStore(path)
    expect(store.load()).toMatchObject({
      settingsPath: path,
      autoUpdateDisabled: false,
      settingsExists: false
    })
  })

  it('disables Cursor auto update by writing update.mode=none with a backup', () => {
    const path = tempSettingsPath()
    writeFileSync(path, JSON.stringify({ 'editor.formatOnSave': true }, null, 2))
    const store = new CursorUpdatePreferencesStore(path, () => Date.UTC(2026, 7, 26, 12, 0, 0))

    const result = store.setAutoUpdateDisabled(true)
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

    expect(result).toMatchObject({ changed: true, autoUpdateDisabled: true, updateMode: 'none' })
    expect(result.backupPath).toBe(`${path}.shiguang-backup-2026-08-26T12-00-00-000Z`)
    expect(existsSync(result.backupPath!)).toBe(true)
    expect(persisted['editor.formatOnSave']).toBe(true)
    expect(persisted['update.mode']).toBe('none')
  })

  it('restores Cursor default update behavior by removing update.mode=none', () => {
    const path = tempSettingsPath()
    writeFileSync(path, JSON.stringify({ 'update.mode': 'none', 'files.autoSave': 'afterDelay' }, null, 2))
    const store = new CursorUpdatePreferencesStore(path)

    const result = store.setAutoUpdateDisabled(false)
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

    expect(result.changed).toBe(true)
    expect(result.autoUpdateDisabled).toBe(false)
    expect(persisted['update.mode']).toBeUndefined()
    expect(persisted['files.autoSave']).toBe('afterDelay')
  })

  it('accepts JSONC settings with comments and trailing commas', () => {
    const path = tempSettingsPath()
    writeFileSync(path, `{
      // keep existing editor preference
      "editor.formatOnSave": true,
    }`)
    const store = new CursorUpdatePreferencesStore(path)

    expect(store.setAutoUpdateDisabled(true).autoUpdateDisabled).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))['update.mode']).toBe('none')
  })

  it('refuses to overwrite invalid settings', () => {
    const path = tempSettingsPath()
    writeFileSync(path, '{ broken json')
    const modeBefore = statSync(path).mode & 0o777
    const store = new CursorUpdatePreferencesStore(path)

    expect(() => store.setAutoUpdateDisabled(true)).toThrowError(/不是有效 JSON\/JSONC/)
    expect(readFileSync(path, 'utf8')).toBe('{ broken json')
    expect(statSync(path).mode & 0o777).toBe(modeBefore)
  })
})
