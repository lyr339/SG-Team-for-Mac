import { useState } from 'react'
import type { SettingsPageProps } from './settings-view'
import { SettingsSection } from './SettingsSection'

type AozaiProps = Pick<SettingsPageProps,
  | 'aozaiStatus' | 'aozaiBusy' | 'aozaiError' | 'aozaiProgress' | 'aozaiFeedback'
  | 'onSaveAozaiCard' | 'onClearAozaiCard' | 'onRefreshAozaiBalance'
>

/**
 * 奥仔服务分组：卡密保存/更换、余额刷新、处理进度与反馈。
 * 全部结构与文案逐字继承自原 LobbyAccountTile 步骤三。
 */
export function SettingsAozai({
  aozaiStatus,
  aozaiBusy = false,
  aozaiError,
  aozaiProgress,
  aozaiFeedback,
  onSaveAozaiCard,
  onClearAozaiCard,
  onRefreshAozaiBalance
}: AozaiProps): React.JSX.Element {
  const [cardCode, setCardCode] = useState('')
  const aozaiEnabled = Boolean(onSaveAozaiCard)

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
    <SettingsSection
      title="奥仔自助服务"
      description="提交奥仔自助服务处理，成功扣 1 次，失败自动退还。"
      aside={aozaiStatus?.saved ? (
        <span className="settings-section__meta">
          {aozaiStatus.type ?? '次卡'} · 剩余 {typeof aozaiStatus.remaining === 'number' ? `${aozaiStatus.remaining} 次` : '—'}
        </span>
      ) : undefined}
    >
      {aozaiEnabled ? (
        <div className="account-aozai settings-aozai">
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
                aria-label="奥仔卡密"
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
          {aozaiBusy && aozaiProgress ? (
            <p className="account-aozai__progress">{aozaiProgress.message}</p>
          ) : null}
          {!aozaiBusy && aozaiFeedback ? (
            <p className={aozaiFeedback.ok ? 'account-aozai__ok' : 'account-aozai__fail'}>{aozaiFeedback.message}</p>
          ) : null}
          {aozaiError ? <p className="account-aozai__fail">{aozaiError}</p> : null}
        </div>
      ) : (
        <p className="flow-step__hint">当前环境未接入奥仔自助服务。</p>
      )}
    </SettingsSection>
  )
}
