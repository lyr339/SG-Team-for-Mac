import { useEffect, useMemo, useState } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import {
  formatHandoffTime,
  SESSION_HANDOFF_NOTE_MAX_CHARS,
  type SessionHandoffContext,
  type SessionHandoffResult,
  type SessionHandoffTarget
} from '../../domain/session-handoff'
import { formatFileSize } from '../../shared/format-file-size'
import { AgentAvatar } from './AgentAvatar'
import { statusLabel } from './format'

interface SessionHandoffDialogProps {
  session: AgentSession
  sessions: AgentSession[]
  /** 备用通道（已接入 MCP 但未编入本轮席位）；候选列表标「备用」并排在同角色之后。 */
  standbyChannelIds?: readonly string[]
  loadContext: (channelId: string) => Promise<SessionHandoffContext>
  deliver: (input: { sourceChannelId: string; target: SessionHandoffTarget; note?: string }) => Promise<SessionHandoffResult>
  revealPath?: (path: string) => Promise<boolean>
  onOpenSession?: (channelId: string) => void
  onClose: () => void
}

type TargetChoice = 'self' | `ch:${string}`

function targetOf(choice: TargetChoice): SessionHandoffTarget {
  return choice === 'self' ? { kind: 'self' } : { kind: 'channel', channelId: choice.slice(3) }
}

/** 席位标签：displayName 已含「· CH-N」时不重复拼接通道号。 */
export function seatLabel(candidate: Pick<AgentSession, 'displayName' | 'channelId'>): string {
  const name = candidate.displayName.trim()
  return name.includes(`CH-${candidate.channelId}`) ? name : `${name} · CH-${candidate.channelId}`
}

function targetState(candidate: AgentSession): { label: string; eligible: boolean; tone: 'online' | 'busy' | 'offline' } {
  if (!candidate.online) return { label: '离线：消息会留在它的队列，恢复后送达', eligible: true, tone: 'offline' }
  if (candidate.waiting) return { label: '待命中：立即投递', eligible: true, tone: 'online' }
  return { label: `${statusLabel(candidate.status)}：排在当前任务之后`, eligible: true, tone: 'busy' }
}

/** 候选与来源的关系标签：同角色（团队席位间）/ 备用通道；其余无标签。 */
export type TargetRelation = 'same-role' | 'standby' | undefined

export function targetRelation(
  source: Pick<AgentSession, 'roleTemplateKey'>,
  candidate: Pick<AgentSession, 'channelId' | 'roleTemplateKey'>,
  standbyChannelIds: ReadonlySet<string>
): TargetRelation {
  if (standbyChannelIds.has(candidate.channelId)) return 'standby'
  const sameRole = Boolean(source.roleTemplateKey)
    && source.roleTemplateKey !== 'solo'
    && candidate.roleTemplateKey === source.roleTemplateKey
  return sameRole ? 'same-role' : undefined
}

const RELATION_LABEL: Record<Exclude<TargetRelation, undefined>, string> = { 'same-role': '同角色', standby: '备用通道' }
const RELATION_RANK: Record<Exclude<TargetRelation, undefined>, number> = { 'same-role': 0, standby: 1 }

/**
 * 候选排序：同角色 > 备用通道 > 在线待命 > 在线忙碌 > 离线，同级按通道号。
 * 把实现席的上下文交给验收席通常没有意义，同角色与备用（无角色包袱）优先。
 */
export function sortHandoffTargets(
  source: Pick<AgentSession, 'channelId' | 'roleTemplateKey'>,
  sessions: readonly AgentSession[],
  standbyChannelIds: ReadonlySet<string>
): AgentSession[] {
  const rank = (candidate: AgentSession): number => {
    const relation = targetRelation(source, candidate, standbyChannelIds)
    return relation ? RELATION_RANK[relation] : 2
  }
  return sessions
    .filter((candidate) => candidate.channelId !== source.channelId)
    .sort((left, right) => (
      rank(left) - rank(right)
      || Number(right.online) - Number(left.online)
      || Number(right.waiting) - Number(left.waiting)
      || Number(left.channelId) - Number(right.channelId)
    ))
}

/**
 * 会话交接弹窗（独立席位与团队席位共用）。
 *
 * 先定位当前 Cursor 会话的上下文文档（agent 转录 JSONL）在本机的精确路径与落盘状态，
 * 再选择把它投递到：本会话（等待新会话保持位，留给重建后的自己）或另一个会话的队列。
 * 拾光同时导出本通道的会话记录（Markdown）一并投递，弥补 Cursor 转录在原会话未结束时
 * 的滞后。目标为团队席位时，消息正文由主进程附上团队接收方说明（不是任务板任务）。
 */
