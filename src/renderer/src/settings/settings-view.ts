import type { CursorAccountMetadata, CursorRuntimeAccountMatch } from '../../../domain/cursor-account'
import type { CursorMembershipStatus, CursorMembershipTier } from '../../../domain/cursor-membership'
import { cursorMembershipTierLabel } from '../../../domain/cursor-membership'
import type { AozaiCardStatus, AozaiProgressEvent } from '../../../domain/aozai-service'
import type {
  AccountAutomationPhase,
  AccountAutomationRun,
  AccountAutomationSettings
} from '../../../domain/account-automation'
import type { CursorUpdatePreferences } from '../../../domain/cursor-update'

/**
 * 设置页视图模型与纯函数。
 *
 * 本文件的函数与类型逐字迁移自原 lobby/LobbyAccountTile.tsx（账号管线页），
 * 逻辑零变更；测试从原断言直接平移。
 */

/** 档位段视觉模型：标签 + 按档位着色的类名。 */
export interface AccountStatusTierView {
  label: string
  className: string
}

/** 顶部登录状态模型；会员等级在当前账号卡片中独立呈现。 */
export interface AccountStatusLineView {
  tone: '' | 'is-warn' | 'is-off'
  text: string
  /** 鼠标悬停的完整说明（劈叉时含双账号明细）。 */
  detail?: string
}

/** 档位着色类：卡片内采用 Free 绿、Trial 琥珀、Pro 蓝、Pro+ 靛、Ultra 紫、Enterprise 橙。 */
function tierClassNameFor(tier: CursorMembershipTier | 'unknown'): string {
  switch (tier) {
    case 'free': return 'is-tier-free'
    case 'free_trial': return 'is-tier-trial'
    case 'pro': return 'is-tier-pro'
    case 'pro_plus': return 'is-tier-proplus'
    case 'ultra': return 'is-tier-ultra'
    case 'enterprise': return 'is-tier-enterprise'
    default: return 'is-tier-unknown'
  }
}

export function accountMembershipPlanFor(membership: CursorMembershipStatus | undefined): AccountStatusTierView | undefined {
  if (membership?.state !== 'ok' || !membership.profile) return undefined
  const { tier, raw } = membership.profile
  const label = tier === 'free_trial'
    ? 'Free Trial'
    : tier === 'unknown'
      ? cursorMembershipTierLabel(tier, raw)
      : `${cursorMembershipTierLabel(tier, raw)} Plan`
  return { label, className: tierClassNameFor(tier) }
}

/**
 * 顶部仅呈现登录一致性和异常：
 * - matched       → "email · 一致"
 * - mismatch      → "登录账号不一致"（红点，悬停见双账号）
 * - 会员正常等级移入当前账号卡片；401/抓取失败仍在顶部告警。
 */
export function accountStatusLineFor(
  runtimeMatch: CursorRuntimeAccountMatch | undefined,
  membership: CursorMembershipStatus | undefined
): AccountStatusLineView | undefined {
  const parts: string[] = []
  let tone: AccountStatusLineView['tone'] = ''
  let detail: string | undefined
  let hasSignal = false

  if (runtimeMatch?.status === 'matched') {
    hasSignal = true
    parts.push(runtimeMatch.activeLabel ?? runtimeMatch.cursorLabel ?? '')
    parts.push('一致')
  } else if (runtimeMatch?.status === 'mismatch') {
    hasSignal = true
    tone = 'is-off'
    parts.push('登录账号不一致')
    detail = `Cursor 当前登录 ${runtimeMatch.cursorLabel ?? '未知'}，活跃账号 ${runtimeMatch.activeLabel ?? '未知'}`
  }

  if (membership?.state === 'auth_expired') {
    hasSignal = true
    tone = 'is-off'
    parts.push('服务端会话已失效')
    detail = `${membership.detail ?? '服务端拒绝当前登录会话'}；“一致”只表示本地 JWT 账号标识相同`
  } else if (membership?.state === 'error') {
    hasSignal = true
    if (tone !== 'is-off') tone = 'is-warn'
    parts.push('档位获取失败')
  }

  if (!hasSignal) return undefined
  return {
    tone,
    text: parts.join(' · '),
    detail: detail ?? 'Cursor 运行登录态与活跃账号的比对（发起批量会话前会再校验）'
  }
}

