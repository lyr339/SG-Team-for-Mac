#!/usr/bin/env node
/**
 * 设计走查截图：用本机 Chromium 内核浏览器（Edge / Chrome）无头打开 `npm run preview:ui`
 * 的预览页，按场景矩阵（右栏面板 / 运行页 × 深浅色 × 窄窗 × 透明模式 × reduced-motion × 交互）
 * 截图到 preview-screenshots/。只依赖 CDP 与 ws，不引入 Playwright。
 *
 *   npm run preview:ui                      # 另一个终端，端口 5174
 *   node scripts/preview-shots.mjs          # 全部场景
 *   node scripts/preview-shots.mjs --only review-light,plan-dark
 *   node scripts/preview-shots.mjs --only run-team-active-light,run-independent-mixed-dark
 *   node scripts/preview-shots.mjs --list
 *
 * 可选环境变量：PREVIEW_BASE（默认 http://127.0.0.1:5174）、PREVIEW_BROWSER（浏览器可执行文件）、
 * PREVIEW_OUT（输出目录）、PREVIEW_CDP_PORT（默认 9555；9333 是 Cursor 自己的调试端口，勿用）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const BASE = (process.env.PREVIEW_BASE || 'http://127.0.0.1:5174').replace(/\/+$/, '')
const OUT = resolve(process.env.PREVIEW_OUT || 'preview-screenshots')
const CDP_PORT = Number(process.env.PREVIEW_CDP_PORT || 9555)
const ONLY = flag('--only')?.split(',').map((value) => value.trim()).filter(Boolean)

const INSPECTOR_OPEN_KEY = 'sg-team.layout:v1:workspace-inspector:open'
const INSPECTOR_TAB_KEY = 'sg-team.inspector:active-tab'
const INSPECTOR_WIDTH_KEY = 'sg-team.layout:v1:shell.workspace-inspector'
const REVIEW_SCOPE_KEY = 'sg-team.inspector:review-scope'
const APPEARANCE_KEY = 'shiguang.appearance.v1'

/** 基础存储：右栏展开、CH-2 会话、默认宽度。 */
function baseStorage({ tab = 'review', width = 420, cardOpacity = 0.9, colorMode = 'light', scope = 'uncommitted' } = {}) {
  return {
    [INSPECTOR_OPEN_KEY]: '1',
    [INSPECTOR_TAB_KEY]: tab,
    [INSPECTOR_WIDTH_KEY]: JSON.stringify([width]),
    [REVIEW_SCOPE_KEY]: scope,
    [APPEARANCE_KEY]: JSON.stringify({ cardOpacity, colorMode }),
    'shiguang.lastSessionChannel.v1': '2'
  }
}

