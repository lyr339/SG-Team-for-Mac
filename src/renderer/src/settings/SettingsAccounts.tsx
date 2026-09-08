import { useEffect, useState } from 'react'
import { RefreshIcon } from '../UiIcons'
import type { SettingsPageProps } from './settings-view'
import { accountMembershipPlanFor, accountStatusLineFor } from './settings-view'
import { SettingsSection } from './SettingsSection'

type AccountsProps = Pick<SettingsPageProps,
  | 'accounts' | 'busy' | 'onSave' | 'onSelect' | 'onRemove' | 'onRestartWithAccount'
  | 'runtimeMatch' | 'membership' | 'accountMemberships' | 'onRefreshMembership'
  | 'aozaiStatus' | 'aozaiBusy' | 'aozaiProgress' | 'aozaiError' | 'aozaiFeedback' | 'onProcessAozaiAccount'
>

interface SettingsAccountsProps extends AccountsProps {
  active?: boolean
  /** 空列表时「前往导入来源」的跨组导航（由 SettingsPage 注入）。 */
  onNavigateToImport?: () => void
}

/**
 * 账号分组：登录一致性状态行 + 已保存账号列表。
 * 全部处理器、禁用条件、二次确认语义与文案逐字继承自原 LobbyAccountTile 步骤一。
 */
export function SettingsAccounts({
  active = true,
  accounts,
  busy,
  onSelect,
  onRemove,
  onRestartWithAccount,
  runtimeMatch,
  membership,
  accountMemberships,
  onRefreshMembership,
  aozaiStatus,
  aozaiBusy = false,
  aozaiProgress,
  aozaiError,
  aozaiFeedback,
  onProcessAozaiAccount,
  onNavigateToImport
}: SettingsAccountsProps): React.JSX.Element {
  const [confirmRemove, setConfirmRemove] = useState('')
  const [confirmRestart, setConfirmRestart] = useState('')
  useEffect(() => { if (!active) { setConfirmRemove(''); setConfirmRestart('') } }, [active])
  const [refreshingMembershipAccountId, setRefreshingMembershipAccountId] = useState('')
  const activeAccount = accounts.find((account) => account.active)
  const aozaiEnabled = Boolean(onProcessAozaiAccount)
  // 合并状态行上移卡片头：替换「当前 xxx」（email 重复），无信号时回退原文案
  const statusLine = accountStatusLineFor(runtimeMatch, membership)

  return (
    <>
      {statusLine || activeAccount ? (
        <div className="settings-status-strip">
          <em className="lobby-account__current">
            {statusLine ? (
              <span
                className={`account-status-line${statusLine.tone ? ` ${statusLine.tone}` : ''}`}
                title={statusLine.detail}
              >
                <i aria-hidden="true" />
                <span className="account-status-line__text">{statusLine.text}</span>
              </span>
            ) : activeAccount ? <>当前 <b>{activeAccount.label}</b></> : '未选择账号'}
          </em>
        </div>
      ) : null}

      <SettingsSection
        title="已保存账号"
        description="Token 仅在本机加密保存，不会写入明文存储、日志或再次显示。"
        aside={accounts.length ? <i className="settings-count">{accounts.length}</i> : undefined}
      >
        <div className="account-list settings-account-list">
          {accounts.map((account) => (
            <article className={account.active ? 'is-active' : ''} key={account.id}>
              <button disabled={busy || account.active} onClick={() => void onSelect(account.id)}>
                <i>{account.label.slice(0, 1).toUpperCase()}</i>
                <span><strong>{account.label}</strong><small>{account.maskedToken}</small></span>
                <em>{account.active ? '当前' : '选择'}</em>
              </button>
              <div className="lobby-account__row-actions">
                {(() => {
                  const accountMembership = accountMemberships?.[account.id]
                    ?? (account.active ? membership : undefined)
                  const membershipPlan = accountMembershipPlanFor(accountMembership)
                  return membershipPlan ? (
                  <span className="account-membership-inline">
                    <span className={`account-membership-plan ${membershipPlan.className}`}>
                      账号类型：<b>{membershipPlan.label}</b>
                    </span>
                    {onRefreshMembership ? (
                      <button
                        className={`account-membership-refresh ${membershipPlan.className}${refreshingMembershipAccountId === account.id ? ' is-refreshing' : ''}`}
                        type="button"
                        disabled={refreshingMembershipAccountId === account.id}
                        title="刷新此账号会员等级"
                        aria-label={`刷新 ${account.label} 的会员等级`}
                        onClick={() => {
                          if (refreshingMembershipAccountId) return
                          setRefreshingMembershipAccountId(account.id)
                          void Promise.resolve()
                            .then(() => onRefreshMembership(account.id))
                            .catch(() => undefined)
                            .finally(() => setRefreshingMembershipAccountId(''))
                        }}
                      ><RefreshIcon /></button>
                    ) : null}
                  </span>
                  ) : null
                })()}
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
                {onRestartWithAccount ? (
                  <button
                    className={`account-process lobby-account__inject ${confirmRestart === account.id ? 'is-confirming' : ''}`}
                    disabled={busy || aozaiBusy}
                    title={confirmRestart === account.id
                      ? '再次点击确认：关闭全部 Cursor 窗口（若有未保存内容请先保存，超过 10 秒未退出将强制关闭），写入登录态与机器码后带调试端口重启'
                      : '切换账号将关闭并重启 Cursor（未保存内容可能丢失）；首次点击仅进入确认状态'}
                    onClick={() => {
                      if (confirmRestart !== account.id) {
                        setConfirmRestart(account.id)
                        return
                      }
                      setConfirmRestart('')
                      void onRestartWithAccount(account.id)
                    }}
                  >{busy ? '切换中…' : confirmRestart === account.id ? '确认重启' : '切换并重启'}</button>
                ) : null}
                <button className="account-remove" disabled={busy} onClick={() => {
                  if (confirmRemove !== account.id) { setConfirmRemove(account.id); return }
                  void onRemove(account.id).then(() => setConfirmRemove(''))
                }}>{confirmRemove === account.id ? '确认' : '删除'}</button>
              </div>
            </article>
          ))}
          {!accounts.length ? (
            <p className="settings-empty">
              还没有账号。
              {onNavigateToImport ? (
                <button type="button" onClick={onNavigateToImport}>前往「导入来源」获取</button>
              ) : null}
            </p>
          ) : null}
        </div>
        {aozaiError ? <p className="account-aozai__fail" role="alert">{aozaiError}</p> : null}
        {!aozaiBusy && aozaiFeedback ? <p className={aozaiFeedback.ok ? 'account-aozai__ok' : 'account-aozai__fail'} role="status">{aozaiFeedback.message}</p> : null}
      </SettingsSection>
    </>
  )
}
