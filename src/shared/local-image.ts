/**
 * 会话正文里的本地图片：Agent 回复常引用它刚生成的截图（`![说明](/tmp/shot.png)`）。
 * 渲染层不能直接加载 file://（CSP 与 dev/打包两种 origin 不一致），统一映射为自定义
 * 协议 `sg-image://local/<encoded absolute path>`，由主进程按白名单扩展名读盘返回。
 * 本模块只做纯字符串换算，渲染层与主进程共用同一套规则。
 */
export const LOCAL_IMAGE_SCHEME = 'sg-image'
export const LOCAL_IMAGE_HOST = 'local'
/** 主进程读盘上限：超大文件拒绝，避免一条消息把渲染进程内存吃满。 */
export const LOCAL_IMAGE_MAX_BYTES = 32 * 1024 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

export function imageMimeForPath(path: string): string | undefined {
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  return MIME_BY_EXTENSION[extension]
}

/** 绝对路径（POSIX / Windows 盘符 / `~/`）且扩展名在图片白名单内。 */
export function isLocalImagePath(path: string): boolean {
  const value = path.trim()
  if (!value || /[\u0000\n\r]/.test(value)) return false
  const absolute = value.startsWith('/') || value.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(value)
  return absolute && imageMimeForPath(value) !== undefined
}

export function localImageUrl(path: string): string {
  return `${LOCAL_IMAGE_SCHEME}://${LOCAL_IMAGE_HOST}/${encodeURIComponent(path.trim())}`
}

/** 从协议 URL 还原路径；非本协议 / 不是图片路径返回 undefined。 */
export function localImagePathFromUrl(url: string): string | undefined {
  const prefix = `${LOCAL_IMAGE_SCHEME}://${LOCAL_IMAGE_HOST}/`
  if (!url.startsWith(prefix)) return undefined
  try {
    const path = decodeURIComponent(url.slice(prefix.length).split(/[?#]/)[0] ?? '')
    return isLocalImagePath(path) ? path : undefined
  } catch {
    return undefined
  }
}

export type MessageImageSource =
  | { kind: 'data'; src: string; mimeType: string }
  | { kind: 'local'; src: string; path: string; mimeType: string }
  | { kind: 'remote'; href: string }

/**
 * Markdown 图片目标 → 可渲染来源：
 * - `data:image/…` 直接用；
 * - 绝对路径 / `file://` 本地路径 → sg-image 协议（仅白名单扩展名）；
 * - http(s) → 只给链接，不在会话页内加载远程资源。
 */
export function resolveMessageImageSource(target: string): MessageImageSource | undefined {
  const value = target.trim()
  if (!value) return undefined
  const dataMatch = value.match(/^data:(image\/[a-z0-9.+-]+);base64,/i)
  if (dataMatch) return { kind: 'data', src: value, mimeType: dataMatch[1]!.toLowerCase() }
  if (/^https?:\/\//i.test(value)) return { kind: 'remote', href: value }
  let path = value
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      path = decodeURIComponent(url.pathname)
      // Windows：file:///C:/x.png 的 pathname 是 /C:/x.png
      if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1)
    } catch {
      return undefined
    }
  }
  if (!isLocalImagePath(path)) return undefined
  return { kind: 'local', src: localImageUrl(path), path, mimeType: imageMimeForPath(path)! }
}
