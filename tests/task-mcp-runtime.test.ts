import { describe, expect, it } from 'vitest'
import { resolveTaskMcpServerPath } from '../src/main/task-mcp-runtime'

describe('resolveTaskMcpServerPath', () => {
  it('uses the build output while developing', () => {
    expect(resolveTaskMcpServerPath({
      isPackaged: false,
      appPath: '/workspace/qingtian-team',
      resourcesPath: '/ignored'
    })).toBe('/workspace/qingtian-team/out/mcp/index.mjs')
  })

  it('uses an unpacked resource in a packaged app', () => {
    expect(resolveTaskMcpServerPath({
      isPackaged: true,
      appPath: '/Applications/群枢.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/群枢.app/Contents/Resources'
    })).toBe('/Applications/群枢.app/Contents/Resources/mcp/index.mjs')
  })
})
