import { useEffect, useRef, useState } from 'react'

/**
 * 阶段 G（RC-9）：共享 append-only 文本播放器——速率控制版。
 *
 * 供 Thinking 正文、过程 message、回合正文（TurnResponseText）共用同一打字机语义。
 *
 * 为什么不是「按积压比例追赶」：旧实现每帧显示 `remaining/22` 个字，速度由网络
 * chunk 大小决定而不是由时间决定——每个 chunk 到达都是先冲后爬（指数 ease-out），
 * 中文 25 字/秒的上游下缓冲 130ms 内排空、随后停住等下一段，呈「走-停-走-停」。
 *
 * 本实现对齐 VS Code / Cursor 聊天面板的渐进渲染模型：
 * 1. 以「字/秒」为唯一速度语义，按真实帧间隔 dt 推进（120Hz 与 60Hz 同速）；
 * 2. 刻意落后上游一个延迟预算（目标积压 = 上游吞吐 × latencyMs），吸收 chunk 抖动，
 *    缓冲不见底就不会停顿；
 * 3. 速率是上游吞吐 EMA 与积压误差的闭环控制量，再经时间常数 rateTauMs 平滑——
 *    速度变化走斜坡而不是台阶；
 * 4. 上下限夹紧：低于 minRate 会显得卡顿，高于 maxRate 会失去「打字」观感；
 * 5. done 后尾部继续匀速排空（≤ doneDrainMs），不瞬间跳全文；
 * 6. 一个常驻 rAF 循环，文本增长只更新目标，不重启循环；
 * 7. 按 grapheme 切分（emoji / 组合字符不被劈开）；
 * 8. 保留：来源 id 变化重置；同源文本回退（新文本不再是可见前缀）整体对齐；
 *    prefers-reduced-motion / immediate 直出全文；firstFrameDoneFull 历史水合；
 * 9. hydrate：观看者到来前已存在的文字（切会话进入进行中的回合）落位不重播，
 *    播放只针对之后到达的增量——打字机表达的是「正在发生」，不是「曾经发生」。
 */
export interface StreamingTextSource {
  /** 稳定身份（block id / turn key）；变化即重置播放。 */
  id: string
  /** 目标全文。 */
  text: string
  /** 来源是否已收尾（块 done / 回复 complete / 已落库）。 */
  done: boolean
}

export interface StreamingTextOptions {
  /** 首次观测即 done 时直接完整显示（历史水合）。直播上下文传 false：新到即
   *  done 的 Thinking 同样需要播放（RC-9）。 */
  firstFrameDoneFull?: boolean
  /** 禁用播放（历史/封口卡）——恒等全文。 */
  immediate?: boolean
  /**
   * 观看者到来之前这段文字就已经存在（切换会话进入正在生成的回合、冷启动水合）：
   * 播放器创建时直接落到当前全文，只对之后新增的部分打字——不管来源此刻是 done
   * 还是 streaming。区别于 firstFrameDoneFull（只在 done 时全文），它解决的是
   * 「正在流式输出的正文切进来被从头重放」与「直播卡里早已写完的思考再播一遍」。
   * 只作用于播放器的首次创建；之后 id 变化仍按直播语义从空串播放（新到达的来源）。
   */
  hydrate?: boolean
}

/** 播放器参数（单位：字/秒、毫秒）。导出供测试与调参。 */
export const STREAMING_TEXT_TUNING = {
  /**
   * 速度下限。必须低于常见上游吞吐（中文模型 15–40 字/秒），否则播放永远追平上游、
   * 缓冲建不起来，每段到达后排空即停顿——「走-停-走-停」正是下限过高的症状。
   */
  minRate: 12,
  /** 尚无吞吐样本时的起步速率：首段文本不至于慢吞吞，等样本到齐后由控制器接管。 */
  coldStartRate: 30,
  /** 速度上限：超过即失去打字观感，变成整段粘贴。 */
  maxRate: 480,
  /** 延迟预算：目标积压 = 上游吞吐 × latencyMs，用于吸收 150–250ms 级 chunk 抖动。 */
  latencyMs: 400,
  /** 速率平滑时间常数：速度变化走斜坡，不出现肉眼可见的台阶。 */
  rateTauMs: 220,
  /** done 之后尾部最长排空时间。 */
  doneDrainMs: 500,
  /** 积压上限：超过 maxRate × maxLagMs 的部分直接显示（一次性巨帧的病理场景）。 */
  maxLagMs: 1500,
  /** 单帧最大 dt：切后台 / 卡顿恢复后不允许一帧补跳。 */
  maxFrameMs: 100,
  /** rAF 时间戳不可用或不前进时的名义帧长。 */
  nominalFrameMs: 1000 / 60,
  /** 上游吞吐采样的最小间隔：同一微任务批次内的多次写合并为一次采样。 */
  minSampleGapMs: 20,
  /** 上游吞吐 EMA 系数（按到达事件）。 */
  inputRateAlpha: 0.3
}

