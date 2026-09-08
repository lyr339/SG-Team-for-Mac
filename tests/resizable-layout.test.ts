import { describe, expect, it } from 'vitest'
import {
  defaultPaneSizes,
  fitPaneSizes,
  resizePane,
  type ResizablePaneSpec
} from '../src/renderer/src/resizable-layout'

const shellSpecs: readonly ResizablePaneSpec[] = [
  { defaultSize: 326, minSize: 270, maxSize: 560 }
]

describe('resizable layout', () => {
  it('uses bounded defaults', () => {
    expect(defaultPaneSizes([
      { defaultSize: 100, minSize: 220, maxSize: 500 },
      { defaultSize: 900, minSize: 390, maxSize: 820 }
    ])).toEqual([220, 820])
  })

  it('preserves the final flexible pane while dragging', () => {
    expect(resizePane(shellSpecs.map((spec) => spec.defaultSize), shellSpecs, 0, 900, 1_000, 420))
      .toEqual([560])
    expect(resizePane([326], shellSpecs, 0, 100, 1_000, 420))
      .toEqual([270])
  })

  it('shrinks fixed panes to fit a narrower window', () => {
    const setupSpecs = [
      { defaultSize: 260, minSize: 210, maxSize: 420 },
      { defaultSize: 520, minSize: 390, maxSize: 820 }
    ] as const

    expect(fitPaneSizes([260, 520], setupSpecs, 1_000, 290)).toEqual([260, 430])
  })

  it('keeps pane minimums when the window is too narrow and lets the view scroll', () => {
    const setupSpecs = [
      { defaultSize: 260, minSize: 210, maxSize: 420 },
      { defaultSize: 520, minSize: 390, maxSize: 820 }
    ] as const

    expect(fitPaneSizes([260, 520], setupSpecs, 600, 290)).toEqual([210, 390])
  })
})

describe('desktop session width budget', () => {
  it('preserves the conversation floor with both sidebars at every permitted desktop width', async () => {
    const { SESSION_CONTENT_MIN_WIDTH: min, SESSION_SIDEBAR_SPEC: left, SESSION_INSPECTOR_SPEC: right, WINDOW_MIN_WIDTH } = await import('../src/shared/window-layout')
    // 最小窗口仍有实际拖拽空间；左右两栏都能从最小宽度向外调整。
    expect(resizePane([left.minSize], [left], 0, 9999, WINDOW_MIN_WIDTH - 28, min + right.minSize + 10)[0]).toBeGreaterThan(left.minSize + 80)
    expect(resizePane([right.minSize], [right], 0, 9999, WINDOW_MIN_WIDTH - 28 - left.defaultSize - 10, min)[0]).toBeGreaterThan(right.minSize + 60)
    for (const width of [WINDOW_MIN_WIDTH, 1600, 1920]) {
      const available = width - 28
      const leftSize = resizePane([left.defaultSize], [left], 0, 9999, available, min + right.minSize + 10)[0]!
      const dockWidth = available - leftSize - 10
      const rightSize = resizePane([right.defaultSize], [right], 0, 9999, dockWidth, min)[0]!
      expect(dockWidth - rightSize - 10).toBeGreaterThanOrEqual(min)
      expect(leftSize).toBeGreaterThanOrEqual(left.minSize)
      expect(rightSize).toBeGreaterThanOrEqual(right.minSize)
    }
  })
})
