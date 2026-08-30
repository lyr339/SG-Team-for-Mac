import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export const DEFAULT_CURSOR_WORKBENCH_BUNDLE = '/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js'

interface SwitchConfig {
  port: number
  key: string
  revision?: number
}

const CONFIG_PATTERN = /\/\*ZMO_SWITCH_CONFIG:([A-Za-z0-9+/=]+)\*\//
const RUNTIME_PATTERN = /const zP=(\d+),zK="([^"]+)"/

export function rewriteCursorRuntimeCompanion(
  source: string,
  input: { port: number; key: string }
): { source: string; changed: boolean; previousPort: number } {
  const configMatch = source.match(CONFIG_PATTERN)
  const runtimeMatch = source.match(RUNTIME_PATTERN)
  if (!configMatch?.[1] || !runtimeMatch?.[1] || !runtimeMatch[2]) {
    throw new Error('Cursor 运行时换号 Companion 锚点缺失；请重新安装拾光兼容补丁')
  }
  let config: SwitchConfig
  try {
    config = JSON.parse(Buffer.from(configMatch[1], 'base64').toString('utf8')) as SwitchConfig
  } catch {
    throw new Error('Cursor 运行时换号 Companion 配置损坏')
  }
  const previousPort = Number(runtimeMatch[1])
  if (!Number.isInteger(previousPort) || config.port !== previousPort || config.key !== runtimeMatch[2]) {
    throw new Error('Cursor 运行时换号 Companion 配置与执行代码不一致')
  }
  if (previousPort === input.port && config.key === input.key) {
    return { source, changed: false, previousPort }
  }
  const nextConfig: SwitchConfig = { ...config, port: input.port, key: input.key, revision: (config.revision ?? 1) + 1 }
  const encoded = Buffer.from(JSON.stringify(nextConfig), 'utf8').toString('base64')
  const rewritten = source
    .replace(CONFIG_PATTERN, `/*ZMO_SWITCH_CONFIG:${encoded}*/`)
    .replace(RUNTIME_PATTERN, `const zP=${input.port},zK="${input.key}"`)
  if (!rewritten.includes(`const zP=${input.port},zK="${input.key}"`)) {
    throw new Error('Cursor 运行时换号 Companion 端口改写校验失败')
  }
  return { source: rewritten, changed: true, previousPort }
}

/** 在 Cursor 已退出的切换窗口内，把 Companion 指向拾光独占端口。 */
export class CursorRuntimeCompanionConfig {
  constructor(readonly bundlePath = DEFAULT_CURSOR_WORKBENCH_BUNDLE) {}

  ensure(input: { port: number; key: string }): { changed: boolean; previousPort: number } {
    if (!existsSync(this.bundlePath)) throw new Error(`Cursor 主程序 bundle 不存在：${this.bundlePath}`)
    const current = readFileSync(this.bundlePath, 'utf8')
    const rewritten = rewriteCursorRuntimeCompanion(current, input)
    if (!rewritten.changed) return { changed: false, previousPort: rewritten.previousPort }
    const backup = `${this.bundlePath}.sg-runtime-switch-backup`
    if (!existsSync(backup)) copyFileSync(this.bundlePath, backup)
    const temporary = `${this.bundlePath}.sg-runtime-switch.tmp`
    writeFileSync(temporary, rewritten.source, 'utf8')
    renameSync(temporary, this.bundlePath)
    const verified = rewriteCursorRuntimeCompanion(readFileSync(this.bundlePath, 'utf8'), input)
    if (verified.previousPort !== input.port) throw new Error('Cursor 运行时换号 Companion 写入后校验失败')
    return { changed: true, previousPort: rewritten.previousPort }
  }
}
