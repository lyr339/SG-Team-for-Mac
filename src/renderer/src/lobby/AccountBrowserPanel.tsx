import { useEffect, useRef, useState } from 'react'
import type { AccountAutomationSettings } from '../../../domain/account-automation'
import { MenuSelect } from './MenuSelect'

interface AccountBrowserPanelProps {
  settings: AccountAutomationSettings
  disabled: boolean
  isWindows: boolean
  providerLabel: string
  profiles?: Array<{ id: string; name: string; seq?: number }>
  profilesMessage?: string
  apiKeyStatus?: { saved: boolean; maskedKey?: string }
  onSettingsChange: (settings: AccountAutomationSettings) => void
  onRefreshProfiles?: () => void
  onSaveApiKey?: (key: string) => Promise<void>
  /** 一键清理：选定 profile 的 Cursor 站点数据 + Roxy 本地/云端缓存 + 指纹轮换。 */
  onCleanupEnvironment?: () => Promise<void>
}

function BrowserGlyph({ kind }: { kind: 'fingerprint' | 'system' }): React.JSX.Element {
  return kind === 'fingerprint' ? (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a7.5 7.5 0 0 0-7.5 7.5M12 6.5A4.5 4.5 0 0 0 7.5 11M12 9.5A1.5 1.5 0 0 0 10.5 11c0 4.3-1.4 6.7-3.2 8.2M13.5 11c0 4.9-1.1 7.7-2.5 9.5M16.5 11c0 4.7-.7 7.2-1.7 9M19.5 11A7.5 7.5 0 0 0 12 3.5" /></svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.2" /><path d="M3.8 9h16.4M7 7h.1M10 7h.1" /></svg>
  )
}

function CleanupGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.8 3.2 16.8 7.2M4.5 15.5l-1 1a1.4 1.4 0 0 0 2 2l1-1M11 5 15 9l-7.6 7.6a2.4 2.4 0 0 1-3.4-3.4ZM13.2 2.8l4 4" /></svg>
  )
}