interface AozaiFeedback {
  ok: boolean
  message: string
}

export interface SettingsPageProps {
  accounts: CursorAccountMetadata[]
  busy: boolean
  error: string
  onSave: (input: { label: string; token: string }) => Promise<void>
  onSelect: (accountId: string) => Promise<void>
  onRemove: (accountId: string) => Promise<void>
  onRestartWithAccount?: (accountId: string) => Promise<void>
  onImportFromLocal?: () => Promise<void>
  onImportFromBrowser?: () => Promise<void>
  /** 第一步「获取 Token」的指纹导入：读选中指纹 profile 登录态。 */
  onImportFromFingerprint?: () => Promise<void>
  /** 打开选定的指纹浏览器窗口并导航 cursor.com（用户提前登录入口；窗口不自动关）。 */
  onOpenFingerprintLogin?: () => Promise<void>
  onCleanupFingerprintEnvironment?: () => Promise<void>
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
  /** 指纹浏览器窗口列表（账号自动化链的浏览器宿主，用户按当次网络选择）。 */
  bitProfiles?: Array<{ id: string; name: string; seq?: number }>
  /** 窗口列表获取失败提示（客户端未运行等）。 */
  bitProfilesMessage?: string
  onRefreshBitProfiles?: () => void
  /** Roxy API Key 状态（指纹浏览器统一 Roxy，未保存 Key 时展示输入框）。 */
  roxyApiKeyStatus?: { saved: boolean; maskedKey?: string }
  onSaveRoxyApiKey?: (key: string) => Promise<void>
  /**
   * 当前运行平台（测试注入点）。缺省读 preload 注入的 documentElement.dataset.platform；
   * 决定是否显示「系统浏览器」宿主（Keychain + Apple Events 为 macOS 专属，Windows 隐藏）。
   * 指纹浏览器提供方与平台无关（恒 Roxy）。
   */
  platform?: NodeJS.Platform
  /** Cursor 运行态登录态与活跃账号的一致性核对（被动状态行；未拉取/无活跃账号时不渲染）。 */
  runtimeMatch?: CursorRuntimeAccountMatch
  /** 在线会员档位（被动状态行；未拉取/未登录时不渲染）。 */
  membership?: CursorMembershipStatus
  /** 每个已保存账号各自的在线会员档位，不依赖是否选为当前账号。 */
  accountMemberships?: Record<string, CursorMembershipStatus>
  /** 手动刷新指定账号档位。 */
  onRefreshMembership?: (accountId?: string) => void | Promise<void>
  cursorUpdatePreferences?: CursorUpdatePreferences
  cursorUpdateBusy?: boolean
  cursorUpdateError?: string
  onSetCursorAutoUpdateDisabled?: (disabled: boolean) => Promise<void>
  onSetModelDataPolicyAutoAcknowledge?: (enabled: boolean) => Promise<{ message: string }>
  onSaveAutomationSettings?: (settings: AccountAutomationSettings) => void
  onCancelAutomation?: () => void
}

export type AccountFlowStepKey = 'acquire' | 'countdown' | 'processing' | 'deleting' | 'finish'
export type AccountFlowState = 'waiting' | 'ready' | 'running' | 'done' | 'failed' | 'cancelled' | 'off'

const FLOW_STEP_ORDER: readonly AccountFlowStepKey[] = ['acquire', 'countdown', 'processing', 'deleting', 'finish']

export const FLOW_STEP_LABEL: Record<AccountFlowStepKey, string> = {
  acquire: '获取 Token',
  countdown: '倒计时',
  processing: '奥仔处理',
  // 步骤名界面用「账号加固」（删除官网账号的趣称）；协议语义保持原表述
  deleting: '账号加固',
  finish: '收尾'
}

const FLOW_STATE_LABEL: Record<AccountFlowState, string> = {
  waiting: '等待',
  ready: '就绪',
  running: '进行',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  off: '未开启'
}

