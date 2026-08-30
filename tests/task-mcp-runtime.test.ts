import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveTaskMcpServerPath } from '../src/main/task-mcp-runtime'

// expected 用 node:path.join 生成：被测函数内部同样走 join，
// 断言在任何宿主平台都与平台的路径分隔符语义一致（mac 不变，win 自动对齐）。
describe('resolveTaskMcpServerPath', () => {
  it('uses the build output while developing', () => {
    expect(resolveTaskMcpServerPath({
      isPackaged: false,
      appPath: '/workspace/qingtian-team',
      resourcesPath: '/ignored'
    })).toBe(join('/workspace/qingtian-team', 'out', 'mcp', 'index.mjs'))
  })

  it('uses an unpacked resource in a packaged app', () => {
    expect(resolveTaskMcpServerPath({
      isPackaged: true,
      appPath: '/Applications/拾光.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/拾光.app/Contents/Resources'
    })).toBe(join('/Applications/拾光.app/Contents/Resources', 'mcp', 'index.mjs'))
  })
})
