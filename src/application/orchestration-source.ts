import { createHash } from 'node:crypto'

export interface OrchestrationSource<T> {
  getSnapshot(): T
  subscribe(listener: (snapshot: T) => void): () => void
}

export function orchestratorMessageId(kind: string, ...parts: Array<string | number>): string {
  const value = ['orchestrator', kind, ...parts].map(String).join(':')
  if (/^[a-zA-Z0-9:_-]{8,200}$/.test(value)) return value
  const safeKind = kind.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'event'
  const digest = createHash('sha256').update(value).digest('hex')
  return `orchestrator:${safeKind}:${digest}`
}
