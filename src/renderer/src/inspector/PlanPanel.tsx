import type { ConversationEntry, ProcessBlock } from '../../../domain/conversation-entry'
import type { LiveProcessState } from '../../../shared/desktop-api'
import { PlanIcon, TargetGlyph } from './InspectorIcons'
import type { InspectorTabId } from './InspectorShell'
import { InspectorSectionHeader, InspectorState, InspectorToast, useTransientFeedback } from './InspectorState'
import { useWorkspaceFileActions } from './use-workspace-file-actions'

export interface CursorTodoItem {
  content: string
  status: string
}

export interface CursorTodoSnapshot {
  items: CursorTodoItem[]
  /** 产生这份清单的过程块（点击跳回时间线）。 */
  blockId?: string
  live: boolean
}

function latestTodoBlock(blocks: readonly ProcessBlock[] | undefined): { items: CursorTodoItem[]; blockId: string } | undefined {
  if (!blocks?.length) return undefined
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block?.kind === 'tool' && block.toolKind === 'todo' && block.todos?.length) {
      return { items: block.todos.map((todo) => ({ ...todo })), blockId: block.id }
    }
  }
  return undefined
}

/** 最新 Cursor 原生 Todo：直播帧优先，回合结束后回落到最近一条持久化过程。 */
export function currentCursorTodos(
  entries: readonly ConversationEntry[],
  liveProcess?: LiveProcessState
): CursorTodoSnapshot {
  if (liveProcess) {
    const live = latestTodoBlock(liveProcess.blocks)
    return { items: live?.items ?? [], blockId: live?.blockId, live: true }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const historical = latestTodoBlock(entries[index]?.processBlocks)
    if (historical) return { items: historical.items, blockId: historical.blockId, live: false }
  }
  return { items: [], live: false }
}

export function todoTone(status: string): 'completed' | 'running' | 'pending' | 'cancelled' {
  if (status === 'completed') return 'completed'
  if (status === 'in_progress' || status === 'running') return 'running'
  if (status === 'pending') return 'pending'
  return 'cancelled'
}

export function PlanPanel({ todos, onOpenTab }: { todos: CursorTodoSnapshot; onOpenTab?: (tab: InspectorTabId) => void }): React.JSX.Element {
  const [feedback, flash] = useTransientFeedback()
  const actions = useWorkspaceFileActions(flash)
  const items = todos.items
  const completed = items.filter((todo) => todoTone(todo.status) === 'completed').length
  const running = items.find((todo) => todoTone(todo.status) === 'running')
  // 「正在进行」只在小节头说一次；列表里的当前项以高亮行承担，不再另起横幅重复。
  const hint = running
    ? `正在进行：${running.content}`
    : todos.live ? '来自当前 Composer 的实时任务状态' : '来自当前 Composer 的原生任务状态'
  return (
    <section className="inspector-plan" aria-label="Cursor 任务清单">
      <InspectorSectionHeader
        title="Cursor Todos"
        hint={hint}
        aside={(
          <>
            {items.length ? <b className="inspector-plan__ratio">{completed}/{items.length}</b> : null}
            {todos.blockId ? (
              <button type="button" className="inspector-icon-button" title="在时间线中定位这份清单" aria-label="在时间线中定位这份清单" onClick={() => void actions.reveal({ blockId: todos.blockId })}>
                <TargetGlyph />
              </button>
            ) : null}
          </>
        )}
      />
      {items.length ? (
        <>
          <div className="inspector-plan__progress" role="progressbar" aria-label={`任务进度 ${completed}/${items.length}`} aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={completed}>
            <i style={{ width: `${Math.round((completed / items.length) * 100)}%` }} />
          </div>
          <ol className="inspector-plan__list">
            {items.map((todo, index) => {
              const tone = todoTone(todo.status)
              return (
                <li className={`is-${tone}`} key={`${index}:${todo.content}`} aria-current={tone === 'running' ? 'step' : undefined}>
                  <i aria-hidden="true">{tone === 'completed' ? '✓' : ''}</i>
                  <span>{todo.content}</span>
                  {tone === 'running' ? <em>进行中</em> : null}
                </li>
              )
            })}
          </ol>
        </>
      ) : (
        <InspectorState
          icon={<PlanIcon />}
          title="暂无任务清单"
          hint="Cursor 创建 Todo 后会在这里实时出现；Agent 处理多步任务时通常会先列清单"
          action={onOpenTab ? <button type="button" className="inspector-link" onClick={() => onOpenTab('activity')}>查看本会话的活动</button> : undefined}
        />
      )}
      <InspectorToast message={feedback} />
    </section>
  )
}