interface PlayerState {
  id: string
  target: string
  /** offsets[k] = 前 k 个 grapheme 的字符结束下标；offsets[0] = 0。 */
  offsets: number[]
  /** 已显示 grapheme 数（浮点累积）。 */
  shown: number
  /** 当前速率（grapheme/秒）。 */
  rate: number
  /** 上游吞吐 EMA（grapheme/秒）；0 表示尚无样本。 */
  inputRate: number
  lastArrivalAt: number
  lastArrivalUnits: number
  done: boolean
  lastFrameAt?: number
  frame: number
}

const segmenter: Intl.Segmenter | undefined = (() => {
  try {
    return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : undefined
  } catch {
    return undefined
  }
})()

/** 把 text[from..] 按 grapheme 追加到 offsets（就地修改）。 */
function appendGraphemeOffsets(offsets: number[], text: string, from: number): void {
  const tail = text.slice(from)
  if (!tail) return
  let cursor = from
  if (segmenter) {
    for (const segment of segmenter.segment(tail)) {
      cursor += segment.segment.length
      offsets.push(cursor)
    }
    return
  }
  for (const unit of Array.from(tail)) {
    cursor += unit.length
    offsets.push(cursor)
  }
}

function unitsOf(state: PlayerState): number {
  return state.offsets.length - 1
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function prefersReducedMotion(): boolean {
  // node 环境静态渲染（无 window）不视为 reduced-motion；effect 阶段在
  // 浏览器内再次读取，语义以真实媒体查询为准。
  if (typeof window === 'undefined') return false
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

/** 计算某来源的初始可见文本（同步首帧，避免静态渲染/水合闪烁）。 */
export function initialStreamingText(
  source: StreamingTextSource,
  options: Pick<StreamingTextOptions, 'firstFrameDoneFull' | 'immediate' | 'hydrate'>
): string {
  if (options.immediate === true) return source.text
  if (prefersReducedMotion()) return source.text
  if (options.hydrate === true) return source.text
  return source.done && options.firstFrameDoneFull === true ? source.text : ''
}

function createState(id: string, text: string, done: boolean, showAll: boolean, at: number): PlayerState {
  const offsets = [0]
  appendGraphemeOffsets(offsets, text, 0)
  const units = offsets.length - 1
  return {
    id,
    target: text,
    offsets,
    shown: showAll ? units : 0,
    rate: STREAMING_TEXT_TUNING.coldStartRate,
    inputRate: 0,
    lastArrivalAt: at,
    lastArrivalUnits: units,
    done,
    frame: 0
  }
}

/**
 * 单帧推进（纯函数式状态更新，导出供测试直接驱动）：返回本帧应显示的文本，
 * 或 undefined 表示可见文本无需变化。
 */
export function advanceStreamingPlayer(state: PlayerState, frameNow: number): string | undefined {
  const tuning = STREAMING_TEXT_TUNING
  const total = unitsOf(state)
  let dt = state.lastFrameAt === undefined ? tuning.nominalFrameMs : frameNow - state.lastFrameAt
  if (!(dt > 0) || !Number.isFinite(dt)) dt = tuning.nominalFrameMs
  dt = Math.min(dt, tuning.maxFrameMs)
  state.lastFrameAt = frameNow
  let backlog = total - state.shown
  if (backlog <= 0) {
    state.shown = total
    return undefined
  }
  // 积压上限：一次性巨帧（重连水合、整段 done thinking）只保留 maxLag 的匀速尾巴。
  const maxBacklog = tuning.maxRate * tuning.maxLagMs / 1000
  if (backlog > maxBacklog) {
    state.shown = total - maxBacklog
    backlog = maxBacklog
  }
  // 闭环速率：上游吞吐 + 积压误差 / 延迟预算；无吞吐样本时按预算内排空。
  const latency = tuning.latencyMs / 1000
  let desired = state.inputRate > 0
    ? state.inputRate + (backlog - state.inputRate * latency) / latency
    : backlog / latency
  if (state.done) desired = Math.max(desired, backlog / (tuning.doneDrainMs / 1000))
  desired = Math.min(tuning.maxRate, Math.max(tuning.minRate, desired))
  const alpha = 1 - Math.exp(-dt / tuning.rateTauMs)
  state.rate += (desired - state.rate) * alpha
  state.shown = Math.min(total, state.shown + state.rate * dt / 1000)
  const shownUnits = Math.floor(state.shown)
  return state.target.slice(0, state.offsets[shownUnits] ?? state.target.length)
}

/** 目标文本更新（导出供测试）：返回需要立即发布的可见文本（回退对齐），否则 undefined。 */
export function updateStreamingTarget(
  state: PlayerState,
  text: string,
  done: boolean,
  visible: string,
  at: number
): string | undefined {
  state.done = done
  if (text === state.target) return undefined
  if (text.startsWith(visible)) {
    // 追加（或未显示尾部被改写）：从可见边界重新切分尾部，保留已显示部分。
    const shownUnits = Math.min(Math.floor(state.shown), unitsOf(state))
    const shownEnd = state.offsets[shownUnits] ?? 0
    const keep = Math.min(shownEnd, visible.length)
    let keepUnits = shownUnits
    while (keepUnits > 0 && (state.offsets[keepUnits] ?? 0) > keep) keepUnits -= 1
    state.offsets.length = keepUnits + 1
    appendGraphemeOffsets(state.offsets, text, state.offsets[keepUnits] ?? 0)
    // 保留帧内的小数进度：原生写入节奏下每 20–40ms 一次到达，若每次都截掉小数，
    // 有效速率会被系统性拉低。
    if (Math.floor(state.shown) > keepUnits) state.shown = keepUnits
    const previousTarget = state.target
    state.target = text
    if (text.length > previousTarget.length && text.startsWith(previousTarget)) {
      const gap = at - state.lastArrivalAt
      const added = unitsOf(state) - state.lastArrivalUnits
      if (gap >= STREAMING_TEXT_TUNING.minSampleGapMs && added > 0) {
        const instant = added / gap * 1000
        state.inputRate = state.inputRate > 0
          ? state.inputRate + (instant - state.inputRate) * STREAMING_TEXT_TUNING.inputRateAlpha
          : instant
        state.lastArrivalAt = at
        state.lastArrivalUnits = unitsOf(state)
      }
    } else {
      state.lastArrivalAt = at
      state.lastArrivalUnits = unitsOf(state)
    }
    return undefined
  }
  // 同源文本回退（可见前缀不再成立）：来源语义为整体替换，对齐新全文。
  state.target = text
  state.offsets = [0]
  appendGraphemeOffsets(state.offsets, text, 0)
  state.shown = unitsOf(state)
  state.lastArrivalAt = at
  state.lastArrivalUnits = state.shown
  return text
}

export function useStreamingText(
  source: StreamingTextSource,
  options: StreamingTextOptions = {}
): string {
  const { id, text, done } = source
  const immediate = options.immediate === true
  const firstFrameDoneFull = options.firstFrameDoneFull === true
  // hydrate 在挂载时锁定：它描述的是「观看者到来时文字是否已在」，之后 props 翻转不改变语义。
  const hydrateOnCreate = useRef(options.hydrate === true)
  const [visible, setVisible] = useState(() => initialStreamingText(source, options))
  const visibleRef = useRef(visible)
  const player = useRef<PlayerState | null>(null)

  useEffect(() => {
    if (immediate) return
    const publish = (next: string): void => {
      if (visibleRef.current === next) return
      visibleRef.current = next
      setVisible(next)
    }
    const stopLoop = (): void => {
      const state = player.current
      if (state?.frame) {
        cancelAnimationFrame(state.frame)
        state.frame = 0
      }
    }
    if (prefersReducedMotion()) {
      stopLoop()
      player.current = null
      publish(text)
      return
    }
    const at = nowMs()
    let state = player.current
    if (!state || state.id !== id) {
      // 首次创建且观看者到来前文字已在（hydrate）：落到当前全文，只播之后的增量。
      // 来源切换：直播上下文从空串重新播放；历史水合语义（firstFrameDoneFull）
      // 且新来源已 done 时直接全文。
      stopLoop()
      const showAll = (!state && hydrateOnCreate.current) || (done && firstFrameDoneFull)
      state = createState(id, text, done, showAll, at)
      player.current = state
      publish(showAll ? text : '')
    } else {
      const snapped = updateStreamingTarget(state, text, done, visibleRef.current, at)
      if (snapped !== undefined) publish(snapped)
    }
    if (state.shown >= unitsOf(state) || state.frame) return
    // 循环从空闲重启：上一帧时间戳已过期，若按真实间隔推进，首帧会把空闲期
    // 的时间一次性补跳成一小段爆发。按名义帧长起步。
    state.lastFrameAt = undefined
    const tick = (frameNow: number): void => {
      const current = player.current
      if (!current || current !== state) return
      current.frame = 0
      const next = advanceStreamingPlayer(current, frameNow)
      if (next !== undefined) publish(next)
      if (current.shown < unitsOf(current)) current.frame = requestAnimationFrame(tick)
    }
    state.frame = requestAnimationFrame(tick)
  }, [id, text, done, immediate, firstFrameDoneFull])

  useEffect(() => () => {
    const state = player.current
    if (state?.frame) cancelAnimationFrame(state.frame)
    player.current = null
  }, [])

  return immediate ? text : visible
}
