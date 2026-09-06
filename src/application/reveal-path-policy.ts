import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { isLocalImagePath } from '../shared/local-image'

/**
 * 「在文件管理器中显示」的白名单：渲染层只能让主进程显示拾光自己产出/定位过的文件
 * （交接记录、Cursor 转录、通道附件），以及会话正文里已经展示给用户的本地图片文件；
 * 不能把任意路径交给系统。
 */
export class RevealPathPolicy {
  private readonly roots: string[]
  private readonly allowImageFiles: boolean

  constructor(roots: readonly string[], options: { allowImageFiles?: boolean } = {}) {
    this.roots = roots.map((root) => root.trim()).filter(Boolean).map((root) => resolve(root))
    this.allowImageFiles = options.allowImageFiles === true
  }

  allows(path: string): boolean {
    const candidate = String(path ?? '').trim()
    if (!candidate) return false
    const expanded = candidate.startsWith('~/') ? join(homedir(), candidate.slice(2)) : candidate
    const normalized = resolve(expanded)
    if (this.roots.some((root) => normalized === root || normalized.startsWith(root + sep))) return true
    if (!this.allowImageFiles || !isLocalImagePath(candidate)) return false
    try {
      return statSync(normalized).isFile()
    } catch {
      return false
    }
  }
}
