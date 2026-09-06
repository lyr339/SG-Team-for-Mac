import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import type { CursorUpdatePreferences, CursorUpdateWriteResult } from '../../domain/cursor-update'
import { cursorUserDataRoot } from './cursor-install-paths'

type JsonObject = Record<string, unknown>

export function defaultCursorUserSettingsPath(currentPlatform: NodeJS.Platform = platform()): string {
  return join(cursorUserDataRoot(currentPlatform), 'User', 'settings.json')
}

function stripJsonComments(input: string): string {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    const next = input[index + 1]
    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === '/' && next === '/') {
      while (index < input.length && input[index] !== '\n') index += 1
      output += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) {
        output += input[index] === '\n' ? '\n' : ' '
        index += 1
      }
      index += 1
      continue
    }
    output += char
  }
  return output
}

function stripTrailingCommas(input: string): string {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === ',') {
      let cursor = index + 1
      while (/\s/.test(input[cursor] ?? '')) cursor += 1
      if (input[cursor] === '}' || input[cursor] === ']') continue
    }
    output += char
  }
  return output
}

function parseSettings(raw: string, path: string): JsonObject {
  try {
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(raw))) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('根节点不是对象')
    }
    return parsed as JsonObject
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Cursor 设置文件不是有效 JSON/JSONC，未改写：${path}（${message}）`)
  }
}

function settingsSnapshot(path: string, settings: JsonObject | undefined): CursorUpdatePreferences {
  const mode = typeof settings?.['update.mode'] === 'string' ? settings['update.mode'] : undefined
  return {
    settingsPath: path,
    updateMode: mode,
    autoUpdateDisabled: mode === 'none',
    settingsExists: existsSync(path),
    updatedAt: existsSync(path) ? statSync(path).mtimeMs : undefined
  }
}

function backupName(path: string, now: () => number): string {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  return `${path}.shiguang-backup-${stamp}`
}

export class CursorUpdatePreferencesStore {
  constructor(
    readonly path: string = defaultCursorUserSettingsPath(),
    private readonly now: () => number = () => Date.now()
  ) {}

  load(): CursorUpdatePreferences {
    if (!existsSync(this.path)) return settingsSnapshot(this.path, undefined)
    return settingsSnapshot(this.path, parseSettings(readFileSync(this.path, 'utf8'), this.path))
  }

  setAutoUpdateDisabled(disabled: boolean): CursorUpdateWriteResult {
    const exists = existsSync(this.path)
    const original = exists ? readFileSync(this.path, 'utf8') : '{}'
    const settings = parseSettings(original, this.path)
    const previous = typeof settings['update.mode'] === 'string' ? settings['update.mode'] : undefined

    if (disabled) {
      settings['update.mode'] = 'none'
    } else if (previous === 'none') {
      delete settings['update.mode']
    }

    const changed = (typeof settings['update.mode'] === 'string' ? settings['update.mode'] : undefined) !== previous
    if (!changed) return { ...settingsSnapshot(this.path, settings), changed: false }

    mkdirSync(dirname(this.path), { recursive: true })
    const backupPath = exists ? backupName(this.path, this.now) : undefined
    if (backupPath) copyFileSync(this.path, backupPath)
    const mode = exists ? statSync(this.path).mode & 0o777 : 0o600
    const temporary = `${this.path}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode })
    chmodSync(temporary, mode)
    renameSync(temporary, this.path)
    chmodSync(this.path, mode)
    return { ...settingsSnapshot(this.path, settings), changed: true, backupPath }
  }
}
