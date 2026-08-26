import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'

export interface WorkspaceIdentity {
  id: string
  name: string
  path: string
}

export function workspaceIdentityOf(inputPath: string): WorkspaceIdentity {
  const path = realpathSync(inputPath)
  return {
    id: createHash('sha256').update(path).digest('hex').slice(0, 16),
    name: basename(path) || 'Cursor 工作区',
    path
  }
}
