import { useState } from 'react'
import {
  ACCOUNT_AUTOMATION_DELAY_MAX_SEC,
  ACCOUNT_AUTOMATION_DELAY_MIN_SEC,
  type AccountAutomationPhase
} from '../../../domain/account-automation'
import { ToggleSwitch } from '../lobby/ToggleSwitch'
import { RangeField } from '../lobby/RangeField'
import { FlowStatusIcon } from '../lobby/FlowStatusIcon'
import type { SettingsPageProps } from './settings-view'
import {
  ACTIVE_PHASE_STEP,
  accountFlowStateLabel,
  accountFlowStatesFor,
  automationDurationText,
  automationFailedStepHint,
  isActiveAutomationPhase,
  FLOW_STEP_LABEL,
  type AccountFlowStepKey
} from './settings-view'
import { SettingsSection } from './SettingsSection'

type AutomationProps = Pick<SettingsPageProps,
  | 'accounts' | 'automationSettings' | 'automationRun' | 'aozaiStatus'
  | 'aozaiBusy' | 'onSaveAutomationSettings' | 'onCancelAutomation'
>

const TRACKER_STEPS: readonly AccountFlowStepKey[] = ['acquire', 'countdown', 'processing', 'deleting', 'finish']

/**
 * 自动化分组：设置项（开关 + 双倒计时滑杆）+ 运行状态横幅。
 * 横幅是非空闲相位时的签名元素：横向五步追踪器 + 倒计时/实时消息/取消；
 * 空闲相位下横幅完全不渲染，设置项位置恒定。
 * 全部状态推导、消息与禁用条件逐字继承自原 LobbyAccountTile 步骤二至五。
 */
