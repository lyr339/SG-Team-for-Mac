import { describe, expect, it } from 'vitest'
import {
  clampManualHeight,
  COMPOSER_HEIGHT_STORAGE_KEY,
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  composerMaxHeight,
  dragManualHeight,
  readStoredComposerHeight,
  resolveComposerHeight,
  storeComposerHeight
} from '../src/renderer/src/composer-height'

describe('composer height model（内容自适应 + 可拖高）', () => {
  it('caps the textarea by viewport ratio within a floor and a ceiling', () => {
    expect(composerMaxHeight(900)).toBe(405)
    expect(composerMaxHeight(300)).toBe(160)
    expect(composerMaxHeight(4000)).toBe(560)
    expect(composerMaxHeight(Number.NaN)).toBe(160)
  })

  it('grows with content from the default minimum and stops at the cap', () => {
    expect(resolveComposerHeight({ contentHeight: 20, viewportHeight: 900 })).toBe(COMPOSER_TEXTAREA_MIN_HEIGHT)
    expect(resolveComposerHeight({ contentHeight: 140, viewportHeight: 900 })).toBe(140)
    expect(resolveComposerHeight({ contentHeight: 2_000, viewportHeight: 900 })).toBe(405)
  })

  it('treats the manual height as a floor: content still grows past it and falls back to it, not to the default', () => {
    expect(resolveComposerHeight({ contentHeight: 20, manualHeight: 220, viewportHeight: 900 })).toBe(220)
    expect(resolveComposerHeight({ contentHeight: 300, manualHeight: 220, viewportHeight: 900 })).toBe(300)
    // 手动高度也受视口上限约束（拖大后缩小窗口）
    expect(resolveComposerHeight({ contentHeight: 20, manualHeight: 520, viewportHeight: 600 })).toBe(270)
    expect(clampManualHeight(10, 900)).toBe(COMPOSER_TEXTAREA_MIN_HEIGHT)
  })

  it('maps an upward drag of the top edge to a taller composer', () => {
    // pointer 从 y=500 拖到 y=380：向上 120px → 高度 +120
    expect(dragManualHeight(120, 500, 380, 900)).toBe(240)
    expect(dragManualHeight(120, 500, 600, 900)).toBe(COMPOSER_TEXTAREA_MIN_HEIGHT)
    expect(dragManualHeight(120, 500, -2_000, 900)).toBe(405)
  })

  it('persists a manual height and ignores garbage', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) }
    }
    storeComposerHeight(233.6, storage)
    expect(store.get(COMPOSER_HEIGHT_STORAGE_KEY)).toBe('234')
    expect(readStoredComposerHeight(storage)).toBe(234)
    store.set(COMPOSER_HEIGHT_STORAGE_KEY, 'abc')
    expect(readStoredComposerHeight(storage)).toBeUndefined()
    store.set(COMPOSER_HEIGHT_STORAGE_KEY, '12')
    expect(readStoredComposerHeight(storage)).toBeUndefined()
    storeComposerHeight(undefined, storage)
    expect(store.has(COMPOSER_HEIGHT_STORAGE_KEY)).toBe(false)
  })
})
