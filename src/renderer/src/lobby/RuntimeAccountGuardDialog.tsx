import type { CursorRuntimeAccountMatch } from '../../../domain/cursor-account'

export interface RuntimeAccountGuardDialogProps {
  verify: CursorRuntimeAccountMatch
  /** 是否提供「仍要发起」次按钮（无删号风险的状态才给逃生门）。 */
  allowProceed: boolean
  /** 是否可执行「切换并重启」修复（vault 有活跃账号时）。 */
  canSwitch: boolean
  busy: boolean
  error: string
  onClose: () => void
  onProceed: () => void
  /** 切换到活跃账号并重启 Cursor；成功后调用方自动续跑发起。 */
  onSwitchAndRestart: () => void
}

/**
 * 发起会话前的运行态账号闸门弹窗：Cursor 登录态与活跃账号劈叉/未登录时拦截。
 * mismatch（自动化开启）不给「仍要发起」——继续就是删错官网账号，这里不该有逃生门。
 */
export function RuntimeAccountGuardDialog({
  verify,
  allowProceed,
  canSwitch,
  busy,
  error,
  onClose,
  onProceed,
  onSwitchAndRestart
}: RuntimeAccountGuardDialogProps): React.JSX.Element {
  const isMismatch = verify.status === 'mismatch'
  return (
    <div className="handoff-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy && allowProceed) onClose()
    }}>
      <section className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="runtime-guard-title">
        <header>
          <div>
            <strong id="runtime-guard-title">{isMismatch ? 'Cursor 登录账号不一致' : 'Cursor 未登录'}</strong>
            <span>发起会话前需要处理</span>
          </div>
          <button disabled={busy} aria-label="关闭确认窗口" onClick={onClose}>×</button>
        </header>
        <div className="runtime-guard-body">
          {isMismatch ? (
            <dl className="runtime-guard-accounts">
              <div><dt>Cursor 当前登录</dt><dd>{verify.cursorLabel ?? '未知'}</dd></div>
              <div><dt>拾光活跃账号</dt><dd>{verify.activeLabel ?? '未知'}</dd></div>
            </dl>
          ) : (
            <p className="runtime-guard-accounts">{verify.detail ?? '未读取到 Cursor 登录态'}</p>
          )}
          <p className="runtime-guard-hint">{isMismatch
            ? '会话创建消耗 Cursor 登录账号的额度，账号自动化删除的是拾光活跃账号——两者不一致时继续，会话能跑但删错官网账号。切换并重启后自动继续发起。'
            : '会话创建依赖 Cursor 登录态，未登录时会话将无法工作。'}</p>
          {error ? <p className="handoff-dialog-error">{error}</p> : null}
        </div>
        <footer>
          <button disabled={busy} onClick={onClose}>取消</button>
          {allowProceed ? <button className="runtime-guard-secondary" disabled={busy} onClick={onProceed}>仍要发起</button> : null}
          <button
            disabled={busy || !canSwitch}
            onClick={onSwitchAndRestart}
          >{busy ? '切换中…' : '切换并重启，继续发起'}</button>
        </footer>
      </section>
    </div>
  )
}
