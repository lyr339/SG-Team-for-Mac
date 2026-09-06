import { useState } from 'react'
import { formatClock } from '../format'
import type { ActivityBlockStatus, ActivityCommand, ActivityTurn, ActivityView } from './activity-view'
import { Collapsible } from './Collapsible'
import { ActivityIcon, ChevronIcon, CopyIcon, FileGlyph, GlobeGlyph, PlugGlyph, SearchGlyph, TargetGlyph, TerminalGlyph } from './InspectorIcons'
import type { InspectorTabId } from './InspectorShell'
import { InspectorGroupLabel, InspectorSectionHeader, InspectorState, InspectorToast, useTransientFeedback } from './InspectorState'
import { useWorkspaceFileActions, type WorkspaceFileActions } from './use-workspace-file-actions'

function statusClass(status: ActivityBlockStatus): string {
  return `is-${status}`
}

function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1_000) return `${Math.max(0.1, ms / 1_000).toFixed(1)}s`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function commandFailed(command: ActivityCommand): boolean {
  return command.status === 'failed' || (command.exitCode !== undefined && command.exitCode !== 0)
}

/** 行尾动作簇：定位 + 可选的复制；悬停 / 键盘聚焦时显示。 */
function RowActions({ locateLabel, onLocate, onCopy }: { locateLabel: string; onLocate: () => void; onCopy?: () => void }): React.JSX.Element {
  return (
    <span className="activity-row__actions">
      {onCopy ? <button type="button" className="inspector-icon-button" title="复制" aria-label={`复制 ${locateLabel}`} onClick={onCopy}><CopyIcon /></button> : null}
      <button type="button" className="inspector-icon-button" title="在时间线中定位" aria-label={`在时间线中定位 ${locateLabel}`} onClick={onLocate}><TargetGlyph /></button>
    </span>
  )
}

function CommandRow({ command, actions }: { command: ActivityCommand; actions: WorkspaceFileActions }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const failed = commandFailed(command)
  const hasOutput = Boolean(command.output?.trim())
  return (
    <li className={`activity-command ${failed ? 'is-failed' : statusClass(command.status)}${open ? ' is-open' : ''}`}>
      <div className="activity-row">
        <button type="button" className="activity-row__main" disabled={!hasOutput} aria-expanded={hasOutput ? open : undefined} onClick={() => setOpen((value) => !value)} title={command.command}>
          <span className="activity-row__icon"><TerminalGlyph /></span>
          <code>{command.command}</code>
          <span className="activity-row__meta">
            {command.exitCode !== undefined ? <em className={command.exitCode === 0 ? 'is-ok' : 'is-bad'}>exit {command.exitCode}</em> : command.status === 'running' ? <em className="is-running"><i />运行中</em> : failed ? <em className="is-bad">失败</em> : null}
            {formatDuration(command.durationMs) ? <time>{formatDuration(command.durationMs)}</time> : null}
            {hasOutput ? <ChevronIcon open={open} /> : null}
          </span>
        </button>
        <RowActions
          locateLabel="这条命令"
          onLocate={() => void actions.reveal({ blockId: command.blockId })}
          onCopy={() => void actions.copyText(command.command, '命令已复制')}
        />
      </div>
      {hasOutput ? (
        <Collapsible open={open}>
          <pre className="activity-command__output">{command.output}</pre>
        </Collapsible>
      ) : null}
    </li>
  )
}