const TABS = ['review', 'plan', 'activity', 'artifacts']
const scenes = [
  ...TABS.flatMap((tab) => [
    { name: `${tab}-light`, width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ tab }) },
    { name: `${tab}-dark`, width: 1440, height: 900, colorScheme: 'dark', storage: baseStorage({ tab, colorMode: 'dark' }) }
  ]),
  // 窄栏：窗口 1180 宽、右栏收到下限 300，标签应收成纯图标。
  { name: 'review-narrow', width: 1180, height: 760, colorScheme: 'light', storage: baseStorage({ width: 300 }) },
  { name: 'activity-narrow', width: 1180, height: 760, colorScheme: 'light', storage: baseStorage({ tab: 'activity', width: 300 }) },
  // 透明模式：卡片透明度 0（clear）——正文区必须保持阅读面。
  { name: 'review-clear', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ cardOpacity: 0 }) },
  { name: 'review-clear-dark', width: 1440, height: 900, colorScheme: 'dark', storage: baseStorage({ cardOpacity: 0, colorMode: 'dark' }) },
  // reduced-motion：不该有半程动画的中间态。
  { name: 'review-reduced-motion', width: 1440, height: 900, colorScheme: 'light', reducedMotion: true, storage: baseStorage() },
  // 悬停第一条文件行：动作簇出现。
  { name: 'review-hover-row', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage(), actions: [{ hover: '.review-file__row' }] },
  // 撤销确认浮层。
  { name: 'review-revert-confirm', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage(), actions: [{ hover: '.review-file__row' }, { click: '.review-file__actions button.is-danger' }, { wait: 250 }] },
  // 分支范围 + 展开全部。
  { name: 'review-branch-expanded', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ scope: 'branch' }), actions: [{ click: '.inspector-review__count > button' }, { wait: 400 }] },
  // 活动页悬停一行：定位 / 复制动作。
  { name: 'activity-hover-row', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ tab: 'activity' }), actions: [{ hover: '.activity-command .activity-row' }] },
  // 产物卡悬停：右上角浮层动作。
  { name: 'artifacts-hover-card', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage({ tab: 'artifacts' }), actions: [{ hover: '.artifact-card' }] },
  // 空态：CH-1 没有过程块 / Todo / 图片。
  { name: 'plan-empty', width: 1440, height: 900, colorScheme: 'light', channel: '1', storage: { ...baseStorage({ tab: 'plan' }), 'shiguang.lastSessionChannel.v1': '1' } },
  { name: 'activity-empty', width: 1440, height: 900, colorScheme: 'light', channel: '1', storage: { ...baseStorage({ tab: 'activity' }), 'shiguang.lastSessionChannel.v1': '1' } },
  { name: 'artifacts-empty-dark', width: 1440, height: 900, colorScheme: 'dark', channel: '1', storage: { ...baseStorage({ tab: 'artifacts', colorMode: 'dark' }), 'shiguang.lastSessionChannel.v1': '1' } },
  // 变更面板的其它状态（预览参数 ?review=…）。
  { name: 'review-clean', width: 1440, height: 900, colorScheme: 'light', query: 'review=clean', storage: baseStorage() },
  { name: 'review-not-git', width: 1440, height: 900, colorScheme: 'light', query: 'review=not_git', storage: baseStorage() },
  { name: 'review-error-dark', width: 1440, height: 900, colorScheme: 'dark', query: 'review=error', storage: baseStorage({ colorMode: 'dark' }) },
  { name: 'review-many', width: 1440, height: 900, colorScheme: 'light', query: 'review=many', storage: baseStorage() },
  { name: 'review-many-narrow-dark', width: 1180, height: 760, colorScheme: 'dark', query: 'review=many', storage: baseStorage({ width: 300, colorMode: 'dark' }) },
  // 右栏关闭态（对照）与开合中途帧（验证轨道过渡在插值而不是跳变）。
  { name: 'inspector-closed', width: 1440, height: 900, colorScheme: 'light', storage: { ...baseStorage(), [INSPECTOR_OPEN_KEY]: '0' } },
  {
    name: 'inspector-opening', width: 1440, height: 900, colorScheme: 'light', storage: { ...baseStorage(), [INSPECTOR_OPEN_KEY]: '0' }, clip: null,
    actions: [{
      label: 'grid-template-columns 采样（页面内计时，0/60/120/180/320ms）',
      probe: `new Promise((done) => {
        const dock = document.querySelector('.workspace-dock')
        const read = () => getComputedStyle(dock).gridTemplateColumns
        const samples = []
        document.querySelector('[aria-label="展开右侧工作区"]').click()
        for (const at of [0, 60, 120, 180, 320]) setTimeout(() => { samples.push(at + 'ms ' + read()); if (at === 320) done(samples) }, at)
      })`
    }, { wait: 60 }]
  },
  { name: 'inspector-opened', width: 1440, height: 900, colorScheme: 'light', storage: { ...baseStorage(), [INSPECTOR_OPEN_KEY]: '0' }, clip: null, actions: [{ click: '[aria-label="展开右侧工作区"]' }, { wait: 400 }] },

  // ---------- 运行页（#run）：一个工程一个活跃运行，团队 / 独立两种模式 ----------
  ...[['light', 'light'], ['dark', 'dark']].flatMap(([suffix, colorMode]) => [
    // 无活跃运行：开始一次运行（模式选择）。
    { name: `run-start-${suffix}`, run: true, query: 'setup=1', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    { name: `run-start-independent-${suffix}`, run: true, query: 'setup=1', colorScheme: colorMode, storage: baseStorage({ colorMode }), actions: [{ click: '.run-mode-switch button[aria-checked="false"]' }, { wait: 300 }] },
    // 团队：启动前（目标已填、MCP 待接入）/ 协作执行中 / 已结束。
    { name: `run-team-prelaunch-${suffix}`, run: true, query: 'runStatus=ready', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    { name: `run-team-active-${suffix}`, run: true, colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    { name: `run-team-completed-${suffix}`, run: true, query: 'runStatus=completed', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    // 独立：全部待命 / 混合形态（待命 + 执行中 + 离线 + 待确认）/ 已结束。
    { name: `run-independent-live-${suffix}`, run: true, query: 'independent=live', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    { name: `run-independent-mixed-${suffix}`, run: true, query: 'independent=mixed', colorScheme: colorMode, storage: baseStorage({ colorMode }) },
    { name: `run-independent-ended-${suffix}`, run: true, query: 'independent=ended', colorScheme: colorMode, storage: baseStorage({ colorMode }) }
  ]),
  // 切换模式的确认面（团队 → 独立，仍有在线席位）。
  { name: 'run-switch-sheet', run: true, colorScheme: 'light', storage: baseStorage(), actions: [{ click: '.run-mode-switch button[aria-checked="false"]' }, { wait: 300 }] },
  // 确认后进入独立批次配置（头部标注"正在配置"）。
  { name: 'run-compose-after-switch', run: true, colorScheme: 'light', storage: baseStorage(), actions: [{ click: '.run-mode-switch button[aria-checked="false"]' }, { wait: 300 }, { click: '.run-sheet__confirm' }, { wait: 400 }] },
  // 结束批次确认面 + 目标编辑器。
  { name: 'run-end-sheet-dark', run: true, query: 'independent=live', colorScheme: 'dark', storage: baseStorage({ colorMode: 'dark' }), actions: [{ click: '.run-header__ghost.is-danger' }, { wait: 300 }] },
  { name: 'run-goal-editing', run: true, query: 'runStatus=ready', colorScheme: 'light', storage: baseStorage(), actions: [{ click: '.run-panel--team .run-link' }, { wait: 300 }] },
  // 宽度阶梯：容器查询断点 1120 / 920 / 680 两侧各取一档，头部与席位行的重排必须在每一档都成立。
  ...[1180, 1000, 860, 720, 600].flatMap((width) => [
    { name: `run-team-active-w${width}`, run: true, width, height: 820, colorScheme: 'light', storage: baseStorage(), clip: null },
    { name: `run-independent-mixed-w${width}`, run: true, width, height: 820, query: 'independent=mixed', colorScheme: 'dark', storage: baseStorage({ colorMode: 'dark' }), clip: null }
  ]),
  { name: 'run-start-independent-w600', run: true, width: 600, height: 900, query: 'setup=1', colorScheme: 'light', storage: baseStorage(), clip: null, actions: [{ click: '.run-mode-switch button[aria-checked="false"]' }, { wait: 300 }] },
  { name: 'run-compose-w720', run: true, width: 720, height: 900, colorScheme: 'light', storage: baseStorage(), clip: null, actions: [{ click: '.run-mode-switch button[aria-checked="false"]' }, { wait: 300 }, { click: '.run-sheet__confirm' }, { wait: 400 }] },
  // 头部控件位置守恒：切换模式 → 确认 → 进入配置态，分段控件、两个动作按钮和头部高度必须一个像素都不动。
  {
    name: 'run-header-stability', run: true, colorScheme: 'light', storage: baseStorage(), clip: '.run-header',
    actions: [{
      label: '头部控件包围盒（切换前 → 配置态）',
      probe: `new Promise((done) => {
        const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',') }
        const snapshot = () => ({ header: box('.run-header'), switch: box('.run-mode-switch'), open: box('.run-header__ghost'), end: box('.run-header__ghost.is-danger') })
        const before = snapshot()
        document.querySelector('.run-mode-switch button[aria-checked="false"]').click()
        setTimeout(() => {
          document.querySelector('.run-sheet__confirm').click()
          setTimeout(() => {
            const after = snapshot()
            const stable = Object.keys(before).every((key) => before[key] === after[key])
            done({ stable, before, after })
          }, 500)
        }, 350)
      })`
    }, { wait: 100 }]
  },
  // 确认面的展开是高度过渡：中途帧应看到插槽行高在插值，而不是 0 → 满高跳变。
  {
    name: 'run-sheet-opening', run: true, colorScheme: 'light', storage: baseStorage(), clip: null,
    actions: [{
      label: 'run-slot grid-template-rows 采样（0/60/120/200/320ms）',
      probe: `new Promise((done) => {
        const samples = []
        document.querySelector('.run-mode-switch button[aria-checked="false"]').click()
        const slot = () => document.querySelector('.run-slot')
        for (const at of [0, 60, 120, 200, 320]) setTimeout(() => { samples.push(at + 'ms ' + getComputedStyle(slot()).gridTemplateRows); if (at === 320) done(samples) }, at)
      })`
    }, { wait: 40 }]
  },
  { name: 'run-team-active-clear', run: true, colorScheme: 'light', storage: baseStorage({ cardOpacity: 0 }) },
  // 右上角设置入口：账号与 Cursor。
  { name: 'account-page', hash: 'account', width: 1440, height: 900, colorScheme: 'light', storage: baseStorage(), clip: null }
]

for (const scene of scenes) {
  if (scene.run) {
    scene.hash = 'run'
    scene.width ??= 1440
    scene.height ??= 900
    scene.clip ??= '.run-page__inner'
  }
  if (scene.clip === undefined && scene.name !== 'inspector-closed' && !scene.hash) scene.clip = '.workspace-inspector'
  if (scene.clip === null) delete scene.clip
}

if (args.includes('--list')) {
  for (const scene of scenes) console.log(scene.name)
  process.exit(0)
}

function resolveBrowser() {
  if (process.env.PREVIEW_BROWSER) return process.env.PREVIEW_BROWSER
  const candidates = process.platform === 'win32'
    ? [
        `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
  const found = candidates.find((candidate) => candidate && existsSync(candidate))
  if (!found) throw new Error('未找到 Chrome / Edge；用 PREVIEW_BROWSER 指定可执行文件')
  return found
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitForEndpoint(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return (await response.json()).webSocketDebuggerUrl
    } catch { /* 浏览器尚未监听 */ }
    await sleep(120)
  }
  throw new Error('浏览器调试端口未就绪')
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ''}`))
        else done(message.result)
        return
      }
      if (message.method) for (const listener of this.listeners) listener(message)
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) }
    return new Promise((done, reject) => {
      this.pending.set(id, { resolve: done, reject })
      this.socket.send(JSON.stringify(payload))
    })
  }

  once(method, sessionId, timeoutMs = 15_000) {
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener)
        reject(new Error(`等待 ${method} 超时`))
      }, timeoutMs)
      const listener = (message) => {
        if (message.method !== method || (sessionId && message.sessionId !== sessionId)) return
        clearTimeout(timer)
        this.listeners.delete(listener)
        done(message.params)
      }
      this.listeners.add(listener)
    })
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate 失败')
  return result.result?.value
}

