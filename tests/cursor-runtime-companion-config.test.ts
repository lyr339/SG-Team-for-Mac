import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CursorRuntimeCompanionConfig,
  rewriteCursorRuntimeCompanion
} from '../src/infrastructure/cursor/cursor-runtime-companion-config'

function fixture(port = 51_823, key = 'old-key'): string {
  const config = Buffer.from(JSON.stringify({ port, key, revision: 1 }), 'utf8').toString('base64')
  return `prefix/*ZMO_SWITCH_CONFIG:${config}*/(()=>{const zP=${port},zK="${key}",zH={};return zP+zK})()suffix`
}

describe('CursorRuntimeCompanionConfig', () => {
  it('rewrites metadata and executable port atomically while preserving surrounding bundle bytes', () => {
    const result = rewriteCursorRuntimeCompanion(fixture(), { port: 51_824, key: 'new-key' })
    expect(result.changed).toBe(true)
    expect(result.previousPort).toBe(51_823)
    expect(result.source).toContain('prefix')
    expect(result.source).toContain('suffix')
    expect(result.source).toContain('const zP=51824,zK="new-key"')
    const encoded = result.source.match(/ZMO_SWITCH_CONFIG:([A-Za-z0-9+/=]+)/)?.[1]
    expect(JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8'))).toEqual({
      port: 51_824, key: 'new-key', revision: 2
    })
  })

  it('persists a backup once and is idempotent on the selected port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shiguang-companion-'))
    const path = join(dir, 'workbench.js')
    writeFileSync(path, fixture())
    const config = new CursorRuntimeCompanionConfig(path)
    expect(config.ensure({ port: 51_825, key: 'key-2' })).toMatchObject({ changed: true, previousPort: 51_823 })
    expect(config.ensure({ port: 51_825, key: 'key-2' })).toMatchObject({ changed: false, previousPort: 51_825 })
    expect(readFileSync(`${path}.sg-runtime-switch-backup`, 'utf8')).toBe(fixture())
  })

  it('fails closed when the installed companion anchor drifted', () => {
    expect(() => rewriteCursorRuntimeCompanion('plain Cursor bundle', { port: 51_824, key: 'key' }))
      .toThrowError(/Companion 锚点缺失/)
  })
})
