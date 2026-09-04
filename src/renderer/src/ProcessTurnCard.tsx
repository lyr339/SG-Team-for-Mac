import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProcessBlock } from '../../domain/conversation-entry'
import { MessageContent } from './MessageContent'
import { buildProcessTurnView, type ProcessStepKind, type ProcessTurnStep } from './process-turn-view'
import { useStreamingText } from './use-streaming-text'

interface ProcessTurnCardProps {
  id: string
  blocks?: ProcessBlock[]
  startedAt?: number
  updatedAt?: number
  defaultOpen?: boolean
  compact?: boolean
  title?: string
  live?: boolean
  truncatedItemCount?: number
}

function formatDuration(milliseconds?: number): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return ''
  if (milliseconds < 1_000) return `${Math.max(0.1, milliseconds / 1_000).toFixed(1)}s`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.round((milliseconds % 60_000) / 1_000)
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function StepIcon({ kind }: { kind: ProcessStepKind }): React.JSX.Element {
  if (kind === 'thinking') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.3 15.7v-1.2c-2.1-.9-3.4-2.8-3.4-5.1A6.1 6.1 0 0 1 10 3.3a6.1 6.1 0 0 1 6.1 6.1c0 2.3-1.3 4.2-3.4 5.1v1.2M7.1 18h5.8M10 3.3V1.8M3.6 4.3 2.5 3.2M16.4 4.3l1.1-1.1" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.45"/></svg>
  }
  if (kind === 'read') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4M7.5 10h5M7.5 13h5" fill="none" stroke="currentColor" strokeLinejoin="round" strokeLinecap="round" strokeWidth="1.4"/></svg>
  }
  if (kind === 'edit' || kind === 'write') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 14.8.7-3.2 7.9-7.9a1.5 1.5 0 0 1 2.1 0l1.6 1.6a1.5 1.5 0 0 1 0 2.1l-7.9 7.9-3.2.7zM11.7 4.6l3.7 3.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg>
  }
  if (kind === 'command') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="m5.5 8 2.2 2-2.2 2M9.7 12h4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg>
  }
  if (kind === 'search') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.6" cy="8.6" r="5.1" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="m12.4 12.4 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4"/></svg>
  }
  if (kind === 'browser') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M2.8 7h14.4M6 5.3h.1M8.3 5.3h.1" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4"/><path d="m8 10 2-1.2v4.4L8 12z" fill="currentColor"/></svg>
  }
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.7 3.2 6.8 5.5l-2.4.9v2.5l2.4.9.9 2.3h2.6l.9-2.3 2.4-.9V6.4l-2.4-.9-.9-2.3zM8.2 16.8h7.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.35"/></svg>
}

function stepDuration(step: ProcessTurnStep): string {
  const native = formatDuration(step.durationMs)
  if (native) return native
  const observed = formatDuration(step.startedAt !== undefined && step.completedAt !== undefined
    ? step.completedAt - step.startedAt
    : undefined)
  return observed && step.timingEstimated ? `~${observed}` : observed
}

/** todo 状态归一：Cursor 原生四态之外的任意字符串归入 cancelled（划线桶），
    同时避免未清洗的 status 直接拼进 className。 */
function todoTone(status: string): 'completed' | 'in_progress' | 'pending' | 'cancelled' {
  if (status === 'completed' || status === 'in_progress' || status === 'pending') return status
  return 'cancelled'
}

/** Cursor 原生三态指示器：完成=描边勾 / 进行=12px 实心圆反色旋转弧 / 其余=空心圆。 */
function TodoIndicator({ tone }: { tone: ReturnType<typeof todoTone> }): React.JSX.Element {
  return (
    <span className="todo-indicator" aria-hidden="true">
      {tone === 'completed' ? (
        <svg viewBox="0 0 14 14"><path d="m3.2 7.6 2.7 2.7 5-6.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : tone === 'in_progress' ? (
        <span className="todo-spinner">
          <svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeDasharray="21.7 29" /></svg>
        </span>
      ) : (
        <svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      )}
    </span>
  )
}

/**
 * 思考/过程消息正文（阶段 G）：直播卡（live）经共享播放器逐字追赶——稳定
 * step id 保留缓冲，新到即 done 的块同样播放；历史/封口卡直接完整显示。
 * 工具行不套播放器：按生命周期出现，不模拟逐字工具名。
 *
 * 播放模式在挂载时锁定：直播中挂载的正文在回合结束（live 翻 false）后继续把
 * 尾部匀速播完，而不是随 immediate 翻转瞬间跳全文；历史卡挂载即全文。
 */
