import { useState } from 'react'
import type { CursorAccountMetadata } from '../../../domain/cursor-account'
import type { AozaiCardStatus, AozaiProgressEvent } from '../../../domain/aozai-service'
import type { AccountAutomationRun, AccountAutomationSettings } from '../../../domain/account-automation'
import type { CursorUpdatePreferences } from '../../../domain/cursor-update'
import {
  ACCOUNT_AUTOMATION_DELAY_MAX_SEC,
  ACCOUNT_AUTOMATION_DELAY_MIN_SEC
} from '../../../domain/account-automation'

interface AozaiFeedback {
  ok: boolean
  message: string
}

export interface LobbyAccountTileProps {
  accounts: CursorAccountMetadata[]
  busy: boolean
  error: string
  onSave: (input: { label: string; token: string }) => Promise<void>
  onSelect: (accountId: string) => Promise<void>
  onRemove: (accountId: string) => Promise<void>
  onInject?: (accountId: string) => Promise<void>
  onImportFromLocal?: () => Promise<void>
  onImportFromBrowser?: () => Promise<void>
  aozaiStatus?: AozaiCardStatus
  aozaiBusy?: boolean
  aozaiError?: string
  aozaiProgress?: AozaiProgressEvent | null
  aozaiFeedback?: AozaiFeedback | null
  onSaveAozaiCard?: (cardCode: string) => Promise<void>
  onClearAozaiCard?: () => Promise<void>
  onRefreshAozaiBalance?: () => Promise<void>
  onProcessAozaiAccount?: (accountId: string) => Promise<void>
  automationSettings?: AccountAutomationSettings
  automationRun?: AccountAutomationRun
  cursorUpdatePreferences?: CursorUpdatePreferences
  cursorUpdateBusy?: boolean
  cursorUpdateError?: string
  onSetCursorAutoUpdateDisabled?: (disabled: boolean) => Promise<void>
  onSaveAutomationSettings?: (settings: AccountAutomationSettings) => void
  onCancelAutomation?: () => void
}

