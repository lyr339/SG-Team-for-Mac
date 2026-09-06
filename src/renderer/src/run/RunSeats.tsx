import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AgentLaunchPlan } from '../../../domain/agent-launch'
import type { CdpAutoHealEvent } from '../../../domain/cursor-cdp'
import type { CursorModelOption, CursorModelSelection } from '../../../domain/cursor-model'
import { cursorModelSelectionFromOption, cursorModelSelectionSummary } from '../cursor-model-selection'
import { formatRelativeTime } from '../format'
import { CursorModelConfigDialog } from '../lobby/CursorModelConfigDialog'
import { ToggleSwitch } from '../lobby/ToggleSwitch'
import { SEAT_STATE_LABEL, type RunSeatState } from './run-view'

export interface RunSeatRow {
  channelId: string
  name: string
  /** 团队席位显示角色；独立席位不显示。 */
  roleName?: string
  /** 配置中的新席位没有运行态。 */
  state?: RunSeatState
  lastSeenAt?: number
  /** 本次创建的目标（未待命 / 待创建）。 */
  pending: boolean
}

interface RunSeatsProps {
  rows: RunSeatRow[]
  cursorModels: CursorModelOption[]
  selections: Record<string, CursorModelSelection>
  plan?: AgentLaunchPlan
  busy: boolean
  /** 主按钮文案由页面按模式与阶段决定（批量创建 / 补齐 / 一键创建）。 */
  createLabel: string
  /** 非空时禁用创建并解释原因（例如仍在确认离线会话的运行状态）。 */
  createBlockedReason?: string
  /** 运行已结束：席位只作记录展示，不再提供创建。 */
  ended?: boolean
  /** 用户刚保存目标 / 启动团队：滚到创建区并聚焦主按钮。 */
  guided?: boolean
  cdpAutoHealEnabled: boolean
  cdpAutoHealEvent?: CdpAutoHealEvent
  onCreate: () => void
  onModelSave: (channelId: string, selection: CursorModelSelection) => Promise<void> | void
  onEnableCdp?: () => void
  onToggleAutoHeal?: (enabled: boolean) => void
  onCancelCountdown?: () => void
}

/**
 * 席位区：两种模式共用同一个列表——通道、名字/角色、模型、运行态。
 * 点击一行改该席位下一次创建会话用的模型；底部一个创建按钮只针对未待命席位。
 */
