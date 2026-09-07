import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
const foundation = readFileSync(join(process.cwd(), 'src/renderer/src/claude-theme.css'), 'utf8')
const controls = readFileSync(join(process.cwd(), 'src/renderer/src/controls.css'), 'utf8')
const lobby = readFileSync(join(process.cwd(), 'src/renderer/src/lobby/lobby.css'), 'utf8')
const run = readFileSync(join(process.cwd(), 'src/renderer/src/run/run.css'), 'utf8')

describe('theme surface contracts', () => {
  it('keeps floating connection UI opaque even when card opacity is zero', () => {
    expect(styles).toMatch(/\.connection-popover\s*\{[^}]*background:\s*var\(--color-background-primary\)/)
    expect(styles).not.toMatch(/\.connection-popover\s*\{[^}]*background:\s*var\(--surface\)/)
  })

  it('uses semantic disabled colors instead of white-on-transparent submit text', () => {
    expect(styles).toMatch(/\.composer-submit button:disabled\s*\{[^}]*color:\s*var\(--color-text-disabled\)/)
    expect(styles).toMatch(/\.composer-submit button:disabled\s*\{[^}]*background:\s*var\(--color-background-secondary\)/)
    expect(styles).toMatch(/\.composer-submit button:disabled\s*\{[^}]*border-color:\s*var\(--color-border-primary\)/)
    expect(styles).toMatch(/\.composer-submit kbd\s*\{[^}]*border:\s*1px solid var\(--color-border-primary\)/)
    expect(styles).not.toMatch(/\.composer-submit button:disabled\s*\{[^}]*rgba\(255,\s*255,\s*255/)
  })

  it('keeps an accessible queue popover that opens upward and never covers the composer', () => {
    // 绑定状态徽章已按需求移除（信息保留在会话卡遥测状态里）。
    expect(styles).not.toContain('.composer-binding-status')
    // 向上展开（bottom 锚定）、右对齐；层级不低于时长气泡（110），交互态可点击。
    expect(styles).toMatch(/\.composer-queue-popover\s*\{[^}]*z-index:\s*1[1-9]\d/)
    expect(styles).toMatch(/\.composer-queue-popover\s*\{[^}]*bottom:\s*calc\(100% \+ \d+px\)/)
    expect(styles).not.toMatch(/\.composer-queue-popover\s*\{[^}]*top:\s*calc\(100%/)
    expect(styles).toMatch(/\.composer-queue-status\.is-pinned \.composer-queue-popover[^{]*\{[^}]*pointer-events:\s*auto/)
  })

  it('uses the cool Orbit palette instead of the former yellow parchment palette', () => {
    expect(foundation).toContain('--anthropic-orange: #ff6b35')
    expect(foundation).toContain('light-dark(#edf2f7, #0b1017)')
    expect(foundation).not.toContain('#f5f4ed')
    expect(foundation).not.toContain('#faf9f5')
    expect(styles).toContain('shiguang-light.png')
    expect(styles).toContain('shiguang-dark.png')
  })

  it('keeps custom controls and run-page primary actions on the new signal-orange system', () => {
    expect(controls).toMatch(/input\[type="checkbox"\]:checked\s*\{[^}]*background-color:\s*var\(--accent\)/)
    expect(controls).toMatch(/select:not\(\[multiple\]\):focus\s*\{[^}]*var\(--accent-border-strong\)/)
    // 运行页只用共享的 .primary-button（信号橙）；破坏性确认走红色，且不是主按钮样式。
    expect(styles).toMatch(/\.primary-button\s*\{[^}]*background:\s*var\(--accent\)/)
    expect(run).toMatch(/\.run-sheet__confirm\s*\{[^}]*background:\s*var\(--red\)/)
    expect(run).toMatch(/\.run-header__ghost\.is-danger\s*\{[^}]*color:\s*var\(--red\)/)
    expect(run).not.toContain('.lobby-command__primary')
  })

  it('defines distinct model-provider identities without reusing status colors', () => {
    for (const provider of ['anthropic', 'openai', 'google', 'xai', 'moonshot', 'zhipu', 'cursor']) {
      expect(styles).toContain(`--provider-${provider}-fg`)
      expect(styles).toContain(`.provider-${provider}`)
    }
    // 会话名册：厂商色只落在模型名前的 7px 色块上，文字保持中性，不给整行染色。
    expect(styles).toMatch(/\.session-row__model > i\s*\{[^}]*var\(--model-provider-fg/)
    expect(styles).not.toMatch(/\.session-row__model\s*\{[^}]*var\(--model-provider-fg/)
    expect(styles).toMatch(/\.composer-model > b\s*\{[^}]*var\(--model-provider-fg/)
  })

  it('keeps the session roster on the inspector language: one frame, hairlines, accent only for selection', () => {
    // 行不再自带边框 / 阴影；选中态 = 左缘 2px 信号橙 + 底色；状态色只在 --rail-state 驱动的状态点上。
    expect(styles).toMatch(/\.session-row\s*\{[^}]*background:\s*transparent;\s*border:\s*0;/s)
    expect(styles).toMatch(/\.session-row::before\s*\{[^}]*width:\s*2px;[^}]*background:\s*var\(--accent\)/s)
    expect(styles).toMatch(/\.session-row\.is-waiting\s*\{\s*--rail-state:\s*var\(--color-text-success\)/)
    expect(styles).toMatch(/\.session-row\.is-active\s*\{\s*--rail-state:\s*var\(--color-text-info\)/)
    expect(styles).toMatch(/\.session-row\.is-attention\s*\{\s*--rail-state:\s*var\(--color-text-warning\)/)
    expect(styles).toMatch(/\.session-list__slot \+ \.session-list__slot\s*\{[^}]*border-top:\s*1px solid var\(--color-border-tertiary\)/)
    // 名册正文有阅读面下限（透明卡片模式下仍可读）；吸顶分组标题实底，滚过的行不会透出来。
    expect(styles).toMatch(/\.session-pane\s*\{[^}]*--rail-reading-opacity:\s*max\(0\.92, var\(--card-opacity\)\)/s)
    expect(styles).toMatch(/\.session-list\s*\{[^}]*var\(--rail-reading-opacity\)/s)
    expect(styles).toMatch(/\.session-group__header\s*\{[^}]*position:\s*sticky[^}]*background:\s*var\(--surface-solid\)/s)
    // 上下文光环：三档天色；reduced-motion 下脉冲与弧长过渡都关闭。
    expect(styles).toMatch(/\.session-row__ring\.is-dusk \.session-row__ring-arc\s*\{\s*stroke:\s*var\(--sky-dusk\)/)
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.session-row\.is-active \.session-row__state > i\s*\{\s*animation:\s*none/)
    expect(styles).not.toContain('.rail-session-card')
    expect(styles).not.toContain('.session-filters')
  })

  it('keeps native window controls outside content while centering navigation on macOS and Windows', () => {
    expect(styles).toContain('html[data-platform="darwin"] { --window-control-safe-left: 84px; }')
    expect(styles).toContain('html[data-platform="win32"] { --window-control-safe-right: 138px; }')
    expect(styles).toMatch(/\.topbar\s*\{[^}]*margin:\s*0;[^}]*padding:\s*0 calc\(var\(--window-control-safe-right\) \+ var\(--topbar-gutter\)\)/s)
    expect(styles).toMatch(/\.topbar-nav\s*\{[^}]*translateX\(calc\(\(var\(--window-control-safe-right\) - var\(--window-control-safe-left\)\) \/ 2\)\)/s)
    expect(styles).not.toMatch(/\.topbar__actions\s*\{[^}]*margin-right:\s*var\(--window-control-safe-right\)/)
    expect(styles).not.toContain('margin: 0 calc(var(--window-control-safe-right) / 2)')
  })

  it('uses segmented run-page step connectors and honours reduced motion', () => {
    // 四步流程：连接线从节点右侧起、到下一节点前止，最后一步没有连接线。
    expect(run).toMatch(/\.run-steps li::before\s*\{[^}]*left:\s*calc\(50% \+ 14px\)/s)
    expect(run).toContain('.run-steps li:last-child::before { display: none; }')
    // 模式分段控件：指示块用 transform 位移，reduced-motion 下不做过渡。
    expect(run).toMatch(/\.run-mode-switch__indicator\s*\{[^}]*transition:\s*transform/s)
    expect(run).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.run-mode-switch__indicator[^{]*\{\s*transition:\s*none/)
    // 可折叠插槽（确认面 / 提示条）靠 grid-template-rows 过渡展开，reduced-motion 下同样直接落位。
    expect(run).toMatch(/\.run-slot\s*\{[^}]*transition:\s*grid-template-rows/s)
    expect(run).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.run-slot[^{]*\{\s*transition:\s*none/)
    expect(run).not.toContain('box-shadow: inset 3px 0 0 var(--accent)')
    expect(lobby).toContain('.account-browser__connection-row')
  })

  it('keeps tool identity colors theme-aware and the todo list on the Cursor-native monochrome design', () => {
    // 工具身份色板：明暗双值（light-dark）成对出现，卡体不染色
    for (const kind of ['read', 'search', 'edit', 'write', 'command', 'browser', 'mcp', 'todo']) {
      expect(styles).toMatch(new RegExp(`\\.cursor-native-tool\\.is-${kind}, \\.process-turn-step\\.is-${kind} \\{[^}]*--tool-hue:\\s*light-dark\\(`))
    }
    // Cursor 原生 todo：实心圆反色 spinner + 透明度阶梯（单色纪律）
    expect(styles).toMatch(/\.todo-spinner\s*\{[^}]*background:\s*var\(--text\)[^}]*border-radius:\s*50%/)
    expect(styles).toContain('@keyframes todo-spin')
    expect(styles).toMatch(/\.process-turn-step__todos li\.is-completed\s*\{[^}]*opacity:\s*\.5[^}]*line-through/)
    expect(styles).toMatch(/\.process-turn-step__todos li\.is-pending\s*\{[^}]*opacity:\s*\.4/)
    // reduced-motion 必须豁免 todo 的 spinner 与淡入动画
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.todo-spinner svg,\s*\n\s*\.process-turn-step__todos li\s*\{[^}]*animation:\s*none/)
  })
})
