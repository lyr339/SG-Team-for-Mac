import { join } from 'node:path'

export interface TaskMcpRuntimePaths {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}

/**
 * Keep the production MCP bundle outside app.asar so Cursor can execute it as
 * a normal Node entrypoint through Electron's ELECTRON_RUN_AS_NODE mode.
 */
export function resolveTaskMcpServerPath(paths: TaskMcpRuntimePaths): string {
  return paths.isPackaged
    ? join(paths.resourcesPath, 'mcp', 'index.mjs')
    : join(paths.appPath, 'out', 'mcp', 'index.mjs')
}