export function RunSeats({
  rows,
  cursorModels,
  selections,
  plan,
  busy,
  createLabel,
  createBlockedReason,
  ended = false,
  guided = false,
  cdpAutoHealEnabled,
  cdpAutoHealEvent,
  onCreate,
  onModelSave,
  onEnableCdp,
  onToggleAutoHeal,
  onCancelCountdown
}: RunSeatsProps): React.JSX.Element {
  const launching = plan?.state === 'running'
  const needsCdp = !launching && Boolean(plan?.items.some((item) => item.code === 'cdp_unavailable'))
  const pendingCount = rows.filter((row) => row.pending).length
  const [countdownLeft, setCountdownLeft] = useState(0)
  const [editingChannel, setEditingChannel] = useState<string>()
  const sectionRef = useRef<HTMLElement>(null)
  const createRef = useRef<HTMLButtonElement>(null)

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
      createRef.current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [guided])

  const planByChannel = new Map(plan?.items.map((item) => [item.channelId, item] as const) ?? [])

  return (
    <section ref={sectionRef} className={`run-seats${guided ? ' is-guided' : ''}`} aria-label="席位">
      <header className="run-section-head">
        <strong>席位</strong>
        <span>{ended ? `${rows.length} 席 · 运行已结束` : pendingCount ? `${pendingCount} / ${rows.length} 待创建会话` : rows.length ? '全部在岗' : '尚无席位'}</span>
      </header>

      {guided ? (
        <p className="run-seats__guide" role="status" aria-live="polite">
          下一步：确认模型后创建 {pendingCount} 个 Cursor 会话
        </p>
      ) : null}

      <ul className="run-seats__list" aria-label="逐会话模型配置">
        {rows.map((row, index) => {
          const selection = selections[row.channelId]
          const option = cursorModels.find((model) => model.modelId === selection?.modelId)
          const progress = planByChannel.get(row.channelId)
          return (
            <li
              key={row.channelId}
              className={`run-seat${row.pending ? ' is-pending' : ''}${row.state ? ` is-${row.state}` : ''}`}
              style={{ '--seat-index': Math.min(index, 8) } as CSSProperties}
            >
              <button
                type="button"
                aria-label={`配置 CH-${row.channelId} 会话`}
                className="run-seat__main"
                disabled={launching || !cursorModels.length}
                onClick={() => setEditingChannel(row.channelId)}
              >
                <b className="run-seat__channel">CH-{row.channelId}</b>
                <span className="run-seat__who">
                  <strong>{row.name}</strong>
                  {row.roleName && row.roleName !== row.name ? <small>{row.roleName}</small> : null}
                </span>
                <span className="run-seat__model">
                  <strong>{selection?.displayName ?? 'Cursor 当前模型'}</strong>
                  <small>{cursorModelSelectionSummary(selection, option)}</small>
                </span>
                <i aria-hidden="true">›</i>
              </button>
              <span className="run-seat__state">
                {progress && (launching || progress.stage === 'failed') ? (
                  <em className={`run-seat__progress is-${progress.stage}`} title={progress.message}>{progress.message}</em>
                ) : row.state ? (
                  <em className={`run-seat__badge is-${row.state}`}>
                    <i aria-hidden="true" />{SEAT_STATE_LABEL[row.state]}
                    {row.state === 'unconfirmed' ? <small>尚无工具调用证据</small> : row.lastSeenAt ? <small>{formatRelativeTime(row.lastSeenAt)}</small> : null}
                  </em>
                ) : (
                  <em className="run-seat__badge is-new"><i aria-hidden="true" />待创建</em>
                )}
              </span>
            </li>
          )
        })}
      </ul>

      {plan?.state === 'failed' && !needsCdp ? (
        <p className="run-seats__hint">可重试失败的通道；也可以在 Cursor 中手动发起，拾光检测到待命后会自动接管。</p>
      ) : null}

      {needsCdp && onEnableCdp ? (
        <div className="run-seats__cdp is-required" role="alert">
          <span>会话创建需要 Cursor 开启调试端口（一次性设置）。</span>
          <button type="button" className="secondary-button" disabled={busy || launching} onClick={onEnableCdp}>重启 Cursor 并启用会话创建</button>
        </div>
      ) : null}
      {cdpAutoHealEvent?.phase === 'countdown' ? (
        <div className="run-seats__cdp is-countdown" role="alert">
          <span>检测到 Cursor 未启用会话创建端口，{countdownLeft} 秒后将自动重启并打开当前工作区。</span>
          <button type="button" className="secondary-button" onClick={onCancelCountdown}>取消本次自动重启</button>
        </div>
      ) : null}
      {cdpAutoHealEvent?.phase === 'restarting' ? (
        <div className="run-seats__cdp is-working" role="status">正在优雅重启 Cursor、打开工作区并启用会话创建端口…</div>
      ) : null}

      <footer className="run-seats__footer">
        {onToggleAutoHeal ? (
          <ToggleSwitch checked={cdpAutoHealEnabled} disabled={busy} onChange={(enabled) => void onToggleAutoHeal(enabled)}>
            <span title="开启后：检测到 Cursor 运行但未启用会话创建端口时，会先显示 10 秒可取消倒计时，再自动重启 Cursor、打开当前工作区并启用端口。">自动保持会话创建端口</span>
          </ToggleSwitch>
        ) : <span />}
        <span className="run-seats__create">
          {createBlockedReason ? <small>{createBlockedReason}</small> : null}
          {ended ? (
            <small>席位随新一轮或新批次重新创建</small>
          ) : pendingCount === 0 && !launching ? (
            <small className="run-seats__settled">所有席位已在岗，无需创建会话</small>
          ) : (
            <button
              ref={createRef}
              type="button"
              className="primary-button"
              disabled={busy || launching || Boolean(createBlockedReason)}
              onClick={onCreate}
            >{launching ? '创建中…' : createLabel}</button>
          )}
        </span>
      </footer>

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
