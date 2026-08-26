/** 会话创建后的账号自动化（玩法开关 + 延时）。 */

export interface AccountAutomationSettings {
  /** 总开关：一键创建会话全部提交成功后，是否自动执行账号自动化链。默认关。 */
  enabled: boolean
  /** 触发后倒计时秒数（支持 0.5 步进），倒计时内可取消。 */
  delaySec: number
}

export const ACCOUNT_AUTOMATION_DELAY_MIN_SEC = 0.5
export const ACCOUNT_AUTOMATION_DELAY_MAX_SEC = 60

export const DEFAULT_ACCOUNT_AUTOMATION_SETTINGS: AccountAutomationSettings = {
  enabled: false,
  delaySec: 10
}

export function normalizeAccountAutomationSettings(value: unknown): AccountAutomationSettings {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const delay = typeof raw.delaySec === 'number' && Number.isFinite(raw.delaySec)
    ? Math.round(raw.delaySec * 2) / 2
    : DEFAULT_ACCOUNT_AUTOMATION_SETTINGS.delaySec
  return {
    enabled: raw.enabled === true,
    delaySec: Math.min(ACCOUNT_AUTOMATION_DELAY_MAX_SEC, Math.max(ACCOUNT_AUTOMATION_DELAY_MIN_SEC, delay))
  }
}

export type AccountAutomationPhase =
  | 'idle'
  | 'countdown'
  | 'processing'
  | 'importing'
  | 'deleting'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface AccountAutomationRun {
  phase: AccountAutomationPhase
  message: string
  planId?: string
  /** countdown 阶段剩余秒数。 */
  remainingSec?: number
  startedAt: number
  finishedAt?: number
}

export const IDLE_ACCOUNT_AUTOMATION_RUN: AccountAutomationRun = {
  phase: 'idle',
  message: '',
  startedAt: 0
}
