import { useMemo, useState } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import { normalizeEscapedNewlines } from '../../domain/conversation-entry'
import { MessageContent } from './MessageContent'

/** 过程条目：工具动作分组 → 中文动作名（对齐 Cursor 原生过程视图）。 */
const WORK_TOOL_ACTION: Record<string, string> = {
  command: '运行命令',
  read: '读取文件',
  search: '搜索',
  edit: '编辑文件',
  write: '写入文件',
  mcp: '',
  todo: '任务清单',
  other: ''
}

/** 过程条目：节点字符（纯排版符号，随分组着色）。 */
const WORK_TOOL_GLYPH: Record<string, string> = {
  command: '›_',
  read: '≡',
  search: '⌕',
  edit: '✎',
  write: '+',
  mcp: '⇄',
  todo: '☷',
  other: '·'
}

/** 聚合组动作名（对齐 Cursor 原生「Explored N files」语义）。 */
const WORK_GROUP_ACTION: Record<string, string> = {
  read: '读取文件',
  search: '搜索'
}

type WorkEntry = NonNullable<AgentSession['workEntries']>[number]

interface CursorProcessPanelProps {
  entries: WorkEntry[]
  title?: string
  variant?: 'primary' | 'inline'
}

type WorkDisplayItem =
  | { type: 'single'; entry: WorkEntry; key: string }
  | { type: 'group'; toolKind: 'read' | 'search'; entries: WorkEntry[]; key: string }

function workActionName(entry: WorkEntry): string {
  if (entry.toolKind === 'mcp') return entry.toolName ?? 'MCP 工具'
  return WORK_TOOL_ACTION[entry.toolKind ?? 'other'] || entry.toolName || '工具调用'
}

/** 工具摘要：解析侧文本为「工具名 参数」，动作名已表达类型，摘要只留参数。 */
function workToolSummaryText(entry: WorkEntry): string {
  if (entry.toolKind === 'mcp' || entry.toolKind === 'todo') return ''
  const prefix = entry.toolName ? `${entry.toolName} ` : ''
  const text = prefix && entry.text.startsWith(prefix) ? entry.text.slice(prefix.length) : entry.text
  return normalizeEscapedNewlines(text)
}

function workVisibleText(text: string): string {
  return normalizeEscapedNewlines(text)
}

function workDetailClass(kind: NonNullable<WorkEntry['details']>[number]['kind']): string {
  return kind === 'code' ? 'is-code' : kind === 'path' ? 'is-path' : ''
}

/** 连续 >=2 个读取/搜索调用聚合为一组（对齐 Cursor 原生 Explored 聚合）。 */
function groupWorkEntries(entries: WorkEntry[]): WorkDisplayItem[] {
  const items: WorkDisplayItem[] = []
  let pending: { entry: WorkEntry; key: string }[] = []
  let pendingKind: 'read' | 'search' | '' = ''

  const flush = (): void => {
    if (pending.length >= 2) {
      items.push({
        type: 'group',
        toolKind: pendingKind as 'read' | 'search',
        entries: pending.map((entry) => entry.entry),
        key: `g:${pending[0]!.key}`
      })
    } else {
      pending.forEach((entry) => items.push({ type: 'single', entry: entry.entry, key: entry.key }))
    }
    pending = []
    pendingKind = ''
  }

  entries.forEach((entry, index) => {
    const key = `${entry.line}:${index}`
    const groupable = entry.kind === 'tool' && (entry.toolKind === 'read' || entry.toolKind === 'search')
    if (groupable && entry.toolKind === pendingKind) {
      pending.push({ entry, key })
      return
    }
    flush()
    if (groupable) {
      pendingKind = entry.toolKind as 'read' | 'search'
      pending = [{ entry, key }]
    } else {
      items.push({ type: 'single', entry, key })
    }
  })
  flush()
  return items
}

