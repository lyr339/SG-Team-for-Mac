// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppearanceSettings } from '../src/renderer/src/AppearanceSettings'
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearancePreferences,
  normalizeCardOpacity,
  persistAppearancePreferences,
  readAppearancePreferences
} from '../src/renderer/src/appearance-preferences'

describe('appearance preferences', () => {
  it('normalizes, persists and reapplies card opacity', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }

    expect(normalizeCardOpacity(-1)).toBe(0)
    expect(normalizeCardOpacity(1.4)).toBe(1)
    expect(normalizeCardOpacity(0.456)).toBe(0.46)

    persistAppearancePreferences({ cardOpacity: 0.46, colorMode: 'dark' }, storage)
    expect(values.has(APPEARANCE_STORAGE_KEY)).toBe(true)
    expect(readAppearancePreferences(storage)).toEqual({ cardOpacity: 0.46, colorMode: 'dark' })

    const root = document.createElement('div')
    applyAppearancePreferences({ cardOpacity: 0, colorMode: 'light' }, root)
    expect(root.style.getPropertyValue('--card-opacity')).toBe('0.00')
    expect(root.dataset.cardTransparency).toBe('clear')
    expect(root.dataset.colorMode).toBe('light')
  })
})

describe('AppearanceSettings', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('offers a true zero-opacity state and reports live slider changes', async () => {
    const onChange = vi.fn<(value: number) => void>()
    const onColorModeChange = vi.fn<(value: 'system' | 'light' | 'dark') => void>()
    await act(async () => {
      root.render(
        <AppearanceSettings
          cardOpacity={0.9}
          colorMode="system"
          onCardOpacityChange={onChange}
          onColorModeChange={onColorModeChange}
          onClose={() => {}}
        />
      )
    })

    const slider = container.querySelector<HTMLInputElement>('#card-opacity')!
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('100')
    expect(container.textContent).toContain('完全透明')

    const darkMode = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === '深色')!
    await act(async () => darkMode.click())
    expect(onColorModeChange).toHaveBeenLastCalledWith('dark')

    const zeroPreset = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === '通透')!
    await act(async () => zeroPreset.click())
    expect(onChange).toHaveBeenLastCalledWith(0)

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(slider, '37')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith(0.37)
  })
})
