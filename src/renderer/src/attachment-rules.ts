import { formatFileSize } from './format'

/** 附件防护限值：与后端 domain/channel-message 协议定稿一致（8 个 / 单文件 2MB / 合计 8MB）。 */
export const MAX_ATTACHMENTS = 8
export const MAX_ATTACHMENT_FILE_BYTES = 2 * 1024 * 1024
export const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024

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

/** 单文件准入：类型白名单（image/* 或扩展名）+ 单文件大小上限。返回拒绝文案或 undefined。 */
export function attachmentFileRejection(file: AttachmentCandidate): string | undefined {
  const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : ''
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
