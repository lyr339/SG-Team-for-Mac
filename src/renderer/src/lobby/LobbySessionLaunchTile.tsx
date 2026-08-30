import { useEffect, useRef, useState } from 'react'
import type { AgentLaunchPlan } from '../../../domain/agent-launch'
import type { CdpAutoHealEvent } from '../../../domain/cursor-cdp'
import type { CursorModelOption, CursorModelSelection } from '../../../domain/cursor-model'
import {
  cursorModelSelectionFromOption,
  cursorModelSelectionSummary
} from '../cursor-model-selection'
import { CursorModelConfigDialog } from './CursorModelConfigDialog'
import { ToggleSwitch } from './ToggleSwitch'

interface LobbySessionLaunchTileProps {
  pendingChannels: string[]
  cursorModels: CursorModelOption[]
  selections: Record<string, CursorModelSelection>
  isPrelaunch: boolean
  plan?: AgentLaunchPlan
  busy: boolean
  guided?: boolean
  cdpAutoHealEnabled: boolean
  cdpAutoHealEvent?: CdpAutoHealEvent
  onLaunch: () => void
  onModelSave: (channelId: string, selection: CursorModelSelection) => Promise<void> | void
  onEnableCdp?: () => void
  onToggleAutoHeal?: (enabled: boolean) => void
  onCancelCountdown?: () => void
}

export function LobbySessionLaunchTile({
  pendingChannels,
  cursorModels,
  selections,
  isPrelaunch,
  plan,
  busy,
  guided = false,
  cdpAutoHealEnabled,
  cdpAutoHealEvent,
  onLaunch,
  onModelSave,
  onEnableCdp,
  onToggleAutoHeal,
  onCancelCountdown
}: LobbySessionLaunchTileProps): React.JSX.Element {
  const launching = plan?.state === 'running'
  const needsCdp = !launching && Boolean(plan?.items.some((item) => item.code === 'cdp_unavailable'))

  const [countdownLeft, setCountdownLeft] = useState(0)
  const [editingChannel, setEditingChannel] = useState<string>()
  const sectionRef = useRef<HTMLElement>(null)
  const launchButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (cdpAutoHealEvent?.phase !== 'countdown') {
      setCountdownLeft(0)
      return
    }
    const update = (): void => setCountdownLeft(Math.max(0, Math.ceil((cdpAutoHealEvent.deadlineAt - Date.now()) / 1_000)))
    update()
    const timer = setInterval(update, 250)
    return () => clearInterval(timer)
  }, [cdpAutoHealEvent])

  useEffect(() => {
    if (!guided) return
    const frame = window.requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
      launchButtonRef.current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [guided])

  return (
    <section className={`lobby-tile lobby-launch${guided ? ' is-guided' : ''}`} ref={sectionRef} aria-label="Agent 会话创建">
      {guided ? (
        <div className="lobby-launch__guide" role="status" aria-live="polite">
          <span><b>下一步</b><strong>确认模型后创建 {pendingChannels.length} 个 Cursor 会话</strong></span>
          <i aria-hidden="true">↓</i>
        </div>
      ) : null}
      <header className="lobby-tile__head">
        <strong>Agent 会话</strong>
        <span>{pendingChannels.length ? `${pendingChannels.length} 个通道未待命` : '全部待命'}</span>
      </header>
      <div className="lobby-launch__body">
        <span className="lobby-launch__desc">{isPrelaunch
          ? '为每个通道按下方独立模型配置并发创建全新会话，再验证进入待命。'
          : '团队已启动但仍有成员未待命：一键补齐会话，或等待手动发起的会话进入待命后自动接管。'}</span>
        {pendingChannels.length ? (
          <div className="lobby-launch__models" aria-label="逐会话模型配置">
            {pendingChannels.map((channelId) => {
              const selection = selections[channelId]
              const option = cursorModels.find((model) => model.modelId === selection?.modelId)
              return (
                <button
                  aria-label={`配置 CH-${channelId} 会话`}
                  className="lobby-launch__model-row"
                  disabled={launching || !cursorModels.length}
                  key={channelId}
                  onClick={() => setEditingChannel(channelId)}
                >
                  <b>CH-{channelId}</b>
                  <span><strong>{selection?.displayName ?? 'Cursor 当前模型'}</strong><small>{cursorModelSelectionSummary(selection, option)}</small></span>
                  <i aria-hidden="true">›</i>
                </button>
              )
            })}
          </div>
        ) : null}
        {plan && plan.items.length > 0 ? (
          <ul className="v2-session-launch__list">
            {plan.items.map((item) => (
              <li key={item.channelId} className={`is-${item.stage}`}>
                <i /><b>CH-{item.channelId}</b>
                {item.modelSelection ? <em>{item.modelSelection.displayName}</em> : null}
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {plan?.state === 'failed' && !needsCdp ? (
          <span className="lobby-launch__hint">可重试失败的通道；也可以在 Cursor 中手动发起，拾光检测到待命后会自动接管。</span>
        ) : null}
        {needsCdp && onEnableCdp ? (
          <span className="lobby-launch__hint">
            会话创建需要 Cursor 开启调试端口（一次性设置）。
            <button
              className="lobby-launch__secondary"
              disabled={busy || launching}
              onClick={onEnableCdp}
            >重启 Cursor 并启用会话创建</button>
          </span>
        ) : null}
        {onToggleAutoHeal ? (
          <ToggleSwitch
            checked={cdpAutoHealEnabled}
            disabled={busy}
            onChange={(enabled) => void onToggleAutoHeal(enabled)}
          >
            <span title="开启后：检测到 Cursor 运行但未启用会话创建端口时，会先显示 10 秒可取消倒计时，再自动重启 Cursor、打开当前团队工作区并启用端口。">自动保持会话创建端口</span>
          </ToggleSwitch>
        ) : null}
        {cdpAutoHealEvent?.phase === 'countdown' ? (
          <div className="cdp-autoheal-countdown" role="alert">
            <span>检测到 Cursor 未启用会话创建端口，{countdownLeft} 秒后将自动重启并打开当前团队工作区。</span>
            <button className="lobby-launch__secondary" onClick={onCancelCountdown}>取消本次自动重启</button>
          </div>
        ) : null}
        {cdpAutoHealEvent?.phase === 'restarting' ? (
          <div className="cdp-autoheal-countdown is-working" role="status">正在优雅重启 Cursor、打开团队工作区并启用会话创建端口…</div>
        ) : null}
      </div>
      <div className="lobby-launch__footer">
        <button
          ref={launchButtonRef}
          className="lobby-launch__button"
          disabled={busy || launching || pendingChannels.length === 0}
          onClick={onLaunch}
        >{launching ? '创建中…' : `一键创建会话（${pendingChannels.length}）`}</button>
      </div>
      {editingChannel ? (
        <CursorModelConfigDialog
          channelId={editingChannel}
          disabled={launching}
          models={cursorModels}
          selection={selections[editingChannel] ?? cursorModelSelectionFromOption(
            cursorModels.find((model) => model.selected) ?? cursorModels[0]
          )}
          onSave={(selection) => onModelSave(editingChannel, selection)}
          onClose={() => setEditingChannel(undefined)}
        />
      ) : null}
    </section>
  )
}
