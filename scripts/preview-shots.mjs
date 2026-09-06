#!/usr/bin/env node
/**
 * 设计走查截图：用本机 Chromium 内核浏览器（Edge / Chrome）无头打开 `npm run preview:ui`
 * 的预览页，按场景矩阵（面板 × 深浅色 × 窄栏 × 透明模式 × reduced-motion × 悬停）
 * 截图到 preview-screenshots/。只依赖 CDP 与 ws，不引入 Playwright。
 *
 *   npm run preview:ui                      # 另一个终端，端口 5174
 *   node scripts/preview-shots.mjs          # 全部场景
 *   node scripts/preview-shots.mjs --only review-light,plan-dark
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

const INSPECTOR_OPEN_KEY = 'qingtian-team.layout:v1:workspace-inspector:open'
const INSPECTOR_TAB_KEY = 'qingtian-team.inspector:active-tab'
const INSPECTOR_WIDTH_KEY = 'qingtian-team.layout:v1:shell.workspace-inspector'
const REVIEW_SCOPE_KEY = 'qingtian-team.inspector:review-scope'
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
  { name: 'inspector-opened', width: 1440, height: 900, colorScheme: 'light', storage: { ...baseStorage(), [INSPECTOR_OPEN_KEY]: '0' }, clip: null, actions: [{ click: '[aria-label="展开右侧工作区"]' }, { wait: 400 }] }
]

for (const scene of scenes) {
  if (scene.clip === undefined && scene.name !== 'inspector-closed') scene.clip = '.workspace-inspector'
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
    await navigate(cdp, sessionId, `${BASE}/preview.html?bootstrap=1`)
    await evaluate(cdp, sessionId, `(() => {
      localStorage.clear()
      for (const [key, value] of Object.entries(${JSON.stringify(scene.storage ?? {})})) localStorage.setItem(key, value)
      return true
    })()`)
    await navigate(cdp, sessionId, `${BASE}/preview.html${scene.query ? `?${scene.query}` : ''}#sessions:${scene.channel ?? '2'}`)
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
