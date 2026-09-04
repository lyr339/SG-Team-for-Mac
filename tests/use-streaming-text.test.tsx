// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStreamingText } from '../src/renderer/src/use-streaming-text'

interface HarnessProps {
  id: string
  text: string
  done: boolean
  firstFrameDoneFull?: boolean
  immediate?: boolean
}

function Harness({ id, text, done, firstFrameDoneFull, immediate }: HarnessProps): React.JSX.Element {
  const visible = useStreamingText(
    { id, text, done },
    { firstFrameDoneFull, immediate }
  )
  return <p data-testid="visible">{visible}</p>
}

describe('useStreamingText（阶段 G：共享打字机播放器）', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    // jsdom 原生没有 matchMedia；直接赋值的 mock 不受 restoreAllMocks 管辖，
    // 手动清除避免污染后续测试（reduced-motion 泄漏会让播放测试全数秒过）。
    delete (window as { matchMedia?: unknown }).matchMedia
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const render = (props: HarnessProps): void => {
    act(() => root.render(<Harness {...props} />))
  }
  const visibleText = (): string => container.querySelector('p')?.textContent ?? ''

  it('plays appended text with monotonically growing visible characters (§8.5-2)', () => {
    render({ id: 's1', text: '第一段落', done: false })
    expect(visibleText()).toBe('')
    // 播放推进：可见文本单调增长且永不超前目标。
    const seen: string[] = []
    for (let round = 0; round < 30; round += 1) {
      act(() => { vi.advanceTimersByTime(48) })
      const current = visibleText()
      if (current.length > 0) expect('第一段落'.startsWith(current)).toBe(true)
      seen.push(current)
      if (current === '第一段落') break
    }
    expect(visibleText()).toBe('第一段落')
    const nonEmpty = seen.filter(Boolean)
    for (let index = 1; index < nonEmpty.length; index += 1) {
      expect(nonEmpty[index]!.length).toBeGreaterThanOrEqual(nonEmpty[index - 1]!.length)
    }
  })

  it('keeps the visible buffer across growth updates within the same source id', () => {
    render({ id: 's1', text: 'abc', done: false })
    act(() => { vi.advanceTimersByTime(64) })
    const midway = visibleText()
    expect(midway.length).toBeGreaterThan(0)
    // 目标增长：缓冲保留，继续追赶而非重播。
    render({ id: 's1', text: 'abcdefgh', done: false })
    act(() => { vi.advanceTimersByTime(400) })
    expect(visibleText()).toBe('abcdefgh')
  })

  it('continues playing the remaining tail when done arrives mid-play (§8.5-3)', () => {
    render({ id: 's1', text: 'abcdefghijklmnop', done: false })
    act(() => { vi.advanceTimersByTime(48) })
    const midway = visibleText()
    expect(midway.length).toBeGreaterThan(0)
    expect(midway.length).toBeLessThan('abcdefghijklmnop'.length)

    // complete 到达：不瞬间跳全文，尾部继续追赶。
    render({ id: 's1', text: 'abcdefghijklmnop', done: true })
    const rightAfterDone = visibleText()
    expect(rightAfterDone.length).toBeLessThan('abcdefghijklmnop'.length)
    act(() => { vi.advanceTimersByTime(600) })
    expect(visibleText()).toBe('abcdefghijklmnop')
  })

  it('plays live-context blocks that arrive already done (RC-9)', () => {
    // 直播上下文（firstFrameDoneFull=false）：帧间隙完成的思考块照常播放。
    render({ id: 'thought-1', text: '整段思考内容', done: true, firstFrameDoneFull: false })
    expect(visibleText()).toBe('')
    act(() => { vi.advanceTimersByTime(600) })
    expect(visibleText()).toBe('整段思考内容')
  })

  it('shows the full text on first frame for history hydration (§8.5-4)', () => {
    // 历史水合（LiveAgentResponse 冷启动 completed / immediate 历史卡）。
    render({ id: 'r1', text: '已完成的完整回复', done: true, firstFrameDoneFull: true })
    expect(visibleText()).toBe('已完成的完整回复')

    render({ id: 'r2', text: '封口卡正文', done: true, immediate: true })
    expect(visibleText()).toBe('封口卡正文')
  })

  it('resets playback when the source id changes', () => {
    render({ id: 's1', text: '第一回合正文', done: false })
    act(() => { vi.advanceTimersByTime(400) })
    expect(visibleText()).toBe('第一回合正文')

    render({ id: 's2', text: '第二回合正文', done: false })
    expect(visibleText()).toBe('')
    act(() => { vi.advanceTimersByTime(600) })
    expect(visibleText()).toBe('第二回合正文')
  })

  it('reveals bursty chunks at a steady rate without stalling between arrivals (匀速打字机)', () => {
    // 上游形态：每 200ms 到达一段 5 字（25 字/秒），大小抖动；旧实现会在每段
    // 到达后 130ms 内排空再停住等下一段（走-停-走-停）。
    let text = ''
    render({ id: 'steady', text, done: false })
    const buckets: number[] = []
    let lastLength = 0
    for (let elapsed = 0; elapsed < 3_000; elapsed += 100) {
      if (elapsed % 200 === 0) {
        text += '一二三四五六七'.slice(0, 4 + (elapsed / 200) % 3)
        render({ id: 'steady', text, done: false })
      }
      act(() => { vi.advanceTimersByTime(100) })
      const length = visibleText().length
      expect(text.startsWith(visibleText())).toBe(true)
      buckets.push(length - lastLength)
      lastLength = length
    }
    // 预热（缓冲建立）之后：每个 100ms 窗口都有字符流出（无停顿），且窗口间增量
    // 差异有界——没有「一帧 6 字、下一帧 0 字」的脉冲。
    const steady = buckets.slice(6, 28)
    expect(steady.every((count) => count >= 1)).toBe(true)
    expect(Math.max(...steady) - Math.min(...steady)).toBeLessThanOrEqual(3)
    // 播放落后上游一个延迟预算，但不会无界拉大。
    expect(text.length - lastLength).toBeLessThanOrEqual(12)
  })

  it('never reveals faster than the speed cap and keeps only a bounded tail for giant frames', () => {
    // 一次性巨帧（重连水合 / 整段 done thinking 2000 字）：超出 maxRate×maxLag 的部分
    // 直接显示，剩余尾巴以上限速率匀速播完——既不整段闪现，也不拖 5 秒。
    const big = '字'.repeat(2_000)
    render({ id: 'giant', text: big, done: true, firstFrameDoneFull: false })
    expect(visibleText()).toBe('')
    act(() => { vi.advanceTimersByTime(20) })
    const afterFirstFrame = visibleText().length
    expect(afterFirstFrame).toBeGreaterThanOrEqual(2_000 - 480 * 1.5)
    expect(afterFirstFrame).toBeLessThan(2_000)
    act(() => { vi.advanceTimersByTime(100) })
    // 100ms 内最多 480 × 0.1 ≈ 48 字（含帧量化余量）。
    expect(visibleText().length - afterFirstFrame).toBeLessThanOrEqual(60)
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(visibleText()).toBe(big)
  })

  it('keeps playing after the live flag flips off and never splits grapheme clusters', () => {
    const family = '👨‍👩‍👧'
    const text = `${family}a${family}b`
    const clusters = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text))
      .map((segment) => segment.segment)
    const prefixes = new Set(clusters.map((_, index) => clusters.slice(0, index + 1).join('')))
    prefixes.add('')
    render({ id: 'emoji', text, done: false })
    for (let round = 0; round < 20; round += 1) {
      act(() => { vi.advanceTimersByTime(48) })
      expect(prefixes.has(visibleText())).toBe(true)
      if (visibleText() === text) break
    }
    expect(visibleText()).toBe(text)
  })

  it('snaps to the full text on regression or reduced motion', () => {
    // 文本回退（同 id 整体替换）：对齐新全文。
    render({ id: 's1', text: '原始内容', done: false })
    act(() => { vi.advanceTimersByTime(400) })
    expect(visibleText()).toBe('原始内容')
    render({ id: 's1', text: '完全不同的替换内容', done: false })
    expect(visibleText()).toBe('完全不同的替换内容')

    // prefers-reduced-motion：直接完整显示。
    ;(window as { matchMedia?: unknown }).matchMedia = vi.fn().mockReturnValue({ matches: true })
    render({ id: 's3', text: '无动画环境', done: false })
    expect(visibleText()).toBe('无动画环境')
  })
})