export function accountFlowStateLabel(state: AccountFlowState): string {
  return FLOW_STATE_LABEL[state]
}

/** 活跃 phase 到流程步骤的映射；importing 属于删除链路的会话刷新子阶段。 */
export const ACTIVE_PHASE_STEP: Partial<Record<AccountAutomationPhase, AccountFlowStepKey>> = {
  countdown: 'countdown',
  processing: 'processing',
  'hardening-countdown': 'deleting',
  importing: 'deleting',
  deleting: 'deleting',
  cleaning: 'deleting'
}

export function isActiveAutomationPhase(phase: AccountAutomationPhase): boolean {
  return phase === 'countdown' || phase === 'processing' || phase === 'hardening-countdown'
    || phase === 'importing' || phase === 'deleting' || phase === 'cleaning'
}

/** 由运行相位推导五个流程步骤的状态，纯函数便于 SSR 测试。 */
export function accountFlowStatesFor(input: {
  phase: AccountAutomationPhase
  hasAccount: boolean
  automationEnabled: boolean
  aozaiReady: boolean
  lastActiveStep: AccountFlowStepKey
}): Record<AccountFlowStepKey, AccountFlowState> {
  const { phase, hasAccount, automationEnabled, aozaiReady, lastActiveStep } = input
  if (phase === 'idle') {
    return {
      acquire: hasAccount ? 'done' : 'waiting',
      countdown: automationEnabled ? 'ready' : 'off',
      processing: aozaiReady ? 'ready' : 'waiting',
      deleting: 'waiting',
      finish: 'waiting'
    }
  }
  if (phase === 'done') {
    return { acquire: 'done', countdown: 'done', processing: 'done', deleting: 'done', finish: 'done' }
  }
  if (phase === 'cancelled') {
    // 加固前倒计时取消：奥仔已完成（处理/倒计时均 done），仅删除步被取消。
    if (lastActiveStep === 'deleting') {
      return {
        acquire: 'done',
        countdown: 'done',
        processing: 'done',
        deleting: 'cancelled',
        finish: 'cancelled'
      }
    }
    return {
      acquire: hasAccount ? 'done' : 'waiting',
      countdown: 'cancelled',
      processing: 'waiting',
      deleting: 'waiting',
      finish: 'cancelled'
    }
  }
  if (phase === 'failed') {
    const at = FLOW_STEP_ORDER.indexOf(lastActiveStep)
    const states = {} as Record<AccountFlowStepKey, AccountFlowState>
    FLOW_STEP_ORDER.forEach((key, index) => {
      states[key] = index < at ? 'done' : index === at ? 'failed' : 'waiting'
    })
    states.acquire = hasAccount ? states.acquire : 'waiting'
    states.finish = 'failed'
    return states
  }
  const at = FLOW_STEP_ORDER.indexOf(ACTIVE_PHASE_STEP[phase] ?? 'countdown')
  const states = {} as Record<AccountFlowStepKey, AccountFlowState>
  FLOW_STEP_ORDER.forEach((key, index) => {
    states[key] = index < at ? 'done' : index === at ? 'running' : 'waiting'
  })
  return states
}

/** 运行耗时摘要：仅在有始有终时给出。 */
export function automationDurationText(run: AccountAutomationRun): string {
  if (!run.startedAt || !run.finishedAt || run.finishedAt < run.startedAt) return ''
  const sec = (run.finishedAt - run.startedAt) / 1000
  if (sec >= 60) return `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`
  return `${Math.round(sec * 10) / 10} 秒`
}

/** 持久化/直出的失败运行没有活跃步骤轨迹时，按服务消息文案推断失败归属（仅影响展示，完整错误始终展示）。 */
export function automationFailedStepHint(message: string): AccountFlowStepKey {
  if (/取消后续账号加固|加固前/.test(message)) return 'deleting'
  if (/奥仔处理失败/.test(message)) return 'processing'
  // 删除链路的失败必含新凭据或删除语义；裸「会话」会误吞 preflight 失败（如浏览器会话读取失败），不用。
  if (/新 Token|删除|官网|入库/.test(message)) return 'deleting'
  return 'countdown'
}
