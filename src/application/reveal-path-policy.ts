import { resolve, sep } from 'node:path'

/**
 * 「在文件管理器中显示」的白名单：渲染层只能让主进程显示拾光自己产出/定位过的文件
 * （交接记录、Cursor 转录、通道附件），不能把任意路径交给系统。
 */
export class RevealPathPolicy {
  private readonly roots: string[]

  constructor(roots: readonly string[]) {
    this.roots = roots.map((root) => root.trim()).filter(Boolean).map((root) => resolve(root))
  }

  allows(path: string): boolean {
    const candidate = String(path ?? '').trim()
    if (!candidate) return false
    const normalized = resolve(candidate)
    return this.roots.some((root) => normalized === root || normalized.startsWith(root + sep))
  }
}
