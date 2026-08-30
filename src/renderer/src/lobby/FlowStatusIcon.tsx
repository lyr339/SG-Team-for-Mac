export type FlowStatusVisualState =
  | 'done'
  | 'current'
  | 'running'
  | 'ready'
  | 'waiting'
  | 'todo'
  | 'failed'
  | 'cancelled'
  | 'off'

interface FlowStatusIconProps {
  state: FlowStatusVisualState
  index?: number
  className?: string
}

/** 流程状态的统一矢量节点：完成/执行/失败不再依赖 Unicode 字符。 */
export function FlowStatusIcon({ state, index, className = '' }: FlowStatusIconProps): React.JSX.Element {
  const terminalIcon = state === 'done' || state === 'failed' || state === 'cancelled'
  return (
    <span className={`flow-status-icon is-${state}${className ? ` ${className}` : ''}`} aria-hidden="true">
      {state === 'done' ? (
        <svg viewBox="0 0 20 20"><path d="m5.2 10.2 3.1 3.1 6.6-7" /></svg>
      ) : state === 'failed' ? (
        <svg viewBox="0 0 20 20"><path d="m6.2 6.2 7.6 7.6M13.8 6.2l-7.6 7.6" /></svg>
      ) : state === 'cancelled' ? (
        <svg viewBox="0 0 20 20"><path d="M5.5 10h9" /></svg>
      ) : state === 'running' || state === 'current' ? (
        <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.2" fill="currentColor" stroke="none" /><path d="M10 2.8a7.2 7.2 0 0 1 7.2 7.2" /></svg>
      ) : terminalIcon ? null : (
        <b>{index === undefined ? '·' : String(index).padStart(2, '0')}</b>
      )}
    </span>
  )
}
