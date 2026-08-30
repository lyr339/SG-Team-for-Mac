import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
const foundation = readFileSync(join(process.cwd(), 'src/renderer/src/claude-theme.css'), 'utf8')
const controls = readFileSync(join(process.cwd(), 'src/renderer/src/controls.css'), 'utf8')
const lobby = readFileSync(join(process.cwd(), 'src/renderer/src/lobby/lobby.css'), 'utf8')

describe('theme surface contracts', () => {
  it('keeps floating connection UI opaque even when card opacity is zero', () => {
    expect(styles).toMatch(/\.connection-popover\s*\{[^}]*background:\s*var\(--color-background-primary\)/)
    expect(styles).not.toMatch(/\.connection-popover\s*\{[^}]*background:\s*var\(--surface\)/)
  })

  it('uses semantic disabled colors instead of white-on-transparent submit text', () => {
    expect(styles).toMatch(/\.composer-submit button:disabled\s*\{[^}]*color:\s*var\(--color-text-disabled\)/)
    expect(styles).toMatch(/\.composer-submit button:disabled\s*\{[^}]*background:\s*var\(--color-background-secondary\)/)
    expect(styles).not.toMatch(/\.composer-submit button:disabled\s*\{[^}]*rgba\(255,\s*255,\s*255/)
  })

  it('uses the cool Orbit palette instead of the former yellow parchment palette', () => {
    expect(foundation).toContain('--anthropic-orange: #ff6b35')
    expect(foundation).toContain('light-dark(#edf2f7, #0b1017)')
    expect(foundation).not.toContain('#f5f4ed')
    expect(foundation).not.toContain('#faf9f5')
    expect(styles).toContain('shiguang-light.png')
    expect(styles).toContain('shiguang-dark.png')
  })

  it('keeps custom controls and lobby primary actions on the new signal-orange system', () => {
    expect(controls).toMatch(/input\[type="checkbox"\]:checked\s*\{[^}]*background-color:\s*var\(--accent\)/)
    expect(controls).toMatch(/select:not\(\[multiple\]\):focus\s*\{[^}]*var\(--accent-border-strong\)/)
    expect(lobby).toMatch(/\.lobby-command__primary\s*\{[^}]*background:\s*var\(--accent\)/)
    expect(lobby).toMatch(/\.lobby-launch__button\s*\{[^}]*--lobby-launch-button-bg:\s*var\(--accent\)/)
  })

  it('defines distinct model-provider identities without reusing status colors', () => {
    for (const provider of ['anthropic', 'openai', 'google', 'xai', 'moonshot', 'zhipu', 'cursor']) {
      expect(styles).toContain(`--provider-${provider}-fg`)
      expect(styles).toContain(`.provider-${provider}`)
    }
    expect(styles).toMatch(/\.rail-session-card__model > b\s*\{[^}]*var\(--model-provider-fg/)
    expect(styles).toMatch(/\.composer-model > b\s*\{[^}]*var\(--model-provider-fg/)
  })

  it('keeps native window controls outside content while centering navigation on macOS and Windows', () => {
    expect(styles).toContain('html[data-platform="darwin"] { --window-control-safe-left: 84px; }')
    expect(styles).toContain('html[data-platform="win32"] { --window-control-safe-right: 138px; }')
    expect(styles).toMatch(/\.topbar\s*\{[^}]*margin:\s*0;[^}]*padding:\s*0 calc\(var\(--window-control-safe-right\) \+ var\(--topbar-gutter\)\)/s)
    expect(styles).toMatch(/\.topbar-nav\s*\{[^}]*translateX\(calc\(\(var\(--window-control-safe-right\) - var\(--window-control-safe-left\)\) \/ 2\)\)/s)
    expect(styles).not.toMatch(/\.topbar__actions\s*\{[^}]*margin-right:\s*var\(--window-control-safe-right\)/)
    expect(styles).not.toContain('margin: 0 calc(var(--window-control-safe-right) / 2)')
  })
})
