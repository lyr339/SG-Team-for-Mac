import { protocol } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  imageMimeForPath,
  isLocalImagePath,
  LOCAL_IMAGE_MAX_BYTES,
  LOCAL_IMAGE_SCHEME,
  localImagePathFromUrl
} from '../shared/local-image'

/** `~/` 前缀展开到当前用户目录（渲染层不知道 home）。 */
export function expandLocalImagePath(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** 读盘前的硬校验：白名单扩展名、真实存在的普通文件、大小上限。 */
export function readLocalImage(path: string): { bytes: Buffer; mimeType: string } | undefined {
  if (!isLocalImagePath(path)) return undefined
  const resolved = expandLocalImagePath(path)
  try {
    const stat = statSync(resolved)
    if (!stat.isFile() || stat.size > LOCAL_IMAGE_MAX_BYTES) return undefined
    return { bytes: readFileSync(resolved), mimeType: imageMimeForPath(resolved) ?? 'application/octet-stream' }
  } catch {
    return undefined
  }
}

/** 必须在 app ready 之前调用：标准协议才能作为 <img src> 的安全来源参与 CSP。 */
export function registerLocalImageScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: LOCAL_IMAGE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true }
  }])
}

/** app ready 之后安装：sg-image://local/<encoded path> → 图片字节；任何校验失败一律 404。 */
export function installLocalImageProtocol(): void {
  protocol.handle(LOCAL_IMAGE_SCHEME, (request) => {
    const path = localImagePathFromUrl(request.url)
    const image = path ? readLocalImage(path) : undefined
    if (!image) return new Response('', { status: 404 })
    return new Response(new Uint8Array(image.bytes), {
      status: 200,
      headers: { 'content-type': image.mimeType, 'cache-control': 'no-store' }
    })
  })
}
