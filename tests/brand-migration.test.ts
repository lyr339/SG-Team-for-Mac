// @vitest-environment jsdom
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveUserDataDirectory, USER_DATA_DIRECTORY_NAME } from '../src/main/user-data-directory'
import { migrateLegacyStorageKeys } from '../src/renderer/src/storage-migration'

describe('brand migration: user data directory', () => {
  const appData = join('/', 'AppData')
  const fakeFs = (existing: string[]) => {
    const present = new Set(existing)
    const renames: Array<[string, string]> = []
    return {
      renames,
      fs: {
        existsSync: (path: string) => present.has(path),
        renameSync: (from: string, to: string) => {
          renames.push([from, to])
          present.delete(from)
          present.add(to)
        }
      }
    }
  }

  it('renames the previous brand directory in place on first launch', () => {
    const legacy = join(appData, 'qingtian-team')
    const current = join(appData, USER_DATA_DIRECTORY_NAME)
    const { fs, renames } = fakeFs([legacy])
    expect(resolveUserDataDirectory(appData, true, fs)).toBe(current)
    expect(renames).toEqual([[legacy, current]])
  })

  it('keeps the dev/packaged split and never touches an existing current directory', () => {
    const { fs, renames } = fakeFs([join(appData, 'qingtian-team-dev'), join(appData, 'sg-team-dev')])
    expect(resolveUserDataDirectory(appData, false, fs)).toBe(join(appData, 'sg-team-dev'))
    expect(renames).toEqual([])
  })

  it('uses the current name directly when there is nothing to migrate', () => {
    const { fs, renames } = fakeFs([])
    expect(resolveUserDataDirectory(appData, true, fs)).toBe(join(appData, 'sg-team'))
    expect(renames).toEqual([])
  })

  it('falls back to the legacy directory when the rename fails, so no data goes missing', () => {
    const legacy = join(appData, 'qingtian-team')
    const warnings: string[] = []
    const fs = {
      existsSync: (path: string) => path === legacy,
      renameSync: () => { throw new Error('EPERM') }
    }
    expect(resolveUserDataDirectory(appData, true, fs, (message) => warnings.push(message))).toBe(legacy)
    expect(warnings[0]).toContain('EPERM')
  })
})

describe('brand migration: renderer localStorage keys', () => {
  afterEach(() => localStorage.clear())

  it('moves legacy-prefixed keys to the current prefix and removes the old ones', () => {
    localStorage.setItem('qingtian-team.layout:v1:shell.sessions.v2:collapsed', '1')
    localStorage.setItem('qingtian-team.inspector:active-tab', 'plan')
    localStorage.setItem('shiguang.appearance.v1', '{"theme":"dark"}')
    expect(migrateLegacyStorageKeys()).toBe(2)
    expect(localStorage.getItem('sg-team.layout:v1:shell.sessions.v2:collapsed')).toBe('1')
    expect(localStorage.getItem('sg-team.inspector:active-tab')).toBe('plan')
    expect(localStorage.getItem('qingtian-team.inspector:active-tab')).toBeNull()
    expect(localStorage.getItem('shiguang.appearance.v1')).toBe('{"theme":"dark"}')
  })

  it('prefers an existing current value over the legacy one', () => {
    localStorage.setItem('qingtian-team.inspector:active-tab', 'plan')
    localStorage.setItem('sg-team.inspector:active-tab', 'review')
    expect(migrateLegacyStorageKeys()).toBe(0)
    expect(localStorage.getItem('sg-team.inspector:active-tab')).toBe('review')
    expect(localStorage.getItem('qingtian-team.inspector:active-tab')).toBeNull()
  })
})