function StreamingTextBody({
  step,
  live,
  className
}: {
  step: ProcessTurnStep
  live: boolean
  className?: string
}): React.JSX.Element | null {
  const immediate = useRef(!live)
  const visible = useStreamingText(
    { id: step.id, text: step.body ?? '', done: step.status !== 'running' },
    { immediate: immediate.current }
  )
  if (!step.body) return null
  return <MessageContent text={visible} className={className} />
}

function StepDetails({ step }: { step: ProcessTurnStep }): React.JSX.Element {
  const todos = step.todos ?? []
  const completedCount = todos.filter((todo) => todo.status === 'completed').length
  return (
    <div className="process-turn-step__details">
      {step.body ? <MessageContent text={step.body} className="process-turn-step__thinking" /> : null}
      {todos.length ? (
        <div className="todo-sheet">
          <div
            className="todo-progress"
            role="progressbar"
            aria-label={`任务清单进度 ${completedCount}/${todos.length}`}
            aria-valuenow={completedCount}
            aria-valuemin={0}
            aria-valuemax={todos.length}
          >
            <i style={{ width: `${Math.round((completedCount / todos.length) * 100)}%` }} />
          </div>
          <ul className="process-turn-step__todos">
            {todos.map((todo, index) => {
              const tone = todoTone(todo.status)
              return (
                <li key={`${step.id}:todo:${index}`} className={`is-${tone}`}>
                  <TodoIndicator tone={tone} />
                  <span className="todo-text">{todo.content}</span>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
      {step.details.map((detail, index) => (
        <dl key={`${step.id}:detail:${index}`}><dt>{detail.label}</dt><dd>{detail.kind === 'code' ? <pre>{detail.value}</pre> : <code>{detail.value}</code>}</dd></dl>
      ))}
    </div>
  )
}

export function ProcessTurnCard({
  id,
  blocks,
  startedAt,
  updatedAt,
  defaultOpen = true,
  compact = false,
  title = '过程记录',
  live = false,
  truncatedItemCount = 0
}: ProcessTurnCardProps): React.JSX.Element | null {
  const model = useMemo(() => buildProcessTurnView({ id, blocks, startedAt, updatedAt }), [id, blocks, startedAt, updatedAt])
  const [open, setOpen] = useState(defaultOpen)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const lastThinking = [...model.steps].reverse().find((step) => step.kind === 'thinking')
    return new Set(model.steps
      .filter((step) => step.id === lastThinking?.id)
      .map((step) => step.id))
  })
  /** 已自动展开过的最新步骤：内容继续增长时不与用户的手动收起对抗。 */
  const lastAutoExpanded = useRef<string | null>(null)
  useEffect(() => {
    if (!live) return
    // 直播时展开「最新可见的文本内容」：优先运行中的块；Cursor 常把生成中的
    // Thinking 标记为 done（RC-9），因此最新文本块即使 done 也展开——否则
    // 新内容折叠不可见，用户只能看到整段瞬现的最终结果。
    const last = model.steps.at(-1)
    const active = [...model.steps].reverse().find((step) => step.status === 'running')
      ?? (last && (last.kind === 'thinking' || last.kind === 'message') && last.body ? last : undefined)
    if (!active || lastAutoExpanded.current === active.id) return
    lastAutoExpanded.current = active.id
    setExpanded((current) => current.has(active.id) ? current : new Set([...current, active.id]))
  }, [live, model.steps])
  if (!model.steps.length) return null
  const statusText = model.status === 'running' ? '进行中' : model.status === 'failed' ? '有失败' : '已完成'
  const elapsed = formatDuration(model.elapsedMs)
  const summary = [
    `${model.steps.length} 步`,
    model.toolCount ? `${model.toolCount} 次工具` : '',
    statusText,
    elapsed ? model.timingEstimated ? `观测 ~${elapsed}` : `累计 ${elapsed}` : '',
    truncatedItemCount > 0 ? `另有 ${truncatedItemCount} 步已折叠` : ''
  ].filter(Boolean).join(' · ')

  const toggleAll = (): void => {
    setExpanded((current) => current.size === model.steps.length
      ? new Set()
      : new Set(model.steps.map((step) => step.id)))
  }

  if (compact) {
    return (
      <section className={`process-turn cursor-native-process ${live ? 'is-live' : ''} is-${model.status}`} aria-label={`${title}，${summary}`}>
        {live ? (
          <div className="cursor-native-process__live" role="status"><i />Cursor 实时过程</div>
        ) : null}
        <div className="cursor-native-process__flow">
          {truncatedItemCount > 0 ? (
            <div className="cursor-native-process__truncated" role="note">原生回合过长，较早的 {truncatedItemCount} 个步骤已折叠</div>
          ) : null}
          {model.steps.map((step) => {
            const stepOpen = expanded.has(step.id)
            const hasDetails = Boolean(step.details.length || step.todos?.length)
            const duration = stepDuration(step)
            if (step.kind === 'thinking') {
              return (
                <article key={step.id} className={`cursor-native-thought is-${step.status} ${stepOpen ? 'is-open' : ''}`}>
                  <button className="cursor-native-thought__head" onClick={() => setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(step.id)) next.delete(step.id)
                    else next.add(step.id)
                    return next
                  })} aria-expanded={stepOpen}>
                    <strong>Thought</strong>
                    {duration ? <time>for {duration}</time> : step.status === 'running' ? <span><i />thinking</span> : null}
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d={stepOpen ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg>
                  </button>
                  {stepOpen && step.body ? <StreamingTextBody step={step} live={live} className="cursor-native-thought__body" /> : null}
                </article>
              )
            }
            if (step.kind === 'message') {
              return step.body ? (
                <article key={step.id} className={`cursor-native-message is-${step.status}`}>
                  <StreamingTextBody step={step} live={live} />
                </article>
              ) : null
            }
            return (
              <article key={step.id} className={`cursor-native-tool is-${step.kind} is-${step.status} ${stepOpen ? 'is-open' : ''}`}>
                <button
                  className="cursor-native-tool__head"
                  disabled={!hasDetails}
                  onClick={() => setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(step.id)) next.delete(step.id)
                    else next.add(step.id)
                    return next
                  })}
                  aria-expanded={hasDetails ? stepOpen : undefined}
                >
                  <span className="cursor-native-tool__icon"><StepIcon kind={step.kind} /></span>
                  <strong>{step.action}</strong>
                  {step.target ? <code title={step.target}>{step.target}</code> : null}
                  <span className="cursor-native-tool__meta">
                    {duration ? <time>{duration}</time> : null}
                    <span className="cursor-native-tool__state">
                      {step.status === 'running' ? <><i />运行中</> : step.status === 'failed' ? '失败' : '完成'}
                    </span>
                    {hasDetails ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d={stepOpen ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg> : null}
                  </span>
                </button>
                {stepOpen && hasDetails ? <StepDetails step={step} /> : null}
              </article>
            )
          })}
        </div>
      </section>
    )
  }

  return (
    <section className={`process-turn ${compact ? 'is-compact' : ''} ${live ? 'is-live' : ''} is-${model.status}`} aria-label={`${title}，${summary}`}>
      <button className="process-turn__header" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="process-turn__state" aria-hidden="true">{model.status === 'done' ? '✓' : model.status === 'failed' ? '!' : <i />}</span>
        <strong>{title}</strong>
        {live ? <em className="process-turn__live-label"><i />实时</em> : null}
        <span>{summary}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d={open ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"/></svg>
      </button>
      {open ? (
        <div className="process-turn__content">
          {truncatedItemCount > 0 ? <p className="process-turn__truncated">较早的 {truncatedItemCount} 个原生步骤已折叠</p> : null}
          <button className="process-turn__expand-all" onClick={toggleAll}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 3 3 3-3M5 13l3-3 3 3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3"/></svg>
            {expanded.size === model.steps.length ? '收起全部' : '展开全部'}
          </button>
          <ol className="process-turn__steps">
            {model.steps.map((step) => {
              const stepOpen = expanded.has(step.id)
              const hasDetails = Boolean(step.body || step.details.length || step.todos?.length)
              return (
                <li key={step.id} className={`process-turn-step is-${step.kind} is-${step.status}`}>
                  <span className="process-turn-step__node"><StepIcon kind={step.kind} /></span>
                  <div className="process-turn-step__body">
                    <button
                      className="process-turn-step__head"
                      disabled={!hasDetails}
                      onClick={() => setExpanded((current) => {
                        const next = new Set(current)
                        if (next.has(step.id)) next.delete(step.id)
                        else next.add(step.id)
                        return next
                      })}
                      aria-expanded={hasDetails ? stepOpen : undefined}
                    >
                      <strong>{step.action}</strong>
                      {step.target ? <code title={step.target}>{step.target}</code> : null}
                      {stepDuration(step) ? <time>{stepDuration(step)}</time> : null}
                      <span className="process-turn-step__status">
                        {step.status === 'running' ? <><i />进行中</> : step.status === 'failed' ? '失败' : '完成'}
                      </span>
                      {hasDetails ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d={stepOpen ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg> : null}
                    </button>
                    {stepOpen && hasDetails ? <StepDetails step={step} /> : null}
                  </div>
                </li>
              )
            })}
          </ol>
          <button className="process-turn__collapse" onClick={() => setOpen(false)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/> </svg>
            收起
          </button>
        </div>
      ) : null}
    </section>
  )
}
