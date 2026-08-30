export interface AppearancePreferences {
  cardOpacity: number
  colorMode: 'system' | 'light' | 'dark'
}

export const APPEARANCE_STORAGE_KEY = 'shiguang.appearance.v1'
export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  cardOpacity: 0.9,
  colorMode: 'system'
}

export function normalizeColorMode(value: unknown): AppearancePreferences['colorMode'] {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function normalizeCardOpacity(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_APPEARANCE_PREFERENCES.cardOpacity
  return Math.min(1, Math.max(0, Math.round(numeric * 100) / 100))
}

export function readAppearancePreferences(storage?: Pick<Storage, 'getItem'>): AppearancePreferences {
  try {
    const source = storage ?? window.localStorage
    const saved = source.getItem(APPEARANCE_STORAGE_KEY)
    if (!saved) return DEFAULT_APPEARANCE_PREFERENCES
    const parsed = JSON.parse(saved) as Partial<AppearancePreferences>
    return {
      cardOpacity: normalizeCardOpacity(parsed.cardOpacity),
      colorMode: normalizeColorMode(parsed.colorMode)
    }
  } catch {
    return DEFAULT_APPEARANCE_PREFERENCES
  }
}

export function applyAppearancePreferences(
  preferences: AppearancePreferences,
  root?: Pick<HTMLElement, 'style' | 'dataset'>
): void {
  const target = root ?? document.documentElement
  const cardOpacity = normalizeCardOpacity(preferences.cardOpacity)
  target.style.setProperty('--card-opacity', cardOpacity.toFixed(2))
  target.dataset.cardTransparency = cardOpacity === 0 ? 'clear' : cardOpacity < 0.5 ? 'light' : 'solid'
  target.dataset.colorMode = normalizeColorMode(preferences.colorMode)
}

export function persistAppearancePreferences(
  preferences: AppearancePreferences,
  storage?: Pick<Storage, 'setItem'>
): void {
  try {
    const target = storage ?? window.localStorage
    target.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({
      cardOpacity: normalizeCardOpacity(preferences.cardOpacity),
      colorMode: normalizeColorMode(preferences.colorMode)
    }))
  } catch {
    // Appearance still applies for the current process when persistent storage is unavailable.
  }
}