function TurnSection({ turn, defaultOpen, actions }: { turn: ActivityTurn; defaultOpen: boolean; actions: WorkspaceFileActions }): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const summary = [
    turn.files.length ? `${turn.files.length} 个文件` : '',
    turn.commands.length ? `${turn.commands.length} 条命令` : '',
    turn.sources.length ? `${turn.sources.length} 个来源` : '',
    turn.tools.length ? `${turn.tools.length} 个工具` : '',
    turn.thinkingMs > 0 ? `思考 ${formatDuration(turn.thinkingMs)}` : ''
  ].filter(Boolean).join(' · ')
  const quiet = !turn.files.length && !turn.commands.length && !turn.sources.length && !turn.tools.length
  return (
    <section className={`activity-turn${turn.live ? ' is-live' : ''}${open ? ' is-open' : ''}`}>
      <button type="button" className="activity-turn__head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="activity-turn__title">
          {turn.live ? <i className="activity-turn__pulse" aria-hidden="true" /> : null}
          <strong>{turn.prompt ?? '过程记录'}</strong>
        </span>
        <span className="activity-turn__meta">
          {turn.at ? <time>{formatClock(turn.at)}</time> : null}
          <ChevronIcon open={open} />
        </span>
      </button>
      <Collapsible open={open}>
        <div className="activity-turn__body">
          {summary ? <p className="activity-turn__summary">{summary}</p> : null}
          {turn.files.length ? (
            <>
              <InspectorGroupLabel count={turn.files.length}>改动文件</InspectorGroupLabel>
              <ul className="activity-list">
                {turn.files.map((file) => (
                  <li key={file.path} className={`activity-file ${statusClass(file.status)}`}>
                    <div className="activity-row">
                      <span className="activity-row__main" title={file.path}>
                        <span className="activity-row__icon"><FileGlyph /></span>
                        <code>{file.display}</code>
                        <span className="activity-row__meta">
                          <em className="activity-kind">{file.kinds.includes('write') && !file.kinds.includes('edit') ? '写入' : '修改'}{file.count > 1 ? ` ×${file.count}` : ''}</em>
                          {file.status === 'running' ? <em className="is-running"><i />进行中</em> : null}
                        </span>
                      </span>
                      <RowActions
                        locateLabel={file.display}
                        onLocate={() => void actions.reveal({ blockId: file.blockId })}
                        onCopy={() => void actions.copyPath(file.path)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {turn.commands.length ? (
            <>
              <InspectorGroupLabel count={turn.commands.length}>命令</InspectorGroupLabel>
              <ul className="activity-list">
                {turn.commands.map((command) => <CommandRow key={command.blockId} command={command} actions={actions} />)}
              </ul>
            </>
          ) : null}
          {turn.sources.length ? (
            <>
              <InspectorGroupLabel count={turn.sources.length}>来源</InspectorGroupLabel>
              <ul className="activity-list">
                {turn.sources.map((source) => (
                  <li key={`${source.kind}:${source.label}`} className={`activity-source ${statusClass(source.status)}`}>
                    <div className="activity-row">
                      <span className="activity-row__main" title={source.label}>
                        <span className="activity-row__icon">{source.kind === 'read' ? <FileGlyph /> : source.kind === 'search' ? <SearchGlyph /> : <GlobeGlyph />}</span>
                        <code>{source.label}</code>
                        <span className="activity-row__meta">
                          <em className="activity-kind">{source.kind === 'read' ? '读取' : source.kind === 'search' ? '搜索' : '浏览'}{source.count > 1 ? ` ×${source.count}` : ''}</em>
                        </span>
                      </span>
                      <RowActions locateLabel={source.label} onLocate={() => void actions.reveal({ blockId: source.blockId })} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {turn.tools.length ? (
            <>
              <InspectorGroupLabel count={turn.tools.length}>工具调用</InspectorGroupLabel>
              <ul className="activity-list">
                {turn.tools.map((tool) => (
                  <li key={`${tool.server ?? ''}:${tool.toolName}`} className={`activity-tool ${statusClass(tool.status)}`}>
                    <div className="activity-row">
                      <span className="activity-row__main" title={tool.server ? `${tool.server} · ${tool.toolName}` : tool.toolName}>
                        <span className="activity-row__icon"><PlugGlyph /></span>
                        <code>{tool.server ? <small>{tool.server} / </small> : null}{tool.toolName}</code>
                        <span className="activity-row__meta">
                          {tool.count > 1 ? <em className="activity-kind">×{tool.count}</em> : null}
                          {tool.status === 'failed' ? <em className="is-bad">失败</em> : tool.status === 'running' ? <em className="is-running"><i />进行中</em> : null}
                        </span>
                      </span>
                      <RowActions locateLabel={tool.toolName} onLocate={() => void actions.reveal({ blockId: tool.blockId })} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {quiet ? <p className="activity-turn__quiet">这一轮只有思考与回复，没有文件、命令或工具活动</p> : null}
        </div>
      </Collapsible>
    </section>
  )
}

export function ActivityPanel({ view, onOpenTab }: { view: ActivityView; onOpenTab?: (tab: InspectorTabId) => void }): React.JSX.Element {
  const [feedback, flash] = useTransientFeedback()
  const actions = useWorkspaceFileActions(flash)
  const { totals, turns } = view
  const stats = [
    totals.files ? `${totals.files} 个文件` : '',
    totals.commands ? `${totals.commands} 条命令${totals.failedCommands ? `（${totals.failedCommands} 失败）` : ''}` : '',
    totals.sources ? `${totals.sources} 个来源` : '',
    totals.tools ? `${totals.tools} 个工具` : ''
  ].filter(Boolean).join(' · ')
  return (
    <section className="inspector-activity" aria-label="会话活动">
      <InspectorSectionHeader title="活动" hint={stats || '本会话的文件、命令、来源与工具调用'} aside={turns.length ? <b className="inspector-activity__turns">{turns.length} 轮</b> : null} />
      {turns.length ? (
        <div className="inspector-activity__turns-list">
          {turns.map((turn, index) => <TurnSection key={turn.key} turn={turn} defaultOpen={index === 0} actions={actions} />)}
        </div>
      ) : (
        <InspectorState
          icon={<ActivityIcon />}
          title="还没有活动"
          hint="Agent 读取、修改文件或运行命令后，这里按回合归类展示，可一键跳回时间线"
          action={onOpenTab ? <button type="button" className="inspector-link" onClick={() => onOpenTab('review')}>查看工作区变更</button> : undefined}
        />
      )}
      <InspectorToast message={feedback} />
    </section>
  )
}