export function AccountBrowserPanel({
  settings,
  disabled,
  isWindows,
  providerLabel,
  profiles,
  profilesMessage,
  apiKeyStatus,
  onSettingsChange,
  onRefreshProfiles,
  onSaveApiKey,
  onCleanupEnvironment
}: AccountBrowserPanelProps): React.JSX.Element {
  const [keyInput, setKeyInput] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  const [cleanupArmed, setCleanupArmed] = useState(false)
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [cleanupNote, setCleanupNote] = useState('')
  const cleanupArmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(cleanupArmTimer.current), [])
  // 环境或选择变化即解除确认态（避免切窗口后误触旧确认）。
  useEffect(() => { setCleanupArmed(false); setCleanupNote('') }, [settings.bitProfileId, settings.browserHost])
  const host = settings.browserHost ?? 'fingerprint'
  const selectedProfile = profiles?.find((profile) => profile.id === settings.bitProfileId)

  const runCleanup = (): void => {
    if (!onCleanupEnvironment || cleanupBusy) return
    if (!cleanupArmed) {
      setCleanupArmed(true)
      setCleanupNote('')
      clearTimeout(cleanupArmTimer.current)
      cleanupArmTimer.current = setTimeout(() => setCleanupArmed(false), 10_000)
      return
    }
    clearTimeout(cleanupArmTimer.current)
    setCleanupArmed(false)
    setCleanupBusy(true)
    setCleanupNote('')
    void onCleanupEnvironment()
      .then(() => setCleanupNote(`「${selectedProfile?.name ?? '选定窗口'}」已清理并轮换指纹；下次使用需重新登录 cursor.com`))
      .catch((reason) => setCleanupNote(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setCleanupBusy(false))
  }

  return (
    <section className="account-browser" aria-label="浏览器导入来源">
      <header className="account-browser__head">
        <span className="account-browser__head-icon"><BrowserGlyph kind={host === 'fingerprint' ? 'fingerprint' : 'system'} /></span>
        <span><strong>会话浏览器</strong><small>Token 获取、刷新与账号处理沿用同一来源</small></span>
        <em>贯穿全流程</em>
      </header>

      <div className="account-browser__modes" role="tablist" aria-label="浏览器来源切换">
        <button
          type="button"
          role="tab"
          aria-selected={host === 'fingerprint'}
          className={host === 'fingerprint' ? 'is-active' : ''}
          disabled={disabled}
          title={`从指纹浏览器（${providerLabel}）的指定窗口导入 Token；后续自动化链也在同一窗口执行`}
          onClick={() => onSettingsChange({ ...settings, browserHost: 'fingerprint' })}
        >
          <BrowserGlyph kind="fingerprint" />
          <span><strong>指纹浏览器</strong><small>隔离环境 · 推荐</small></span>
          <i />
        </button>
        {!isWindows ? (
          <button
            type="button"
            role="tab"
            aria-selected={host === 'external'}
            className={host === 'external' ? 'is-active' : ''}
            disabled={disabled}
            title="从本机 Edge/Chrome 已登录会话导入 Token；后续自动化链走系统浏览器（较慢，需 Apple Events 权限）"
            onClick={() => onSettingsChange({ ...settings, browserHost: 'external' })}
          >
            <BrowserGlyph kind="system" />
            <span><strong>系统浏览器</strong><small>Edge / Chrome</small></span>
            <i />
          </button>
        ) : null}
      </div>

      {host === 'fingerprint' ? (
        <div className="account-browser__config">
          <div className="account-browser__connection-row">
            <div className="account-browser__key-cell">
              <span><b>Roxy 连接</b><small>{apiKeyStatus?.saved ? 'API Key 已保存在本机' : '先连接本机 Roxy 客户端'}</small></span>
            {apiKeyStatus?.saved && apiKeyStatus.maskedKey ? (
              <code title="Roxy API Key 已保存在本机（重新粘贴可覆盖）">{apiKeyStatus.maskedKey}</code>
            ) : (
              <span className="account-browser__key-input">
                <input
                  type="password"
                  value={keyInput}
                  maxLength={128}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Roxy API Key"
                  disabled={keySaving || disabled}
                  onChange={(event) => setKeyInput(event.target.value)}
                />
                {onSaveApiKey ? (
                  <button
                    type="button"
                    disabled={keySaving || disabled || keyInput.trim().length < 8}
                    onClick={() => {
                      setKeySaving(true)
                      void onSaveApiKey(keyInput.trim())
                        .then(() => setKeyInput(''))
                        .catch(() => {})
                        .finally(() => setKeySaving(false))
                    }}
                  >{keySaving ? '保存中…' : '连接'}</button>
                ) : null}
              </span>
            )}
            </div>
            <i className="account-browser__divider" aria-hidden="true" />
            <div className="account-browser__window-cell" title="Token 导入与自动化执行的窗口——按当前网络选择挂代理或直连，窗口需预先登录 cursor.com">
              <span><b>执行窗口</b><small>{selectedProfile ? `已选择 ${selectedProfile.name}` : '选择已登录 cursor.com 的窗口'}</small></span>
              <MenuSelect
                value={settings.bitProfileId ?? ''}
                placeholder="选择窗口…"
                disabled={disabled}
                ariaLabel="选择指纹浏览器执行窗口"
                options={(profiles ?? []).map((profile) => ({
                  value: profile.id,
                  label: `${profile.seq !== undefined ? `#${profile.seq} ` : ''}${profile.name}`
                }))}
                onChange={(value) => onSettingsChange({ ...settings, bitProfileId: value || undefined })}
              />
            </div>
            {onRefreshProfiles ? (
              <button type="button" className="account-browser__refresh" disabled={disabled} title="重新获取窗口列表" aria-label="刷新指纹浏览器窗口" onClick={onRefreshProfiles}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.7 7A6.2 6.2 0 1 0 16 12.2M15.7 3.8V7h-3.2" /></svg>
              </button>
            ) : null}
          </div>
          {profilesMessage ? <p className="account-browser__error" role="alert">{profilesMessage}</p> : null}
          {onCleanupEnvironment ? (
            <div className="account-browser__cleanup">
              <span className="account-browser__cleanup-text">
                <b>环境清理</b>
                <small>清除该窗口的 Cursor 站点数据、Roxy 本地/云端缓存并轮换指纹；清理后需重新登录</small>
              </span>
              <button
                type="button"
                className={`account-browser__cleanup-button${cleanupArmed ? ' is-confirming' : ''}`}
                disabled={disabled || cleanupBusy || !settings.bitProfileId}
                title={!settings.bitProfileId
                  ? '请先选择指纹浏览器执行窗口'
                  : cleanupArmed
                    ? '再次点击确认清理（不可撤销）：关闭窗口 → 清空 Cursor 站点数据与 Roxy 缓存 → 轮换指纹'
                    : '一键清理选定窗口的 Cursor 相关缓存并轮换指纹（首次点击进入确认状态）'}
                onClick={runCleanup}
              >
                <CleanupGlyph />
                {cleanupBusy ? '清理中…' : cleanupArmed ? '确认清理' : '一键清理'}
              </button>
            </div>
          ) : null}
          {cleanupNote ? (
            <p className={`account-browser__cleanup-note${cleanupBusy ? '' : cleanupNote.includes('已清理') ? ' is-ok' : ' is-fail'}`} role="status">{cleanupNote}</p>
          ) : null}
        </div>
      ) : (
        <div className="account-browser__system-note">
          <BrowserGlyph kind="system" />
          <span><strong>使用现有登录会话</strong><small>需在 Edge / Chrome 登录 cursor.com；秒级处理还需允许 Apple Events 执行 JavaScript。</small></span>
        </div>
      )}
    </section>
  )
}
