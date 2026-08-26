import { useMemo, useState } from 'react'
import {
  normalizeProcessBlockText,
  type ProcessBlock,
  type ProcessBlockTool,
  type ProcessBlockThinking,
  type ProcessBlockCommand
} from '../../domain/conversation-entry'

/** 过程区块图标（对齐 Cursor 原生过程视图符号）。 */
const PROCESS_GLYPH: Record<ProcessBlock['kind'], string> = {
  tool: '›_',
  thinking: '◌',
  command: '›_'
}

/** 过程区块中文动作名。 */
const PROCESS_ACTION: Record<ProcessBlock['kind'], string> = {
  tool: '工具调用',
  thinking: '思考',
  command: '命令'
}

function toolActionName(block: ProcessBlockTool): string {
  if (block.toolKind === 'mcp') return block.toolName || 'MCP 工具'
  const names: Record<string, string> = {
    command: '运行命令',
    read: '读取文件',
    search: '搜索',
    edit: '编辑文件',
    write: '写入文件',
    todo: '任务清单',
    other: '工具调用'
  }
  return names[block.toolKind ?? 'other'] || block.toolName || '工具调用'
}

function ToolBlock({ block, expanded, onToggle }: {
  block: ProcessBlockTool
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const hasDetails = Boolean(block.input || block.output || block.error)
  const statusLabel = block.status === 'running' ? '运行中' : block.status === 'failed' ? '失败' : '完成'
  const disclosureProps = hasDetails ? { 'aria-expanded': expanded } : {}
  return (
    <li className={`process-block process-block--tool ${block.status === 'failed' ? 'is-failed' : ''}`}>
      <span className={`process-node process-node--${block.toolKind ?? 'other'}`} aria-hidden="true">
        {PROCESS_GLYPH.tool}
      </span>
      <div className={`process-body ${hasDetails ? 'process-body--stack' : ''}`}>
        <button
          className={`process-head ${hasDetails ? 'is-clickable' : ''}`}
          disabled={!hasDetails}
          onClick={onToggle}
          {...disclosureProps}
        >
          <span className="process-action">{toolActionName(block)}</span>
          {block.summary && (
            <code className="process-summary" title={block.summary}>{block.summary}</code>
          )}
          <span className={`process-status process-status--${block.status}`}>
            {block.status === 'running' ? <><i className="process-pulse" />运行中</> : statusLabel}
          </span>
          {hasDetails ? <i className="process-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</i> : null}
        </button>
        {expanded && hasDetails && (
          <div className="process-details">
            {block.input && Object.keys(block.input).length > 0 && (
              <div className="process-detail-section">
                <dt>输入</dt>
                <dd><pre>{JSON.stringify(block.input, null, 2)}</pre></dd>
              </div>
            )}
            {block.output && (
              <div className="process-detail-section">
                <dt>输出</dt>
                <dd><pre>{block.output}</pre></dd>
              </div>
            )}
            {block.error && (
              <div className="process-detail-section is-error">
                <dt>错误</dt>
                <dd><pre>{block.error}</pre></dd>
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

function ThinkingBlock({ block, expanded, onToggle }: {
  block: ProcessBlockThinking
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const preview = block.text.slice(0, 120)
  const needsCollapse = block.text.length > 120
  const disclosureProps = needsCollapse ? { 'aria-expanded': expanded } : {}
  return (
    <li className="process-block process-block--thinking">
      <span className="process-node process-node--thinking" aria-hidden="true">
        {PROCESS_GLYPH.thinking}
      </span>
      <div className="process-body process-body--stack">
        <button
          className={`process-head ${needsCollapse ? 'is-clickable' : ''}`}
          disabled={!needsCollapse}
          onClick={onToggle}
          {...disclosureProps}
        >
          <span className="process-action">{PROCESS_ACTION.thinking}</span>
          <span className="process-thinking-preview">
            {preview}{needsCollapse && !expanded ? '…' : ''}
          </span>
          <span className={`process-status process-status--${block.status}`}>
            {block.status === 'running' ? <><i className="process-pulse" />进行中</> : '完成'}
          </span>
          {needsCollapse ? <i className="process-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</i> : null}
        </button>
        {expanded && needsCollapse && (
          <div className="process-details">
            <div className="process-detail-section process-detail-section--full">
              <dd><pre className="process-thinking-full">{block.text}</pre></dd>
            </div>
          </div>
        )}
      </div>
    </li>
  )
}

function CommandBlock({ block, expanded, onToggle }: {
  block: ProcessBlockCommand
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const hasOutput = Boolean(block.output)
  const statusLabel = block.status === 'running' ? '运行中' : block.status === 'failed' ? `失败${block.exitCode !== undefined ? ` (${block.exitCode})` : ''}` : '完成'
  const disclosureProps = hasOutput ? { 'aria-expanded': expanded } : {}
  return (
    <li className={`process-block process-block--command ${block.status === 'failed' ? 'is-failed' : ''}`}>
      <span className="process-node process-node--command" aria-hidden="true">
        {PROCESS_GLYPH.command}
      </span>
      <div className={`process-body ${hasOutput ? 'process-body--stack' : ''}`}>
        <button
          className={`process-head ${hasOutput ? 'is-clickable' : ''}`}
          disabled={!hasOutput}
          onClick={onToggle}
          {...disclosureProps}
        >
          <span className="process-action">{PROCESS_ACTION.command}</span>
          <code className="process-summary process-command" title={block.command}>{block.command}</code>
          <span className={`process-status process-status--${block.status}`}>
            {block.status === 'running' ? <><i className="process-pulse" />运行中</> : statusLabel}
          </span>
          {hasOutput ? <i className="process-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</i> : null}
        </button>
        {expanded && hasOutput && (
          <div className="process-details">
            <div className="process-detail-section">
              <dt>输出</dt>
              <dd><pre>{block.output}</pre></dd>
            </div>
          </div>
        )}
      </div>
    </li>
  )
}

export function ProcessBlocks({ blocks }: { blocks: ProcessBlock[] }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const normalizedBlocks = useMemo(() => blocks.map(normalizeProcessBlockText), [blocks])
  if (normalizedBlocks.length === 0) return null

  const toggle = (id: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="process-blocks" title="助手过程区块">
      <ol className="process-flow">
        {normalizedBlocks.map((block) => {
          const isExpanded = expanded.has(block.id)
          const onToggle = (): void => toggle(block.id)
          switch (block.kind) {
            case 'tool':
              return <ToolBlock key={block.id} block={block} expanded={isExpanded} onToggle={onToggle} />
            case 'thinking':
              return <ThinkingBlock key={block.id} block={block} expanded={isExpanded} onToggle={onToggle} />
            case 'command':
              return <CommandBlock key={block.id} block={block} expanded={isExpanded} onToggle={onToggle} />
            default:
              return null
          }
        })}
      </ol>
    </div>
  )
}