export function SettingsAutomation({
  accounts,
  automationSettings,
  automationRun,
  aozaiStatus,
  aozaiBusy = false,
  onSaveAutomationSettings,
  onCancelAutomation
}: AutomationProps): React.JSX.Element {
  const aozaiReady = Boolean(aozaiStatus?.saved)
  const automationEnabled = Boolean(automationSettings?.enabled)
  const phase = automationRun?.phase ?? 'idle'
  // 失败归属：跟踪本次运行最后活跃的步骤（render 期派生状态，React 官方模式）；
  // 组件挂载后直接就是失败态（如持久化恢复）时退化为按消息文案推断。
  const [lastActiveStep, setLastActiveStep] = useState<AccountFlowStepKey | null>(null)
  const activeStep = ACTIVE_PHASE_STEP[phase]
  if (activeStep && activeStep !== lastActiveStep) setLastActiveStep(activeStep)

  const runMessage = automationRun?.message ?? ''
  const states = accountFlowStatesFor({
    phase,
    hasAccount: accounts.length > 0,
    automationEnabled,
    aozaiReady,
    lastActiveStep: lastActiveStep ?? automationFailedStepHint(runMessage)
  })
  const durationText = automationRun ? automationDurationText(automationRun) : ''
  const automationControlsReady = aozaiReady && Boolean(automationSettings) && Boolean(onSaveAutomationSettings)
  const active = isActiveAutomationPhase(phase)

  return (
    <>
      {phase !== 'idle' ? (
        <div className={`settings-flow-banner is-${phase === 'done' ? 'done' : phase === 'failed' ? 'failed' : phase === 'cancelled' ? 'cancelled' : 'active'}`}>
          <ol className="settings-flow-track" aria-label="账号自动化流程">
            {TRACKER_STEPS.map((key, index) => {
              const state = states[key]
              return (
                <li
                  key={key}
                  className={`settings-flow-track__step is-${state}`}
                  aria-label={`步骤 ${index + 1}：${FLOW_STEP_LABEL[key]}，${accountFlowStateLabel(state)}`}
                >
                  <FlowStatusIcon state={state} index={index + 1} />
                  <span>{FLOW_STEP_LABEL[key]}</span>
                </li>
              )
            })}
          </ol>

          <div className="settings-flow-banner__live">
            {phase === 'countdown' && automationRun ? (
              <div className="flow-step__countdown" aria-live="polite" aria-label="自动化倒计时">
                <b>{typeof automationRun.remainingSec === 'number' ? automationRun.remainingSec : '—'}</b>
                <span>秒后自动处理当前账号</span>
                {onCancelAutomation ? (
                  <button className="flow-step__cancel" onClick={onCancelAutomation}>取消</button>
                ) : null}
              </div>
            ) : null}
            {phase === 'hardening-countdown' && automationRun ? (
              <div className="flow-step__countdown" aria-live="polite" aria-label="账号加固倒计时">
                <b>{typeof automationRun.remainingSec === 'number' ? automationRun.remainingSec : '—'}</b>
                <span>秒后加固当前账号</span>
                {onCancelAutomation ? (
                  <button className="flow-step__cancel" onClick={onCancelAutomation}>取消</button>
                ) : null}
              </div>
            ) : null}

            {phase === 'countdown' && runMessage ? (
              <p className="flow-step__live" aria-live="polite">{runMessage}</p>
            ) : null}
            {states.countdown === 'failed' && runMessage ? (
              <p className="flow-step__live is-failed" role="alert">{runMessage}</p>
            ) : null}
            {states.countdown === 'cancelled' && runMessage ? (
              <p className="flow-step__live is-cancelled">{runMessage}</p>
            ) : null}

            {phase === 'processing' && runMessage ? (
              <p className="flow-step__live" aria-live="polite">{runMessage}</p>
            ) : null}
            {states.processing === 'failed' && runMessage ? (
              <p className="flow-step__live is-failed" role="alert">{runMessage}</p>
            ) : null}

            {phase === 'hardening-countdown' || phase === 'deleting' || phase === 'importing' || phase === 'cleaning' ? (
              <p className="flow-step__live" aria-live="polite">{runMessage}</p>
            ) : null}
            {states.deleting === 'failed' && runMessage ? (
              <p className="flow-step__live is-failed" role="alert">{runMessage}</p>
            ) : null}

            {phase === 'done' && runMessage ? (
              <p className="flow-step__live is-done" aria-live="polite">{runMessage}</p>
            ) : null}
            {phase === 'cancelled' && runMessage ? (
              <p className="flow-step__live is-cancelled">{runMessage}</p>
            ) : null}
            {phase === 'failed' ? (
              <p className="flow-step__live is-failed" role="alert">流程未完成：{runMessage}</p>
            ) : null}
            {durationText ? (
              <p className="settings-flow-banner__duration">耗时 {durationText}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <SettingsSection
        title="自动化"
        description="会话创建全部提交成功后自动处理当前账号；处理完成后秒级完成账号加固（不可撤销），必要时自动刷新会话获取新 Token。"
        aside={automationEnabled && automationSettings ? (
          <span className="settings-section__meta">处理前 {automationSettings.delaySec} 秒 · 加固前 {automationSettings.postProcessDelaySec} 秒</span>
        ) : undefined}
      >
        {automationControlsReady && automationSettings && onSaveAutomationSettings ? (
          <div className="account-automation settings-automation">
            <div className="account-automation__row">
              <ToggleSwitch
                checked={automationSettings.enabled}
                disabled={aozaiBusy || active}
                onChange={(enabled) => onSaveAutomationSettings({ ...automationSettings, enabled })}
              >
                会话创建后自动处理账号
              </ToggleSwitch>
              {automationSettings.enabled ? (
                <div className="account-automation__delays">
                  <div className="account-automation__delay">
                    <span>处理前</span>
                    <RangeField
                      value={automationSettings.delaySec}
                      min={ACCOUNT_AUTOMATION_DELAY_MIN_SEC}
                      max={ACCOUNT_AUTOMATION_DELAY_MAX_SEC}
                      step={0.5}
                      unit="秒"
                      disabled={aozaiBusy}
                      label="奥仔处理前倒计时秒数"
                      onChange={(delaySec) => onSaveAutomationSettings({ ...automationSettings, delaySec })}
                    />
                  </div>
                  <div className="account-automation__delay">
                    <span>加固前</span>
                    <RangeField
                      value={automationSettings.postProcessDelaySec}
                      min={ACCOUNT_AUTOMATION_DELAY_MIN_SEC}
                      max={ACCOUNT_AUTOMATION_DELAY_MAX_SEC}
                      step={0.5}
                      unit="秒"
                      disabled={aozaiBusy}
                      label="奥仔完成后账号加固前倒计时秒数"
                      onChange={(postProcessDelaySec) => onSaveAutomationSettings({ ...automationSettings, postProcessDelaySec })}
                    />
                  </div>
                </div>
              ) : null}
            </div>
            {automationSettings.enabled ? (
              <p className="account-automation__follow">
                执行浏览器跟随「获取 Token」的来源：
                {(automationSettings.browserHost ?? 'fingerprint') === 'fingerprint'
                  ? `指纹浏览器（Roxy${automationSettings.bitProfileId ? '' : ' · 未选窗口'}）`
                  : '系统浏览器（Edge/Chrome）'}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="flow-step__hint">保存奥仔卡密后开启自动化。</p>
        )}
      </SettingsSection>
    </>
  )
}
