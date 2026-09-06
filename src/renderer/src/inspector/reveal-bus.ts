/**
 * 右栏 → 中栏的「定位」信号：点击活动项跳到时间线里对应的过程步骤 / 回合。
 * 两个组件不在同一棵子树下，用模块级订阅代替层层 prop 透传；只传 id，不传 DOM。
 *
 * 监听方分两类：准备方（ProcessTurnCard 展开目标步骤）与定位方（SessionWorkspace
 * 滚动并高亮）。请求方拿到的是「是否有人真的找到了目标」——找不到时右栏可以给出
 * 反馈，而不是静默无事发生。
 */
export interface RevealTarget {
  /** 过程块 id（ProcessTurnCard 渲染为 data-step-id="block:<id>"）。 */
  blockId?: string
  /** 会话条目 id（用户消息 / 回复）。 */
  entryId?: string
}

/** 返回 true 表示已定位到目标；准备方（只展开、不定位）返回 undefined。 */
type RevealListener = (target: RevealTarget) => boolean | void | Promise<boolean | void>

const listeners = new Set<RevealListener>()

export function subscribeReveal(listener: RevealListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 广播定位请求；任一监听方确认定位成功即为 true。单个监听方抛错不影响其他人。 */
export function requestReveal(target: RevealTarget): Promise<boolean> {
  if (!listeners.size) return Promise.resolve(false)
  const outcomes = [...listeners].map((listener) => {
    try {
      return Promise.resolve(listener(target)).catch(() => false)
    } catch {
      return Promise.resolve(false)
    }
  })
  return Promise.all(outcomes).then((results) => results.some((result) => result === true))
}

/** 过程块 id → ProcessTurnCard 的 step DOM 标识（与 process-turn-view 的 step id 规则一致）。 */
export function stepDomId(blockId: string): string {
  const stable = blockId.startsWith('cursor:todos:')
    ? 'cursor:todos'
    : blockId.startsWith('cursor:plan:') ? 'cursor:plan' : blockId
  return `block:${stable}`
}

const REVEAL_CLASS = 'is-revealed'
const REVEAL_MS = 1_400

/**
 * 在给定滚动容器里定位并短暂高亮目标元素。返回是否找到。
 * 只加一个短暂 class，不改变布局——遵守「整块内容不重建」的纪律。
 */
export function revealInViewport(viewport: HTMLElement | null, target: RevealTarget): boolean {
  const root: ParentNode = viewport ?? document
  const selectors: string[] = []
  if (target.blockId) selectors.push(`[data-step-id="${cssEscape(stepDomId(target.blockId))}"]`)
  if (target.entryId) selectors.push(`[data-entry-id="${cssEscape(target.entryId)}"]`)
  for (const selector of selectors) {
    const element = root.querySelector<HTMLElement>(selector)
    if (!element) continue
    element.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    element.classList.add(REVEAL_CLASS)
    window.setTimeout(() => element.classList.remove(REVEAL_CLASS), REVEAL_MS)
    return true
  }
  return false
}

/**
 * 等准备方的展开状态提交到 DOM 之后再定位：同一次广播里 ProcessTurnCard 先 setState
 * 展开目标步骤，React 在本轮事件结束时提交；两帧之后再查 DOM 才能命中新展开的节点。
 */
export function revealAfterPaint(viewport: () => HTMLElement | null, target: RevealTarget): Promise<boolean> {
  return new Promise((resolve) => {
    const attempt = (): void => resolve(revealInViewport(viewport(), target))
    if (typeof requestAnimationFrame !== 'function') {
      attempt()
      return
    }
    requestAnimationFrame(() => requestAnimationFrame(attempt))
  })
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
