import {
  CHANNEL_ATTACHMENT_MAX_COUNT,
  CHANNEL_ATTACHMENT_MAX_FILE_BYTES,
  CHANNEL_ATTACHMENT_MAX_TOTAL_BYTES
} from '../../domain/channel-message'
import { formatFileSize } from './format'

/** 附件防护限值：唯一出口在 domain/channel-message（协议定稿 8 个 / 单文件 2MB / 合计 8MB）。 */
export const MAX_ATTACHMENTS = CHANNEL_ATTACHMENT_MAX_COUNT
export const MAX_ATTACHMENT_FILE_BYTES = CHANNEL_ATTACHMENT_MAX_FILE_BYTES
export const MAX_ATTACHMENT_TOTAL_BYTES = CHANNEL_ATTACHMENT_MAX_TOTAL_BYTES

export interface AttachmentCandidate {
  name: string
  size: number
  type: string
}

const ATTACHMENT_EXTENSION_WHITELIST = new Set([
  'pdf', 'txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs',
  'c', 'cpp', 'h', 'hpp', 'css', 'html', 'xml', 'yaml', 'yml', 'toml', 'ini',
  'sh', 'bat', 'ps1', 'sql', 'csv', 'log',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'
])

/** 模型侧无法解码的图片格式（Claude/GPT 仅收 jpeg/png/gif/webp；HEIC 是 macOS 相册默认格式）。 */
const UNDECODABLE_IMAGE_EXTENSIONS = new Set(['heic', 'heif', 'tiff', 'tif'])

/** 单文件准入：类型白名单（image/* 或扩展名）+ 模型可解码性 + 单文件大小上限。返回拒绝文案或 undefined。 */
export function attachmentFileRejection(file: AttachmentCandidate): string | undefined {
  const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : ''
  // 不可解码格式先于白名单判定：无论 file.type 是否缺失，都给出可操作的转换指引
  // 而不是笼统的「类型不支持」（HEIC 是 macOS 相册默认格式，最常见的踩坑点）。
  if (UNDECODABLE_IMAGE_EXTENSIONS.has(extension) || /image\/(heic|heif|tiff)/.test(file.type)) {
    return `「${file.name}」是 ${extension.toUpperCase()} 格式，模型无法解码；请先导出为 PNG/JPG 后再发送`
  }
  const typeAllowed = file.type.startsWith('image/') || ATTACHMENT_EXTENSION_WHITELIST.has(extension)
  if (!typeAllowed) return `「${file.name}」类型不支持（仅支持图片与常见文本/代码文件）`
  if (file.size > MAX_ATTACHMENT_FILE_BYTES) {
    return `「${file.name}」超过单文件 ${formatFileSize(MAX_ATTACHMENT_FILE_BYTES)} 上限；大文件请放入工作区后在消息里引用路径`
  }
  return undefined
}

/** 批量入口：数量上限、逐文件校验、合计大小上限。accepted 为可继续读取的文件（保留调用方原始类型，如 File），rejections 为用户可见文案。 */
export function planAttachmentIntake<T extends AttachmentCandidate>(
  selected: T[],
  existing: Array<{ size: number }>
): { accepted: T[]; rejections: string[] } {
  const rejections: string[] = []
  if (selected.length === 0) return { accepted: [], rejections }
  if (existing.length + selected.length > MAX_ATTACHMENTS) {
    rejections.push(`附件最多 ${MAX_ATTACHMENTS} 个（当前已有 ${existing.length} 个）`)
  }
  const quotaLeft = Math.max(0, MAX_ATTACHMENTS - existing.length)
  const accepted: T[] = []
  for (const file of selected.slice(0, quotaLeft)) {
    const rejection = attachmentFileRejection(file)
    if (rejection) rejections.push(rejection)
    else accepted.push(file)
  }
  const currentTotal = existing.reduce((sum, attachment) => sum + attachment.size, 0)
  const acceptedTotal = accepted.reduce((sum, file) => sum + file.size, 0)
  if (accepted.length && currentTotal + acceptedTotal > MAX_ATTACHMENT_TOTAL_BYTES) {
    rejections.push(`附件合计不能超过 ${formatFileSize(MAX_ATTACHMENT_TOTAL_BYTES)}（当前已占 ${formatFileSize(currentTotal)}）`)
    accepted.length = 0
  }
  return { accepted, rejections }
}
