import { useState } from 'react'
import { ToggleSwitch } from '../lobby/ToggleSwitch'
import type { SettingsPageProps } from './settings-view'
import { isActiveAutomationPhase } from './settings-view'
import { SettingsSection } from './SettingsSection'

type MaintenanceProps = Pick<SettingsPageProps,
  | 'cursorUpdatePreferences' | 'cursorUpdateBusy' | 'cursorUpdateError'
  | 'onSetCursorAutoUpdateDisabled' | 'onSetModelDataPolicyAutoAcknowledge'
  | 'automationSettings' | 'automationRun'
>

/**
 * Cursor 本机维护分组：自动更新开关 + 受限模型数据政策自动确认。
 * 全部结构与文案逐字继承自原 LobbyAccountTile 底部维护块。
 */
export function SettingsMaintenance({
  cursorUpdatePreferences,
  cursorUpdateBusy = false,
  cursorUpdateError,
  onSetCursorAutoUpdateDisabled,
  onSetModelDataPolicyAutoAcknowledge,
  automationSettings,
  automationRun
}: MaintenanceProps): React.JSX.Element | null {
  const [policyBusy, setPolicyBusy] = useState(false)
  const [policyFeedback, setPolicyFeedback] = useState<{ ok: boolean; message: string }>()
  const phase = automationRun?.phase ?? 'idle'

  if (!(onSetCursorAutoUpdateDisabled && cursorUpdatePreferences) && !onSetModelDataPolicyAutoAcknowledge) {
    return null
  }

  return (
    <SettingsSection
      title="Cursor 本机维护"
      description={cursorUpdatePreferences ? 'settings.json' : 'Roxy profile'}
      descriptionTitle={cursorUpdatePreferences?.settingsPath}
    >
      <div className="cursor-maintenance settings-maintenance">
        {onSetCursorAutoUpdateDisabled && cursorUpdatePreferences ? (
          <div className="cursor-maintenance__action">
            <ToggleSwitch
              checked={cursorUpdatePreferences.autoUpdateDisabled}
              disabled={cursorUpdateBusy}
              onChange={(checked) => void onSetCursorAutoUpdateDisabled(checked)}
            >
              关闭 Cursor 自动更新
            </ToggleSwitch>
            <em>{cursorUpdatePreferences.updateMode ?? '默认'}</em>
          </div>
        ) : null}
        {onSetModelDataPolicyAutoAcknowledge && automationSettings ? (
          <div className="cursor-maintenance__action cursor-maintenance__policy">
            <ToggleSwitch
              checked={automationSettings.autoAcknowledgeModelDataPolicies !== false}
              disabled={policyBusy || isActiveAutomationPhase(phase)}
              title={!automationSettings.bitProfileId ? '关闭可直接生效；重新开启前请先选择 Roxy 窗口' : '新账号导入与自动化预检时查询官网状态，缺失才确认'}
              onChange={(enabled) => {
                setPolicyBusy(true)
                setPolicyFeedback(undefined)
                void onSetModelDataPolicyAutoAcknowledge(enabled)
                  .then((result) => setPolicyFeedback({ ok: true, message: result.message }))
                  .catch((reason: unknown) => setPolicyFeedback({
                    ok: false,
                    message: reason instanceof Error ? reason.message : String(reason)
                  }))
                  .finally(() => setPolicyBusy(false))
              }}
            >
              {policyBusy ? '正在更新受限模型政策' : '自动确认受限模型数据政策'}
            </ToggleSwitch>
            <em>{automationSettings.autoAcknowledgeModelDataPolicies !== false ? '自动' : '关闭'}</em>
          </div>
        ) : null}
        {policyFeedback ? (
          <p className={policyFeedback.ok ? 'cursor-maintenance__ok' : 'cursor-maintenance__error'} role={policyFeedback.ok ? 'status' : 'alert'}>
            {policyFeedback.message}
          </p>
        ) : null}
        {cursorUpdateError ? <p className="cursor-maintenance__error">{cursorUpdateError}</p> : null}
      </div>
    </SettingsSection>
  )
}