async function navigate(cdp, sessionId, url) {
  const loaded = cdp.once('Page.loadEventFired', sessionId)
  await cdp.send('Page.navigate', { url }, sessionId)
  await loaded
}

async function elementCenter(cdp, sessionId, selector) {
  const rect = await evaluate(cdp, sessionId, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return null
    element.scrollIntoView({ block: 'nearest' })
    const box = element.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 18) }
  })()`)
  if (!rect) throw new Error(`未找到元素：${selector}`)
  return rect
}

async function runActions(cdp, sessionId, actions = []) {
  for (const action of actions) {
    if (action.wait) await sleep(action.wait)
    if (action.hover) {
      const { x, y } = await elementCenter(cdp, sessionId, action.hover)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
      await sleep(220)
    }
    if (action.click || action.clickNoWait) {
      const { x, y } = await elementCenter(cdp, sessionId, action.click ?? action.clickNoWait)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId)
      if (action.click) await sleep(260)
    }
    if (action.key) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: action.key, ...(action.code ? { code: action.code } : {}) }, sessionId)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: action.key, ...(action.code ? { code: action.code } : {}) }, sessionId)
      await sleep(260)
    }
    if (action.eval) await evaluate(cdp, sessionId, action.eval)
    if (action.probe) console.log(`  · ${action.label ?? 'probe'}: ${JSON.stringify(await evaluate(cdp, sessionId, action.probe))}`)
  }
}

async function shoot(cdp, scene) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  try {
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: scene.width, height: scene.height, deviceScaleFactor: 2, mobile: false
    }, sessionId)
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: scene.colorScheme ?? 'light' },
        { name: 'prefers-reduced-motion', value: scene.reducedMotion ? 'reduce' : 'no-preference' }
      ]
    }, sessionId)
    // 先落到同源空页写 localStorage，再进正式页面：首帧即为目标状态，没有二次布局。
    // bootstrap 页本身也会挂载应用并回写外观偏好（上一场景的深浅色）；等它写完再覆盖一次。
    await navigate(cdp, sessionId, `${BASE}/preview.html?bootstrap=1`)
    const seedStorage = `(() => {
      localStorage.clear()
      for (const [key, value] of Object.entries(${JSON.stringify(scene.storage ?? {})})) localStorage.setItem(key, value)
      return true
    })()`
    await evaluate(cdp, sessionId, seedStorage)
    await sleep(300)
    await evaluate(cdp, sessionId, seedStorage)
    await navigate(cdp, sessionId, `${BASE}/preview.html${scene.query ? `?${scene.query}` : ''}#${scene.hash ?? `sessions:${scene.channel ?? '2'}`}`)
    await sleep(scene.settleMs ?? 900)
    await runActions(cdp, sessionId, scene.actions)
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    const file = join(OUT, `${scene.name}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`✓ ${scene.name} → ${file}`)
    // 右栏特写：同一状态再按元素边界裁一张，细节（字号、间距、hairline）看得清。
    if (scene.clip) {
      const box = await evaluate(cdp, sessionId, `(() => {
        const element = document.querySelector(${JSON.stringify(scene.clip)})
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      })()`)
      if (box) {
        const clipped = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } }, sessionId)
        const clipFile = join(OUT, `${scene.name}.clip.png`)
        writeFileSync(clipFile, Buffer.from(clipped.data, 'base64'))
        console.log(`  ↳ ${clipFile}`)
      }
    }
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function main() {
  const selected = ONLY ? scenes.filter((scene) => ONLY.includes(scene.name)) : scenes
  if (!selected.length) throw new Error(`没有匹配的场景：${ONLY?.join(', ')}`)
  try {
    const probe = await fetch(`${BASE}/preview.html`)
    if (!probe.ok) throw new Error(String(probe.status))
  } catch (error) {
    throw new Error(`预览服务器不可达（${BASE}）：先运行 npm run preview:ui。${error instanceof Error ? error.message : ''}`)
  }
  mkdirSync(OUT, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'sg-preview-shots-'))
  const browser = spawn(resolveBrowser(), [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore' })
  let socket
  try {
    const endpoint = await waitForEndpoint(CDP_PORT)
    socket = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
    await new Promise((done, reject) => {
      socket.once('open', done)
      socket.once('error', reject)
    })
    const cdp = new Cdp(socket)
    for (const scene of selected) {
      try {
        await shoot(cdp, scene)
      } catch (error) {
        console.error(`✗ ${scene.name}: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    }
  } finally {
    socket?.close()
    const exited = new Promise((done) => browser.once('exit', done))
    browser.kill()
    await Promise.race([exited, sleep(3_000)])
    // 浏览器退出后仍可能短暂持有 profile 文件锁（Windows）：重试几次，清不掉也不算失败。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(profile, { recursive: true, force: true })
        break
      } catch {
        await sleep(400)
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
