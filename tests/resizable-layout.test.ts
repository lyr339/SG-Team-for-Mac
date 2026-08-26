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
