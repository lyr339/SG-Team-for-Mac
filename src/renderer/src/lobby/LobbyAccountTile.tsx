import { useState } from 'react'
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
import {
  ACCOUNT_AUTOMATION_DELAY_MAX_SEC,
  ACCOUNT_AUTOMATION_DELAY_MIN_SEC
} from '../../../domain/account-automation'
import { ToggleSwitch } from './ToggleSwitch'
import { MenuSelect } from './MenuSelect'
import { RangeField } from './RangeField'

/** 档位段视觉模型：标签 + 按档位着色的类名。 */
export interface AccountStatusTierView {
  label: string
  className: string
}

/** 合并状态行的视觉模型：单点色取最严重信号，档位段按档位着色。 */
export interface AccountStatusLineView {
  tone: '' | 'is-warn' | 'is-off'
  /** 前缀文案（如 "a@x.com · 一致"）；仅档位有信号时为空。 */
  text: string
  /** 档位段（拼在前缀之后，Free/Pro/Pro+/Ultra/… 各自着色）。 */
  tier?: AccountStatusTierView
  /** 鼠标悬停的完整说明（劈叉时含双账号明细）。 */
  detail?: string
  free: boolean
}

/** 档位着色：Free 红（阻断）/ 试用琥珀 / Pro 绿 / Pro+ 蓝 / Ultra 紫 / Enterprise 品牌橙。 */
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

/**
 * 登录态一致性 + 会员档位合并为一行状态条（替代原两行）：
 * - matched + ok  → "email · 一致 · Pro"（绿点；档位段按档位着色）
 * - mismatch      → "登录账号不一致"（红点，悬停见双账号）
 * - 未登录        → 不渲染（与无账号/未拉取同语义，避免空行）
 * 严重度：不一致 > 未登录/获取失败 > 正常；Free 档位整体点色转红。
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

  let tier: AccountStatusTierView | undefined
  if (membership?.state === 'ok' && membership.profile) {
    hasSignal = true
    tier = {
      label: cursorMembershipTierLabel(membership.profile.tier, membership.profile.raw),
      className: tierClassNameFor(membership.profile.tier)
    }
  } else if (membership?.state === 'auth_expired') {
    hasSignal = true
    if (tone !== 'is-off') tone = 'is-warn'
    parts.push('档位获取失败（登录过期）')
  } else if (membership?.state === 'error') {
    hasSignal = true
    if (tone !== 'is-off') tone = 'is-warn'
    parts.push('档位获取失败')
  }

  if (!hasSignal) return undefined
  const free = membership?.state === 'ok' && membership.profile?.tier === 'free'
  return {
    tone: free ? 'is-off' : tone,
    text: parts.join(' · '),
    tier,
    detail: detail ?? 'Cursor 运行登录态与活跃账号的比对 + 在线会员档位（发起批量会话前会再校验）',
    free
  }
}

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
  onRestartWithAccount?: (accountId: string) => Promise<void>
  onImportFromLocal?: () => Promise<void>
  onImportFromBrowser?: () => Promise<void>
  /** 第一步「获取 Token」的指纹导入：读选中指纹 profile 登录态。 */
  onImportFromFingerprint?: () => Promise<void>
  /** 打开选定的指纹浏览器窗口并导航 cursor.com（用户提前登录入口；窗口不自动关）。 */
  onOpenFingerprintLogin?: () => Promise<void>
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
  /** 手动刷新档位（状态行小按钮）。 */
  onRefreshMembership?: () => void
  cursorUpdatePreferences?: CursorUpdatePreferences
  cursorUpdateBusy?: boolean
  cursorUpdateError?: string
  onSetCursorAutoUpdateDisabled?: (disabled: boolean) => Promise<void>
  onSaveAutomationSettings?: (settings: AccountAutomationSettings) => void
  onCancelAutomation?: () => void
}

export type AccountFlowStepKey = 'acquire' | 'countdown' | 'processing' | 'deleting' | 'finish'
export type AccountFlowState = 'waiting' | 'ready' | 'running' | 'done' | 'failed' | 'cancelled' | 'off'

const FLOW_STEP_ORDER: readonly AccountFlowStepKey[] = ['acquire', 'countdown', 'processing', 'deleting', 'finish']

const FLOW_STATE_LABEL: Record<AccountFlowState, string> = {
  waiting: '等待',
  ready: '就绪',
  running: '进行',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  off: '未开启'
}

