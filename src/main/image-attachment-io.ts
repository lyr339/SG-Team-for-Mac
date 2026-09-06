import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { imageMimeForPath, isLocalImagePath, LOCAL_IMAGE_MAX_BYTES } from '../shared/local-image'

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

export interface ParsedImageInput {
  mimeType: string
  bytes: Buffer
  /** 来源是本地文件时的（已展开 `~`）绝对路径；data URL 来源为 undefined。 */
  path?: string
  /** 供 nativeImage.createFromDataURL 使用；本地文件来源按需拼装。 */
  dataUrl: string
}

/** 渲染层传来的图片 data URL：只接受 image/* 的 base64 形态，超限或非图片直接拒绝。 */
export function parseImageDataUrl(value: unknown): ParsedImageInput {
  if (!value || typeof value !== 'object') throw new Error('图片参数无效')
  const raw = value as Record<string, unknown>
  const dataUrl = typeof raw.dataUrl === 'string' ? raw.dataUrl : ''
  const match = dataUrl.length <= IMAGE_DATA_URL_MAX_CHARS
    ? dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i)
    : null
  if (!match) throw new Error('只支持图片 data URL')
  return { dataUrl, mimeType: match[1]!.toLowerCase(), bytes: Buffer.from(match[2]!, 'base64') }
}

/**
 * 图片操作入参：`{ dataUrl }`（附件 base64）或 `{ path }`（会话正文引用的本地图片文件）。
 * 路径分支与 sg-image 协议同一套校验：白名单扩展名、真实普通文件、大小上限。
 */
export function parseImageInput(value: unknown): ParsedImageInput {
  if (!value || typeof value !== 'object') throw new Error('图片参数无效')
  const raw = value as Record<string, unknown>
  if (typeof raw.path === 'string' && raw.path.trim()) {
    const requested = raw.path.trim()
    if (!isLocalImagePath(requested)) throw new Error('只支持本地图片文件')
    const path = requested.startsWith('~/') ? join(homedir(), requested.slice(2)) : requested
    let bytes: Buffer
    try {
      const stat = statSync(path)
      if (!stat.isFile()) throw new Error('不是文件')
      if (stat.size > LOCAL_IMAGE_MAX_BYTES) throw new Error('文件过大')
      bytes = readFileSync(path)
    } catch (error) {
      throw new Error(`读取图片失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const mimeType = imageMimeForPath(path) ?? 'image/png'
    return { path, mimeType, bytes, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}` }
  }
  return parseImageDataUrl(value)
}

/** 另存为的默认文件名：用附件名（去路径分隔符），缺扩展名时按 MIME 补。 */
export function suggestedImageFileName(name: unknown, mimeType: string): string {
  const cleaned = typeof name === 'string' ? basename(name.replace(/[/\\]/g, '_')).trim().slice(0, 120) : ''
  const extension = IMAGE_EXTENSION_BY_MIME[mimeType] ?? '.png'
  if (!cleaned || cleaned === '.' || cleaned === '..') return `image${extension}`
  // 只认「短字母数字」扩展名；奇形怪状的尾巴（如 ._etc_passwd）不算扩展名，照常补。
  return /^\.[a-z0-9]{2,5}$/i.test(extname(cleaned)) ? cleaned : `${cleaned}${extension}`
}
