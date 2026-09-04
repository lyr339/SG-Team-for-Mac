import { basename, extname } from 'node:path'

/** 图片 data URL 上限（附件单文件 2MB，base64 膨胀 ~1.37×，留余量）。 */
export const IMAGE_DATA_URL_MAX_CHARS = 12 * 1024 * 1024

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif'
}

export interface ParsedImageDataUrl {
  dataUrl: string
  mimeType: string
  bytes: Buffer
}

/** 渲染层传来的图片 data URL：只接受 image/* 的 base64 形态，超限或非图片直接拒绝。 */
export function parseImageDataUrl(value: unknown): ParsedImageDataUrl {
  if (!value || typeof value !== 'object') throw new Error('图片参数无效')
  const raw = value as Record<string, unknown>
  const dataUrl = typeof raw.dataUrl === 'string' ? raw.dataUrl : ''
  const match = dataUrl.length <= IMAGE_DATA_URL_MAX_CHARS
    ? dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i)
    : null
  if (!match) throw new Error('只支持图片 data URL')
  return { dataUrl, mimeType: match[1]!.toLowerCase(), bytes: Buffer.from(match[2]!, 'base64') }
}

/** 另存为的默认文件名：用附件名（去路径分隔符），缺扩展名时按 MIME 补。 */
export function suggestedImageFileName(name: unknown, mimeType: string): string {
  const cleaned = typeof name === 'string' ? basename(name.replace(/[/\\]/g, '_')).trim().slice(0, 120) : ''
  const extension = IMAGE_EXTENSION_BY_MIME[mimeType] ?? '.png'
  if (!cleaned || cleaned === '.' || cleaned === '..') return `image${extension}`
  // 只认「短字母数字」扩展名；奇形怪状的尾巴（如 ._etc_passwd）不算扩展名，照常补。
  return /^\.[a-z0-9]{2,5}$/i.test(extname(cleaned)) ? cleaned : `${cleaned}${extension}`
}