export function CursorProcessPanel({ entries, title = 'Cursor 会话过程', variant = 'primary' }: CursorProcessPanelProps): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const count = entries.length
  const live = entries.some((entry) => entry.status === 'running')
  const items = useMemo(() => groupWorkEntries(entries), [entries])

  const toggleExpanded = (key: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <aside
      className={`workspace-worklog workspace-worklog--${variant} ${open ? '' : 'is-collapsed'}`}
      title="本地 Cursor transcript 还原；Cursor 未持久化的工具输出不会伪造展示。"
    >
      <button
        className="workspace-worklog__header"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <strong>{title}</strong>
        <span>{live ? '正在工作' : '已完成'} · {count} 条</span>
        <i aria-hidden="true">{open ? '▾' : '▸'}</i>
      </button>
      {open && (
        <div className="workspace-worklog__list">
          <ol className="worklog-flow">
            {items.map((item) => {
              if (item.type === 'group') {
                const itemExpanded = expanded.has(item.key)
                const groupLive = item.entries.some((entry) => entry.status === 'running')
                return (
                  <li key={item.key} className="worklog-item worklog-item--group">
                    <span className={`worklog-node worklog-node--${item.toolKind}`} aria-hidden="true">
                      {WORK_TOOL_GLYPH[item.toolKind]}
                    </span>
                    <div className="worklog-body worklog-body--stack">
                      <button className="worklog-grouphead" onClick={() => toggleExpanded(item.key)} aria-expanded={itemExpanded}>
                        <span className="worklog-action">{WORK_GROUP_ACTION[item.toolKind]} × {item.entries.length}</span>
                        <span className={`worklog-status worklog-status--${groupLive ? 'running' : 'done'}`}>
                          {groupLive ? <><i className="worklog-pulse" />运行中</> : '完成'}
                        </span>
                        <i className="worklog-caret" aria-hidden="true">{itemExpanded ? '▾' : '▸'}</i>
                      </button>
                      {itemExpanded && (
                        <ul className="worklog-groupitems">
                          {item.entries.map((entry, sub) => (
                            <li key={`${item.key}:${sub}`}><code>{workToolSummaryText(entry)}</code></li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </li>
                )
              }

              const { entry, key } = item
              const itemExpanded = expanded.has(key)
              if (entry.kind === 'tool') {
                if (entry.toolKind === 'todo' && entry.todos?.length) {
                  return (
                    <li key={key} className="worklog-item worklog-item--todo">
                      <span className="worklog-node worklog-node--todo" aria-hidden="true">{WORK_TOOL_GLYPH.todo}</span>
                      <div className="worklog-todos">
                        <header>To-dos <b>{entry.todos.length}</b></header>
                        <ul>
                          {entry.todos.map((todo, sub) => (
                            <li key={`${key}:${sub}`} className={`is-${todo.status}`}>
                              <i aria-hidden="true">
                                {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : todo.status === 'cancelled' ? '✕' : '○'}
                              </i>
                              <span>{workVisibleText(todo.content)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </li>
                  )
                }

                const summary = workToolSummaryText(entry)
                const hasDetails = Boolean(entry.details?.length)
                const clickable = hasDetails || Boolean(summary)
                return (
                  <li key={key} className="worklog-item worklog-item--tool">
                    <span className={`worklog-node worklog-node--${entry.toolKind ?? 'other'}`} aria-hidden="true">
                      {WORK_TOOL_GLYPH[entry.toolKind ?? 'other']}
                    </span>
                    <div className={`worklog-body ${hasDetails ? 'worklog-body--stack' : ''}`}>
                      <button
                        className={`worklog-toolhead ${clickable ? 'is-clickable' : ''}`}
                        disabled={!clickable}
                        onClick={() => {
                          if (clickable) toggleExpanded(key)
                        }}
                        aria-expanded={hasDetails ? itemExpanded : undefined}
                      >
                        <span className={`worklog-action ${entry.toolKind === 'mcp' ? 'worklog-action--mono' : ''}`}>{workActionName(entry)}</span>
                        {summary && (
                          <code
                            className={`worklog-summary ${itemExpanded && !hasDetails ? 'is-expanded' : ''}`}
                            title={itemExpanded ? undefined : summary}
                          >{summary}</code>
                        )}
                        <span className={`worklog-status worklog-status--${entry.status ?? 'done'}`}>
                          {entry.status === 'running' ? <><i className="worklog-pulse" />运行中</> : '完成'}
                        </span>
                        {hasDetails ? <i className="worklog-caret" aria-hidden="true">{itemExpanded ? '▾' : '▸'}</i> : null}
                      </button>
                      {hasDetails && itemExpanded && (
                        <dl className="worklog-details">
                          {entry.details!.map((detail, detailIndex) => (
                            <div key={`${key}:detail:${detailIndex}`} className={workDetailClass(detail.kind)}>
                              <dt>{detail.label}</dt>
                              <dd>{detail.kind === 'code' ? <pre>{workVisibleText(detail.value)}</pre> : <code>{workVisibleText(detail.value)}</code>}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>
                  </li>
                )
              }

              return (
                <li key={key} className="worklog-item worklog-item--text">
                  <span className="worklog-node worklog-node--text" aria-hidden="true" />
                  <div className={`worklog-text ${itemExpanded ? 'is-expanded' : ''}`} onClick={() => toggleExpanded(key)}>
                    <MessageContent text={entry.text} className="worklog-markdown" />
                  </div>
                </li>
              )
            })}
            {live && (
              <li className="worklog-item worklog-item--live" aria-live="polite">
                <span className="worklog-node worklog-node--live" aria-hidden="true" />
                <span className="worklog-live-label">正在处理<i className="worklog-dots"><b /><b /><b /></i></span>
              </li>
            )}
          </ol>
        </div>
      )}
    </aside>
  )
}
