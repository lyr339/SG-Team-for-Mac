import { describe, expect, it } from 'vitest'
import { IMAGE_DATA_URL_MAX_CHARS, parseImageDataUrl, suggestedImageFileName } from '../src/main/image-attachment-io'

describe('image attachment IPC input parsing', () => {
  it('accepts only base64 image data URLs and decodes the bytes', () => {
    const parsed = parseImageDataUrl({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' })
    expect(parsed.mimeType).toBe('image/png')
    expect(parsed.bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(() => parseImageDataUrl({ dataUrl: 'data:text/plain;base64,aGk=' })).toThrowError(/只支持图片/)
    expect(() => parseImageDataUrl({ dataUrl: 'https://example.com/a.png' })).toThrowError(/只支持图片/)
    expect(() => parseImageDataUrl({ dataUrl: `data:image/png;base64,${'A'.repeat(IMAGE_DATA_URL_MAX_CHARS)}` })).toThrowError(/只支持图片/)
    expect(() => parseImageDataUrl(undefined)).toThrowError(/参数无效/)
  })

  it('suggests a safe file name with an extension matching the MIME type', () => {
    expect(suggestedImageFileName('screen.png', 'image/png')).toBe('screen.png')
    expect(suggestedImageFileName('clipboard-image-1', 'image/jpeg')).toBe('clipboard-image-1.jpg')
    expect(suggestedImageFileName('../../etc/passwd', 'image/png')).toBe('.._.._etc_passwd.png')
    expect(suggestedImageFileName('', 'image/webp')).toBe('image.webp')
    expect(suggestedImageFileName(undefined, 'image/x-unknown')).toBe('image.png')
  })
})