export function SessionHandoffDialog({
  session,
  sessions,
  standbyChannelIds,
  loadContext,
  deliver,
  revealPath,
  onOpenSession,
  onClose
}: SessionHandoffDialogProps): React.JSX.Element {
  const [context, setContext] = useState<SessionHandoffContext>()
  const [loadError, setLoadError] = useState('')
  const [choice, setChoice] = useState<TargetChoice>('self')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<SessionHandoffResult>()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setContext(undefined)
    setLoadError('')
    loadContext(session.channelId)
      .then((value) => { if (!cancelled) setContext(value) })
      .catch((reason: unknown) => { if (!cancelled) setLoadError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [loadContext, session.channelId])

  const standby = useMemo(() => new Set(standbyChannelIds ?? []), [standbyChannelIds])
  const sourceChannelId = session.channelId
  const sourceRoleTemplateKey = session.roleTemplateKey
  const others = useMemo(() => (
    sortHandoffTargets({ channelId: sourceChannelId, roleTemplateKey: sourceRoleTemplateKey }, sessions, standby)
  ), [sessions, sourceChannelId, sourceRoleTemplateKey, standby])

  // 席位没有会话令牌时「本会话」不可选：落到排序后的首个候选（同角色 / 备用优先）。
  useEffect(() => {
    if (context && !context.holdSupported && choice === 'self') {
      const first = others[0]
      if (first) setChoice(`ch:${first.channelId}`)
    }
  }, [choice, context, others])

  const transcript = context?.transcript
  const canDeliver = Boolean(context && transcript && !busy && (choice !== 'self' || context.holdSupported))
  const targetLabel = choice === 'self' ? `CH-${session.channelId}（等待新会话）` : `CH-${choice.slice(3)}`

  const copyPath = async (): Promise<void> => {
    if (!transcript) return
    try {
      await navigator.clipboard.writeText(transcript.path)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_600)
    } catch {
      setError('复制失败：请手动选择路径文本复制')
    }
  }

  const submit = async (): Promise<void> => {
    if (!canDeliver) return
    setBusy(true)
    setError('')
    try {
      const delivered = await deliver({
        sourceChannelId: session.channelId,
        target: targetOf(choice),
        note: note.trim() ? note.trim() : undefined
      })
      setResult(delivered)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="handoff-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <section className="handoff-dialog session-handoff" role="dialog" aria-modal="true" aria-labelledby="session-handoff-title">
        <header>
          <div>
            <strong id="session-handoff-title">交接会话上下文</strong>
            <span>{seatLabel(session)}{context?.modelName ? ` · ${context.modelName}` : ''}</span>
          </div>
          <button disabled={busy} aria-label="关闭交接窗口" onClick={onClose}>×</button>
        </header>

        {result ? (
          <div className="handoff-done" role="status">
            <i aria-hidden="true">✓</i>
            <strong>已排队到 CH-{result.targetChannelId}</strong>
            <p>
              {result.held
                ? '带「等待新会话」保持位：当前 Agent 取不到这条消息；该席位在同一运行内重建后，新会话第一次轮询就会收到并阅读。'
                : '按普通排队投递：目标会话下一次轮询即会收到并阅读。'}
            </p>
            <dl>
              <div><dt>上下文文档</dt><dd><code>{result.transcriptPath}</code></dd></div>
              {result.recordPath ? <div><dt>拾光会话记录</dt><dd><code>{result.recordPath}</code></dd></div> : null}
            </dl>
            <footer>
              {onOpenSession && result.targetChannelId !== session.channelId ? (
                <button onClick={() => { onOpenSession(result.targetChannelId); onClose() }}>打开 CH-{result.targetChannelId}</button>
              ) : null}
              <button onClick={onClose}>完成</button>
            </footer>
          </div>
        ) : (
          <>
            <div className="session-handoff__body">
              <section className="session-handoff__block" aria-label="上下文文档">
                <h4><span>上下文文档</span><small>Cursor 会话转录 · JSONL</small></h4>
                {loadError ? <p className="session-handoff__error">{loadError}</p> : null}
                {!context && !loadError ? <p className="session-handoff__muted">正在定位 Cursor 转录文件…</p> : null}
                {context && !transcript ? (
                  <p className="session-handoff__error">该会话尚未绑定 Cursor Composer，找不到它的上下文文档；等会话启动并绑定后再试。</p>
                ) : null}
                {transcript ? (
                  <>
                    <code className="session-handoff__path" title={transcript.path}>{transcript.path}</code>
                    <div className="session-handoff__path-actions">
                      <button type="button" onClick={() => void copyPath()}>{copied ? '已复制' : '复制路径'}</button>
                      {revealPath && transcript.exists ? (
                        <button type="button" onClick={() => void revealPath(transcript.path)}>在 Finder 中显示</button>
                      ) : null}
                    </div>
                    <ul className="session-handoff__facts">
                      <li>
                        {transcript.exists
                          ? [
                              transcript.recordCount !== undefined ? `${transcript.recordCount} 条记录` : '',
                              transcript.sizeBytes !== undefined ? formatFileSize(transcript.sizeBytes) : '',
                              transcript.modifiedAt !== undefined ? `最后写入 ${formatHandoffTime(transcript.modifiedAt)}` : ''
                            ].filter(Boolean).join(' · ')
                          : '文件尚不存在（Cursor 通常在首次回复后创建）；下面显示的是按工程目录推导的精确路径'}
                      </li>
                      <li className={session.online ? 'is-warning' : ''}>
                        {session.online
                          ? 'Cursor 只在会话回合结束后写入完整转录；本会话仍在运行，转录会滞后到它停止或被重建后才补齐——交接消息里已附上等待重读的指引。'
                          : '本会话已离线：转录应已是最终内容。'}
                      </li>
                      <li>
                        拾光记录：{context?.userMessageCount ?? 0} 条用户消息 / {context?.assistantMessageCount ?? 0} 条回复
                        {context?.firstMessageAt !== undefined && context.lastMessageAt !== undefined
                          ? `（${formatHandoffTime(context.firstMessageAt)} – ${formatHandoffTime(context.lastMessageAt)}）`
                          : ''}
                        ；投递时会导出为 Markdown 一并交接。
                      </li>
                    </ul>
                  </>
                ) : null}
              </section>

              <section className="session-handoff__block" aria-label="投递到">
                <h4><span>投递到</span><small>排进目标通道的消息队列</small></h4>
                <div className="session-handoff__targets">
                  <label className={`session-handoff__target ${choice === 'self' ? 'is-selected' : ''} ${context && !context.holdSupported ? 'is-disabled' : ''}`}>
                    <input
                      type="radio"
                      name="session-handoff-target"
                      checked={choice === 'self'}
                      disabled={busy || Boolean(context && !context.holdSupported)}
                      onChange={() => setChoice('self')}
                    />
                    <span className="session-handoff__target-face"><AgentAvatar avatarId={session.avatarId} name={session.displayName} online={session.online} size="sm" /></span>
                    <span className="session-handoff__target-text">
                      <strong>本会话 · CH-{session.channelId}</strong>
                      <small>
                        {context && !context.holdSupported
                          ? '当前席位没有会话令牌，无法区分新旧会话（旧版会话或备用接管），请选择其他会话'
                          : '等待新会话：当前 Agent 取不到；同一运行内重建该席位后，新会话首次轮询即收到'}
                      </small>
                    </span>
                    <em>下次启动</em>
                  </label>
                  {others.map((candidate) => {
                    const state = targetState(candidate)
                    const relation = targetRelation(session, candidate, standby)
                    const value: TargetChoice = `ch:${candidate.channelId}`
                    return (
                      <label key={candidate.channelId} className={`session-handoff__target ${choice === value ? 'is-selected' : ''} is-${state.tone}`}>
                        <input
                          type="radio"
                          name="session-handoff-target"
                          checked={choice === value}
                          disabled={busy || !state.eligible}
                          onChange={() => setChoice(value)}
                        />
                        <span className="session-handoff__target-face"><AgentAvatar avatarId={candidate.avatarId} name={candidate.displayName} online={candidate.online} size="sm" /></span>
                        <span className="session-handoff__target-text">
                          <strong>{seatLabel(candidate)}</strong>
                          <small>{relation ? `${RELATION_LABEL[relation]} · ` : ''}{state.label}</small>
                        </span>
                        <em>{candidate.online ? (candidate.waiting ? '在线' : '忙碌') : '离线'}</em>
                      </label>
                    )
                  })}
                  {!others.length ? <p className="session-handoff__muted">当前运行里没有其他会话。</p> : null}
                </div>
              </section>

              <section className="session-handoff__block" aria-label="交接说明">
                <h4><span>交接说明</span><small>可选 · 随消息一并送达</small></h4>
                <textarea
                  value={note}
                  maxLength={SESSION_HANDOFF_NOTE_MAX_CHARS}
                  disabled={busy}
                  placeholder="例如：接着把队列弹层的样式收尾；不要动 MCP 协议。"
                  onChange={(event) => setNote(event.target.value)}
                />
              </section>
            </div>
            {error ? <p className="handoff-dialog-error">{error}</p> : null}
            <footer>
              <button disabled={busy} onClick={onClose}>取消</button>
              <button disabled={!canDeliver} onClick={() => void submit()}>{busy ? '投递中…' : `投递到 ${targetLabel}`}</button>
            </footer>
          </>
        )}
      </section>
    </div>
  )
}
