import { useState } from 'react'
import type { AccountAutomationPhase } from '../../../domain/account-automation'
import { AccountBrowserPanel } from '../lobby/AccountBrowserPanel'
import type { SettingsPageProps } from './settings-view'
import { isActiveAutomationPhase } from './settings-view'
import { SettingsSection } from './SettingsSection'

type ImportSourceProps = Pick<SettingsPageProps,
  | 'accounts' | 'busy' | 'onSave'
  | 'onImportFromLocal' | 'onImportFromBrowser' | 'onImportFromFingerprint'
  | 'onOpenFingerprintLogin' | 'onCleanupFingerprintEnvironment'
  | 'automationSettings' | 'onSaveAutomationSettings'
  | 'bitProfiles' | 'bitProfilesMessage' | 'onRefreshBitProfiles'
  | 'roxyApiKeyStatus' | 'onSaveRoxyApiKey' | 'platform' | 'aozaiBusy'
>

interface SettingsImportSourceProps extends ImportSourceProps {
  /** 自动化相位（导入按钮在自动化活跃期禁用，与原步骤一同一判定源）。 */
  phase: AccountAutomationPhase
}

/**
 * 导入来源分组：会话浏览器宿主（贯穿整条管线）+ 获取 Token 的入口。
 * 按钮的展示条件、禁用条件、title 文案逐字继承自原 LobbyAccountTile 步骤一。
 */
export function SettingsImportSource({
  busy,
  onSave,
  onImportFromLocal,
  onImportFromBrowser,
  onImportFromFingerprint,
  onOpenFingerprintLogin,
  onCleanupFingerprintEnvironment,
  automationSettings,
  onSaveAutomationSettings,
  bitProfiles,
  bitProfilesMessage,
  onRefreshBitProfiles,
  roxyApiKeyStatus,
  onSaveRoxyApiKey,
  platform,
  aozaiBusy = false,
  phase
}: SettingsImportSourceProps): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  // 平台仅决定「系统浏览器」宿主是否展示（Keychain/Apple Events 是 macOS 专属）；
  // 指纹浏览器提供方与平台无关，恒 Roxy（比特已全面退役）。
  const resolvedPlatform = platform
    ?? (typeof document !== 'undefined' ? document.documentElement.dataset.platform : undefined)
  const isWindows = resolvedPlatform === 'win32'
  const fingerprintProviderLabel = 'Roxy'

  return (
    <>
      {/* 导入来源：选定后贯穿整条管线（获取 Token → 奥仔后换发 → 删除官网账号同一宿主） */}
      {automationSettings && onSaveAutomationSettings ? (
        <SettingsSection
          title="会话浏览器"
          description="Token 获取、刷新与账号处理沿用同一来源。"
          aside={<span className="settings-section__meta">贯穿全流程</span>}
        >
          <AccountBrowserPanel
            settings={automationSettings}
            disabled={busy || aozaiBusy || isActiveAutomationPhase(phase)}
            isWindows={isWindows}
            providerLabel={fingerprintProviderLabel}
            profiles={bitProfiles}
            profilesMessage={bitProfilesMessage}
            apiKeyStatus={roxyApiKeyStatus}
            onSettingsChange={onSaveAutomationSettings}
            onRefreshProfiles={onRefreshBitProfiles}
            onSaveApiKey={onSaveRoxyApiKey}
            onCleanupEnvironment={onCleanupFingerprintEnvironment}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="获取 Token"
        description="读取所选浏览器的登录会话；浏览器刷新需要联网。"
      >
        <div className="lobby-account__quick settings-import-actions" aria-label="获取账号来源">
          {onImportFromFingerprint && (automationSettings?.browserHost ?? 'fingerprint') === 'fingerprint' ? (
            <button className="lobby-account__quick-primary" disabled={busy || !automationSettings?.bitProfileId}
              title={automationSettings?.bitProfileId
                ? '打开选定的指纹浏览器窗口读取登录态 Token（窗口生命周期沿用现有导入流程）'
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
          <p className="lobby-account__note">Token 仅在本机加密保存，不会写入明文存储、日志或再次显示；读取所选浏览器的登录会话；浏览器刷新需要联网。</p>
        ) : null}
        {adding ? <SettingsManualAddForm busy={busy} onSave={onSave} /> : null}
      </SettingsSection>
    </>
  )
}

/** 手动粘贴表单（原步骤一的折叠表单，结构与校验逐字保留）。 */
function SettingsManualAddForm({
  busy,
  onSave
}: Pick<SettingsPageProps, 'busy' | 'onSave'>): React.JSX.Element {
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')

  const submit = async (): Promise<void> => {
    try {
      await onSave({ label, token })
      setLabel('')
      setToken('')
    } catch {
      // 错误由父级在卡片底部展示，避免回显凭据。
    }
  }

  return (
    <div className="account-add-form settings-add-form">
      <label><span>账号备注</span><input value={label} maxLength={80} placeholder="例如：工作账号 A" disabled={busy} onChange={(event) => setLabel(event.target.value)} /></label>
      <label><span>Cursor Auth Token</span><input type="password" value={token} maxLength={8192} autoComplete="off" spellCheck={false} placeholder="粘贴 Token" disabled={busy} onChange={(event) => setToken(event.target.value)} /></label>
      <small>明文不会写入 SQLite、日志或再次显示。</small>
      <button className="lobby-account__save" disabled={busy || !label.trim() || token.trim().length < 8} onClick={() => void submit()}>
        {busy ? '保存中…' : '保存账号'}
      </button>
    </div>
  )
}