export function LobbyAccountTile({
  accounts,
  busy,
  error,
  onSave,
  onSelect,
  onRemove,
  onInject,
  onImportFromLocal,
  onImportFromBrowser,
  aozaiStatus,
  aozaiBusy = false,
  aozaiError,
  aozaiProgress,
  aozaiFeedback,
  onSaveAozaiCard,
  onClearAozaiCard,
  onRefreshAozaiBalance,
  onProcessAozaiAccount,
  automationSettings,
  automationRun,
  cursorUpdatePreferences,
  cursorUpdateBusy = false,
  cursorUpdateError,
  onSetCursorAutoUpdateDisabled,
  onSaveAutomationSettings,
  onCancelAutomation
}: LobbyAccountTileProps): React.JSX.Element {
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')
  const [cardCode, setCardCode] = useState('')
  const [confirmRemove, setConfirmRemove] = useState('')
  const [adding, setAdding] = useState(false)
  const activeAccount = accounts.find((account) => account.active)
  const aozaiEnabled = Boolean(onSaveAozaiCard)

  const submit = async (): Promise<void> => {
    try {
      await onSave({ label, token })
      setLabel('')
      setToken('')
      setAdding(false)
    } catch {
      // 错误由父级在卡片底部展示，避免回显凭据。
    }
  }
  const submitCard = async (): Promise<void> => {
    if (!onSaveAozaiCard) return
    try {
      await onSaveAozaiCard(cardCode)
      setCardCode('')
    } catch {
      // 错误由父级展示
    }
  }

  return (
    <section className="lobby-tile lobby-account" aria-label="Cursor 账号流程">
      <header className="lobby-tile__head lobby-account__head">
        <span>
          <strong>Cursor 账号管线</strong>
          <small>本地加密 · 会话处理 · Cursor 维护</small>
        </span>
        <em className="lobby-account__current">
          {activeAccount ? <>当前 <b>{activeAccount.label}</b></> : '未选择账号'}
          {accounts.length ? <i>{accounts.length}</i> : null}
        </em>
      </header>

      <div className="lobby-account__columns" aria-label="账号处理流水线">
        <section className="lobby-account__stage lobby-account__stock">
          <header><strong><em>01</em>账号库存</strong><span>{accounts.length ? '点选切换 · 逐账号处理与注入' : '还没有保存的 Cursor 账号'}</span></header>
          <div className="account-list lobby-account__list">
            {accounts.map((account) => (
              <article className={account.active ? 'is-active' : ''} key={account.id}>
                <button disabled={busy || account.active} onClick={() => void onSelect(account.id)}>
                  <i>{account.label.slice(0, 1).toUpperCase()}</i>
                  <span><strong>{account.label}</strong><small>{account.maskedToken}</small></span>
                  <em>{account.active ? '当前' : '选择'}</em>
                </button>
                <div className="lobby-account__row-actions">
                  {aozaiEnabled && aozaiStatus?.saved && onProcessAozaiAccount ? (
                    <button
                      className="account-process"
                      disabled={busy || aozaiBusy}
                      title="将此账号的 Session Token 提交奥仔自助服务处理（扣 1 次）"
                      onClick={() => void onProcessAozaiAccount(account.id)}
                    >
                      {aozaiBusy && aozaiProgress?.accountId === account.id ? '处理中…' : '处理'}
                    </button>
                  ) : null}
                  {onInject ? (
                    <button
                      className="account-process lobby-account__inject"
                      disabled={busy}
                      title="注入登录态到 Cursor（默认不重启；如需立即生效会再询问确认）"
                      onClick={() => void onInject(account.id)}
                    >注入</button>
                  ) : null}
                  <button className="account-remove" disabled={busy} onClick={() => {
                    if (confirmRemove !== account.id) { setConfirmRemove(account.id); return }
                    void onRemove(account.id).then(() => setConfirmRemove(''))
                  }}>{confirmRemove === account.id ? '确认' : '删除'}</button>
                </div>
              </article>
            ))}
            {!accounts.length ? <p>先从右侧获取一个账号。</p> : null}
          </div>
        </section>

        <section className="lobby-account__stage lobby-account__acquire">
          <header><strong><em>02</em>获取账号</strong><span>三种来源</span></header>
          <div className="lobby-account__quick">
            {onImportFromBrowser ? (
              <button disabled={busy} onClick={() => void onImportFromBrowser()}>
                {busy ? '导入中…' : '从浏览器导入 Token'}
              </button>
            ) : null}
            {onImportFromLocal ? (
              <button disabled={busy} onClick={() => void onImportFromLocal()}>
                {busy ? '获取中…' : '自动获取本机 Token'}
              </button>
            ) : null}
            <button className={adding ? 'is-active' : ''} onClick={() => setAdding((value) => !value)}>
              {adding ? '收起手动添加' : '手动粘贴 Token'}
            </button>
          </div>
          {!adding ? (
            <p className="lobby-account__note">Token 仅在本机加密保存，不会写入明文存储、日志或再次显示；浏览器导入读取本机已登录会话，全程离线。</p>
          ) : null}
          {adding ? (
            <div className="account-add-form lobby-account__form">
              <label><span>账号备注</span><input value={label} maxLength={80} placeholder="例如：工作账号 A" disabled={busy} onChange={(event) => setLabel(event.target.value)} /></label>
              <label><span>Cursor Auth Token</span><input type="password" value={token} maxLength={8192} autoComplete="off" spellCheck={false} placeholder="粘贴 Token" disabled={busy} onChange={(event) => setToken(event.target.value)} /></label>
              <small>明文不会写入 SQLite、日志或再次显示。</small>
              <button className="lobby-account__save" disabled={busy || !label.trim() || token.trim().length < 8} onClick={() => void submit()}>
                {busy ? '保存中…' : '保存账号'}
              </button>
            </div>
          ) : null}
        </section>

        <section className="lobby-account__stage lobby-account__ops">
          <header className="lobby-account__ops-head"><strong><em>03</em>处理与维护</strong><span>奥仔 · 自动化 · 本机</span></header>
          {aozaiEnabled ? (
            <div className="account-aozai lobby-account__aozai">
              <div className="account-aozai__head">
                <strong>奥仔自助服务</strong>
                <span>成功扣 1 次，失败自动退还</span>
              </div>
              {aozaiStatus?.saved ? (
                <div className="account-aozai__card">
                  <span className="account-aozai__code">{aozaiStatus.maskedCode}</span>
                  <span className="account-aozai__meta">
                    {aozaiStatus.type ?? '次卡'} · 剩余 {typeof aozaiStatus.remaining === 'number' ? `${aozaiStatus.remaining} 次` : '—'}
                  </span>
                  {onRefreshAozaiBalance ? (
                    <button disabled={aozaiBusy} onClick={() => void onRefreshAozaiBalance()}>刷新余额</button>
                  ) : null}
                  {onClearAozaiCard ? (
                    <button className="account-aozai__change" disabled={aozaiBusy} onClick={() => void onClearAozaiCard()}>更换卡密</button>
                  ) : null}
                </div>
              ) : (
                <div className="account-aozai__setup">
                  <input
                    value={cardCode}
                    maxLength={200}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="粘贴卡密"
                    disabled={aozaiBusy}
                    onChange={(event) => setCardCode(event.target.value)}
                  />
                  <button disabled={aozaiBusy || cardCode.trim().length < 6} onClick={() => void submitCard()}>
                    {aozaiBusy ? '验证中…' : '保存并验证'}
                  </button>
                </div>
              )}
              {aozaiStatus?.saved && automationSettings && onSaveAutomationSettings ? (
                <div className="account-automation">
                  <label className="account-automation__toggle">
                    <input
                      type="checkbox"
                      checked={automationSettings.enabled}
                      disabled={aozaiBusy || automationRun?.phase === 'countdown' || automationRun?.phase === 'processing' || automationRun?.phase === 'importing' || automationRun?.phase === 'deleting'}
                      onChange={(event) => onSaveAutomationSettings({ ...automationSettings, enabled: event.target.checked })}
                    />
                    <span>会话创建后自动处理账号</span>
                  </label>
                  {automationSettings.enabled ? (
                    <label className="account-automation__delay">
                      <span>延时</span>
                      <input
                        type="number"
                        min={ACCOUNT_AUTOMATION_DELAY_MIN_SEC}
                        max={ACCOUNT_AUTOMATION_DELAY_MAX_SEC}
                        step={0.5}
                        value={automationSettings.delaySec}
                        disabled={aozaiBusy}
                        onChange={(event) => {
                          const value = Number(event.target.value)
                          if (Number.isFinite(value)) onSaveAutomationSettings({ ...automationSettings, delaySec: value })
                        }}
                      />
                      <span>秒</span>
                    </label>
                  ) : null}
                  {automationRun && automationRun.phase !== 'idle' ? (
                    <p className={`account-automation__run is-${automationRun.phase}`}>
                      <span>{automationRun.message}</span>
                      {automationRun.phase === 'countdown' && onCancelAutomation ? (
                        <button onClick={onCancelAutomation}>取消</button>
                      ) : null}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {aozaiBusy && aozaiProgress ? (
                <p className="account-aozai__progress">{aozaiProgress.message}</p>
              ) : null}
              {!aozaiBusy && aozaiFeedback ? (
                <p className={aozaiFeedback.ok ? 'account-aozai__ok' : 'account-aozai__fail'}>{aozaiFeedback.message}</p>
              ) : null}
              {aozaiError ? <p className="account-aozai__fail">{aozaiError}</p> : null}
            </div>
          ) : null}
          {onSetCursorAutoUpdateDisabled && cursorUpdatePreferences ? (
            <div className="cursor-maintenance">
              <div className="cursor-maintenance__head">
                <strong>Cursor 本机维护</strong>
                <span title={cursorUpdatePreferences.settingsPath}>settings.json</span>
              </div>
              <label className="cursor-maintenance__toggle">
                <input
                  type="checkbox"
                  checked={cursorUpdatePreferences.autoUpdateDisabled}
                  disabled={cursorUpdateBusy}
                  onChange={(event) => void onSetCursorAutoUpdateDisabled(event.target.checked)}
                />
                <span>关闭 Cursor 自动更新</span>
                <em>{cursorUpdatePreferences.updateMode ?? '默认'}</em>
              </label>
              {cursorUpdateError ? <p className="cursor-maintenance__error">{cursorUpdateError}</p> : null}
            </div>
          ) : null}
        </section>
      </div>

      {error ? <p className="account-dialog-error lobby-account__error">{error}</p> : null}
    </section>
  )
}
