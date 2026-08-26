import { useEffect, useState } from 'react'
import type { AgentLaunchPlan } from '../../../domain/agent-launch'
import type { CdpAutoHealEvent } from '../../../domain/cursor-cdp'

interface LobbySessionLaunchTileProps {
  pendingChannels: string[]
  isPrelaunch: boolean
  plan?: AgentLaunchPlan
  busy: boolean
  cdpAutoHealEnabled: boolean
  cdpAutoHealEvent?: CdpAutoHealEvent
  onLaunch: () => void
  onEnableCdp?: () => void
  onToggleAutoHeal?: (enabled: boolean) => void
  onCancelCountdown?: () => void
}

export function LobbySessionLaunchTile({
  pendingChannels,
  isPrelaunch,
  plan,
  busy,
  cdpAutoHealEnabled,
  cdpAutoHealEvent,
  onLaunch,
  onEnableCdp,
  onToggleAutoHeal,
  onCancelCountdown
}: LobbySessionLaunchTileProps): React.JSX.Element {
  const launching = plan?.state === 'running'
  const needsCdp = !launching && Boolean(plan?.items.some((item) => item.code === 'cdp_unavailable'))

  const [countdownLeft, setCountdownLeft] = useState(0)
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

  return (
    <section className="lobby-tile lobby-launch">
      <header className="lobby-tile__head">
        <strong>Agent 会话</strong>
        <span>{pendingChannels.length ? `${pendingChannels.length} 个通道未待命` : '全部待命'}</span>
      </header>
      <div className="lobby-launch__body">
        <span className="lobby-launch__desc">{isPrelaunch
          ? '为未待命通道并发创建全新会话并验证进入待命；无需在 Cursor 手动操作，会话模型沿用 Cursor 当前选择。'
          : '团队已启动但仍有成员未待命：一键补齐会话，或等待手动发起的会话进入待命后自动接管。'}</span>
        {plan && plan.items.length > 0 ? (
          <ul className="v2-session-launch__list">
            {plan.items.map((item) => (
              <li key={item.channelId} className={`is-${item.stage}`}><i /><b>CH-{item.channelId}</b><span>{item.message}</span></li>
            ))}
          </ul>
        ) : null}
        {plan?.state === 'failed' && !needsCdp ? (
          <span className="lobby-launch__hint">可重试失败的通道；也可以在 Cursor 中手动发起，群枢检测到待命后会自动接管。</span>
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
          <label className="cdp-autoheal-toggle" title="开启后：检测到 Cursor 运行但未启用会话创建端口时，会先显示 10 秒可取消倒计时，再自动重启 Cursor、打开当前团队工作区并启用端口。">
            <input
              type="checkbox"
              checked={cdpAutoHealEnabled}
              disabled={busy}
              onChange={(event) => onToggleAutoHeal(event.target.checked)}
            />
            <span>自动保持会话创建端口</span>
          </label>
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
          className="lobby-launch__button"
          disabled={busy || launching || pendingChannels.length === 0}
          onClick={onLaunch}
        >{launching ? '创建中…' : `一键创建会话（${pendingChannels.length}）`}</button>
      </div>
    </section>
  )
}