/** 活跃 phase 到流程步骤的映射；importing 属于删除链路的会话刷新子阶段。 */
const ACTIVE_PHASE_STEP: Partial<Record<AccountAutomationPhase, AccountFlowStepKey>> = {
  countdown: 'countdown',
  processing: 'processing',
  importing: 'deleting',
  deleting: 'deleting'
}

export function isActiveAutomationPhase(phase: AccountAutomationPhase): boolean {
  return phase === 'countdown' || phase === 'processing' || phase === 'importing' || phase === 'deleting'
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
  if (/奥仔处理失败/.test(message)) return 'processing'
  // 删除链路的失败必含新凭据或删除语义；裸「会话」会误吞 preflight 失败（如浏览器会话读取失败），不用。
  if (/新 Token|删除|官网|入库/.test(message)) return 'deleting'
  return 'countdown'
}

export function LobbyAccountTile({
  accounts,
  busy,
  error,
  onSave,
  onSelect,
  onRemove,
  onRestartWithAccount,
  onImportFromLocal,
  onImportFromBrowser,
  onOpenFingerprintLogin,
  onImportFromFingerprint,
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
  bitProfiles,
  bitProfilesMessage,
  onRefreshBitProfiles,
  roxyApiKeyStatus,
  onSaveRoxyApiKey,
  platform,
  runtimeMatch,
  membership,
  onRefreshMembership,
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
  const [confirmRestart, setConfirmRestart] = useState('')
  const [adding, setAdding] = useState(false)
  const [roxyKeyInput, setRoxyKeyInput] = useState('')
  const [roxyKeySaving, setRoxyKeySaving] = useState(false)
  const activeAccount = accounts.find((account) => account.active)
  // 平台仅决定「系统浏览器」宿主是否展示（Keychain/Apple Events 是 macOS 专属）；
  // 指纹浏览器提供方与平台无关，恒 Roxy（比特已全面退役）。
  const resolvedPlatform = platform
    ?? (typeof document !== 'undefined' ? document.documentElement.dataset.platform : undefined)
  const isWindows = resolvedPlatform === 'win32'
  const fingerprintProviderLabel = 'Roxy'
  const aozaiEnabled = Boolean(onSaveAozaiCard)
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
  // 合并状态行上移卡片头：替换「当前 xxx」（email 重复），无信号时回退原文案
  const statusLine = accountStatusLineFor(runtimeMatch, membership)

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

  const stepShell = (
    key: AccountFlowStepKey,
    index: number,
    title: string,
    meta: string,
    children: React.ReactNode
  ): React.JSX.Element => {
    const state = states[key]
    return (
      <li className={`flow-step is-${state}`} aria-label={`步骤 ${index + 1}：${title}，${FLOW_STATE_LABEL[state]}`}>
        <div className="flow-step__rail" aria-hidden="true"><i>{state === 'done' ? '✓' : `0${index + 1}`}</i></div>
        <div className="flow-step__body">
          <header className="flow-step__head">
            <strong>{title}</strong>
            {meta ? <span className="flow-step__meta">{meta}</span> : null}
            <em className={`flow-step__state is-${state}`}>{FLOW_STATE_LABEL[state]}</em>
          </header>
          {children}
        </div>
      </li>
    )
  }

  return (
    <section className="lobby-tile lobby-account" aria-label="Cursor 账号流程">
      <header className="lobby-tile__head lobby-account__head">
        <span>
          <strong>Cursor 账号管线</strong>
          <small>本地加密 · 会话处理 · Cursor 维护</small>
        </span>
        <em className="lobby-account__current">
          {statusLine ? (
            <span
              className={`account-status-line${statusLine.tone ? ` ${statusLine.tone}` : ''}`}
              title={statusLine.detail}
            >
              <i aria-hidden="true" />
              <span className="account-status-line__text">
                {statusLine.text}
                {statusLine.tier ? (
                  <>
                    {statusLine.text ? ' · ' : null}
                    <span className={statusLine.tier.className}>{statusLine.tier.label}</span>
                  </>
                ) : null}
              </span>
              {onRefreshMembership ? (
                <button type="button" onClick={onRefreshMembership}>刷新</button>
              ) : null}
            </span>
          ) : activeAccount ? <>当前 <b>{activeAccount.label}</b></> : '未选择账号'}
          {accounts.length ? <i>{accounts.length}</i> : null}
        </em>
      </header>

      <ol className="lobby-account__flow" aria-label="账号自动化流程">
        {stepShell('acquire', 0, '获取 Token', accounts.length ? `${accounts.length} 个账号` : '还没有账号', (
          <>
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
              {!accounts.length ? <p>先从下方获取一个账号。</p> : null}
            </div>
            {/* 导入来源：选定后贯穿整条管线（获取 Token → 奥仔后换发 → 删除官网账号同一宿主） */}
            {automationSettings && onSaveAutomationSettings ? (
              <div className="account-source lobby-account__source" aria-label="浏览器导入来源">
                <div className="account-source__seg" role="tablist" aria-label="浏览器来源切换">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={(automationSettings.browserHost ?? 'fingerprint') === 'fingerprint'}
                    className={(automationSettings.browserHost ?? 'fingerprint') === 'fingerprint' ? 'is-active' : ''}
                    disabled={busy || aozaiBusy || isActiveAutomationPhase(phase)}
                    title={`从指纹浏览器（${fingerprintProviderLabel}）的指定窗口导入 Token；后续自动化链也在同一窗口执行`}
                    onClick={() => onSaveAutomationSettings({ ...automationSettings, browserHost: 'fingerprint' })}
                  >指纹浏览器</button>
                  {/* 系统浏览器宿主（Keychain + Apple Events）是 macOS 专属机制，Windows 版不提供 */}
                  {!isWindows ? (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={automationSettings.browserHost === 'external'}
                      className={automationSettings.browserHost === 'external' ? 'is-active' : ''}
                      disabled={busy || aozaiBusy || isActiveAutomationPhase(phase)}
                      title="从本机 Edge/Chrome 已登录会话导入 Token；后续自动化链走系统浏览器（较慢，需 Apple Events 权限）"
                      onClick={() => onSaveAutomationSettings({ ...automationSettings, browserHost: 'external' })}
                    >系统浏览器</button>
                  ) : null}
                </div>
                {(automationSettings.browserHost ?? 'fingerprint') === 'fingerprint' ? (
                  <div className="account-source__config">
                    {/* 指纹浏览器统一 Roxy（比特已退役，与平台无关）：已存 Key 显示掩码，未存显示输入框 */}
                    {roxyApiKeyStatus?.saved && roxyApiKeyStatus.maskedKey ? (
                      <span className="account-source__key" title="Roxy API Key 已保存在本机（可在下方重新粘贴覆盖）">
                        {roxyApiKeyStatus.maskedKey}
                      </span>
                    ) : (
                      <span className="account-source__key is-missing" title="Roxy 客户端「API → API 配置」复制 Key 粘贴到此处">
                        <input
                          type="password"
                          value={roxyKeyInput}
                          maxLength={128}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="Roxy API Key"
                          disabled={roxyKeySaving || busy || aozaiBusy || isActiveAutomationPhase(phase)}
                          onChange={(event) => setRoxyKeyInput(event.target.value)}
                        />
                        {onSaveRoxyApiKey ? (
                          <button
                            type="button"
                            disabled={roxyKeySaving || busy || aozaiBusy || isActiveAutomationPhase(phase) || roxyKeyInput.trim().length < 8}
                            onClick={() => {
                              setRoxyKeySaving(true)
                              void onSaveRoxyApiKey(roxyKeyInput.trim())
                                .then(() => setRoxyKeyInput(''))
                                .finally(() => setRoxyKeySaving(false))
                            }}
                          >{roxyKeySaving ? '保存中…' : '保存'}</button>
                        ) : null}
                      </span>
                    )}
                    <label className="account-source__field account-source__field--grow" title="Token 导入与自动化执行的窗口——按当前网络（Clash 开/关）选择挂代理或直连，两个窗口都需预先登录 cursor.com">
                      <MenuSelect
                        value={automationSettings.bitProfileId ?? ''}
                        placeholder="选择窗口…"
                        disabled={busy || aozaiBusy || isActiveAutomationPhase(phase)}
                        options={(bitProfiles ?? []).map((profile) => ({
                          value: profile.id,
                          label: `${profile.seq !== undefined ? `#${profile.seq} ` : ''}${profile.name}`
                        }))}
                        onChange={(value) => onSaveAutomationSettings({ ...automationSettings, bitProfileId: value || undefined })}
                      />
                    </label>
                    {onRefreshBitProfiles ? (
                      <button
                        type="button"
                        className="account-source__refresh"
                        disabled={busy || aozaiBusy || isActiveAutomationPhase(phase)}
                        title="重新获取窗口列表"
                        onClick={onRefreshBitProfiles}
                      >⟳</button>
                    ) : null}
                  </div>
                ) : (
                  <p className="account-source__hint">
                    需在 Edge / Chrome 登录 cursor.com；秒级删除还需在 Edge 勾选「视图 → Developer → Allow JavaScript from Apple Events」。
                  </p>
                )}
                {bitProfilesMessage && (automationSettings.browserHost ?? 'fingerprint') === 'fingerprint' ? (
                  <p className="account-source__error" role="alert">{bitProfilesMessage}</p>
                ) : null}
              </div>
            ) : null}
            <div className="lobby-account__quick" aria-label="获取账号来源">
              {onImportFromFingerprint && (automationSettings?.browserHost ?? 'fingerprint') === 'fingerprint' ? (
                <button className="lobby-account__quick-primary" disabled={busy || !automationSettings?.bitProfileId}
                  title={automationSettings?.bitProfileId
                    ? '打开选定的指纹浏览器窗口读取登录态 Token（内存级，导入后自动关窗）'
                    : '请先在上方选择指纹浏览器窗口'}
                  onClick={() => void onImportFromFingerprint()}>
                  {busy ? '导入中…' : '从指纹浏览器导入（推荐）'}
                </button>
              ) : null}
              {/* 提前登录入口：开窗导航 cursor.com，用户登录后 cookie 落 profile；窗口不自动关。
                  自动化活跃阶段必须禁用——此时导航的正是自动化链在用的 tab，
                  会破坏就绪探测与 token 轮换基准（与窗口选择器同一禁用条件）。 */}
              {onOpenFingerprintLogin && (automationSettings?.browserHost ?? 'fingerprint') === 'fingerprint' ? (
                <button disabled={busy || aozaiBusy || isActiveAutomationPhase(phase) || !automationSettings?.bitProfileId}
                  title={automationSettings?.bitProfileId
                    ? '打开选定的指纹浏览器窗口并进入 cursor.com——未登录可先登录（登录态保存到该窗口，之后导入直接读取）'
                    : '请先在上方选择指纹浏览器窗口'}
                  onClick={() => void onOpenFingerprintLogin()}>
                  {busy ? '打开中…' : '打开网页登录'}
                </button>
              ) : null}
              {/* 系统浏览器导入依赖 Keychain（macOS 专属）；Windows 上即使旧设置残留 external 也不展示 */}
              {onImportFromBrowser && !isWindows && (automationSettings?.browserHost ?? 'fingerprint') === 'external' ? (
                <button disabled={busy} onClick={() => void onImportFromBrowser()}
                  title="读取本机外部浏览器已登录的 cursor.com 会话">
                  {busy ? '导入中…' : '从浏览器导入 Token'}
                </button>
              ) : null}
              {onImportFromLocal ? (
                <button disabled={busy} onClick={() => void onImportFromLocal()}
                  title="读取本机 Cursor 客户端当前登录的会话">
                  {busy ? '获取中…' : '自动获取本机 Token'}
                </button>
              ) : null}
              <button className={adding ? 'is-active' : ''} onClick={() => setAdding((value) => !value)}
                title="粘贴从 cursor.com 控制台手动获取的 Session Token">
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
          </>
        ))}

        {stepShell('countdown', 1, '倒计时', automationEnabled && automationSettings ? `延时 ${automationSettings.delaySec} 秒` : '', (
          <>
            {automationControlsReady && automationSettings && onSaveAutomationSettings ? (
              <div className="account-automation lobby-account__automation">
                <div className="account-automation__row">
                  <ToggleSwitch
                    checked={automationSettings.enabled}
                    disabled={aozaiBusy || isActiveAutomationPhase(phase)}
                    onChange={(enabled) => onSaveAutomationSettings({ ...automationSettings, enabled })}
                  >
                    会话创建后自动处理账号
                  </ToggleSwitch>
                  {automationSettings.enabled ? (
                    <div className="account-automation__delay">
                      <span>延时</span>
                      <RangeField
                        value={automationSettings.delaySec}
                        min={ACCOUNT_AUTOMATION_DELAY_MIN_SEC}
                        max={ACCOUNT_AUTOMATION_DELAY_MAX_SEC}
                        step={0.5}
                        unit="秒"
                        disabled={aozaiBusy}
                        label="自动处理延时秒数"
                        onChange={(delaySec) => onSaveAutomationSettings({ ...automationSettings, delaySec })}
                      />
                    </div>
                  ) : null}
                </div>
                {automationSettings.enabled ? (
                  <p className="account-automation__follow">
                    执行浏览器跟随「获取 Token」的来源：
                    {(automationSettings.browserHost ?? 'fingerprint') === 'fingerprint'
                      ? `指纹浏览器（${fingerprintProviderLabel}${automationSettings.bitProfileId ? '' : ' · 未选窗口'}）`
                      : '系统浏览器（Edge/Chrome）'}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="flow-step__hint">保存奥仔卡密后开启自动化。</p>
            )}
            {phase === 'countdown' && automationRun ? (
              <div className="flow-step__countdown" aria-live="polite" aria-label="自动化倒计时">
                <b>{typeof automationRun.remainingSec === 'number' ? automationRun.remainingSec : '—'}</b>
                <span>秒后自动处理当前账号</span>
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
          </>
        ))}

        {stepShell('processing', 2, '奥仔处理', aozaiReady && aozaiStatus
          ? `${aozaiStatus.type ?? '次卡'} · 剩余 ${typeof aozaiStatus.remaining === 'number' ? `${aozaiStatus.remaining} 次` : '—'}`
          : '', (
          <>
            <p className="flow-step__hint">提交奥仔自助服务处理，成功扣 1 次，失败自动退还。</p>
            {aozaiEnabled ? (
              <div className="account-aozai lobby-account__aozai">
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
            {phase === 'processing' && runMessage ? (
              <p className="flow-step__live" aria-live="polite">{runMessage}</p>
            ) : null}
            {states.processing === 'failed' && runMessage ? (
              <p className="flow-step__live is-failed" role="alert">{runMessage}</p>
            ) : null}
          </>
        ))}

        {/* 步骤名界面用「账号加固」（删除官网账号的趣称）；注释与协议语义保持原表述 */}
        {stepShell('deleting', 3, '账号加固', '', (
          <>
            <p className="flow-step__desc">处理完成后秒级完成账号加固（不可撤销），必要时自动刷新会话获取新 Token。</p>
            {phase === 'deleting' || phase === 'importing' ? (
              <p className="flow-step__live" aria-live="polite">{runMessage}</p>
            ) : null}
            {states.deleting === 'failed' && runMessage ? (
              <p className="flow-step__live is-failed" role="alert">{runMessage}</p>
            ) : null}
          </>
        ))}

        {stepShell('finish', 4, '收尾', durationText ? `耗时 ${durationText}` : '', (
          <>
            {phase === 'done' && runMessage ? (
              <p className="flow-step__live is-done" aria-live="polite">{runMessage}</p>
            ) : null}
            {phase === 'cancelled' && runMessage ? (
              <p className="flow-step__live is-cancelled">{runMessage}</p>
            ) : null}
            {phase === 'failed' ? (
              <p className="flow-step__live is-failed" role="alert">流程未完成：{runMessage}</p>
            ) : null}
          </>
        ))}
      </ol>

      {onSetCursorAutoUpdateDisabled && cursorUpdatePreferences ? (
        <div className="cursor-maintenance lobby-account__maintenance">
          <div className="cursor-maintenance__head">
            <strong>Cursor 本机维护</strong>
            <span title={cursorUpdatePreferences.settingsPath}>settings.json</span>
          </div>
          <div className="cursor-maintenance__toggle">
            <ToggleSwitch
              checked={cursorUpdatePreferences.autoUpdateDisabled}
              disabled={cursorUpdateBusy}
              onChange={(checked) => void onSetCursorAutoUpdateDisabled(checked)}
            >
              关闭 Cursor 自动更新
            </ToggleSwitch>
            <em>{cursorUpdatePreferences.updateMode ?? '默认'}</em>
          </div>
          {cursorUpdateError ? <p className="cursor-maintenance__error">{cursorUpdateError}</p> : null}
        </div>
      ) : null}

      {error ? <p className="account-dialog-error lobby-account__error">{error}</p> : null}
    </section>
  )
}
