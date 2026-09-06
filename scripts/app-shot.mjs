#!/usr/bin/env node
/**
 * 给正在运行的 Electron 开发版拍一张窗口截图（主进程需以 --remote-debugging-port 启动）：
 *   npx electron-vite dev -- --remote-debugging-port=9556
 *   node scripts/app-shot.mjs [port=9556] [out=preview-screenshots/app-window.png]
 * 顺带把渲染进程 console 里的 error / warning 打印出来，用于启动健康检查。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import WebSocket from 'ws'

const port = Number(process.argv[2] || 9556)
const out = resolve(process.argv[3] || 'preview-screenshots/app-window.png')

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((target) => target.type === 'page' && !target.url.startsWith('devtools://'))
if (!page) {
  console.error('没有找到应用窗口 target：', targets.map((target) => `${target.type} ${target.url}`))
  process.exit(1)
}
console.log(`window: ${page.title} ${page.url}`)

const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
await new Promise((done, reject) => { socket.once('open', done); socket.once('error', reject) })
let nextId = 1
const pending = new Map()
const logs = []
socket.on('message', (raw) => {
  const message = JSON.parse(String(raw))
  if (message.id && pending.has(message.id)) {
    const { resolve: done, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else done(message.result)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
    logs.push(`${message.params.type}: ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`)
  }
  if (message.method === 'Runtime.exceptionThrown') {
    logs.push(`exception: ${message.params.exceptionDetails.text} ${message.params.exceptionDetails.exception?.description ?? ''}`)
  }
})
const send = (method, params = {}) => new Promise((done, reject) => {
  const id = nextId++
  pending.set(id, { resolve: done, reject })
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')
await send('Page.enable')
await new Promise((done) => setTimeout(done, 1_500))
const metrics = await send('Page.getLayoutMetrics')
const { data } = await send('Page.captureScreenshot', { format: 'png' })
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, Buffer.from(data, 'base64'))
console.log(`viewport: ${Math.round(metrics.cssVisualViewport.clientWidth)}×${Math.round(metrics.cssVisualViewport.clientHeight)} → ${out}`)
const summary = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `({
    platform: document.documentElement.dataset.platform,
    colorMode: document.documentElement.dataset.colorMode,
    module: document.querySelector('.topbar-nav .is-active')?.textContent ?? null,
    sessions: document.querySelectorAll('.rail-session-card').length,
    connection: document.querySelector('.connection-chip')?.textContent ?? null,
    inspectorOpen: !document.querySelector('.workspace-dock')?.classList.contains('is-end-pane-collapsed')
  })`
})
console.log('dom:', JSON.stringify(summary.result.value))
console.log(logs.length ? `renderer console:\n  ${logs.join('\n  ')}` : 'renderer console: no errors / warnings captured in the window')
socket.close()
