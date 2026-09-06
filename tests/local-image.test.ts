import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RevealPathPolicy } from '../src/application/reveal-path-policy'
import { parseImageInput } from '../src/main/image-attachment-io'
import {
  isLocalImagePath,
  localImagePathFromUrl,
  localImageUrl,
  resolveMessageImageSource
} from '../src/shared/local-image'

describe('local image resolution (会话正文里的 ![…](/path.png))', () => {
  it('maps absolute image paths and file:// URLs to the sg-image protocol, keeps data URLs, links remote images', () => {
    expect(resolveMessageImageSource('/tmp/sg-composer-grow.png')).toEqual({
      kind: 'local', path: '/tmp/sg-composer-grow.png', mimeType: 'image/png',
      src: 'sg-image://local/%2Ftmp%2Fsg-composer-grow.png'
    })
    expect(resolveMessageImageSource('file:///Users/lyr/Desktop/a%20b.jpg')).toMatchObject({ kind: 'local', path: '/Users/lyr/Desktop/a b.jpg', mimeType: 'image/jpeg' })
    expect(resolveMessageImageSource('file:///C:/shots/x.webp')).toMatchObject({ kind: 'local', path: 'C:/shots/x.webp' })
    expect(resolveMessageImageSource('~/Downloads/shot.png')).toMatchObject({ kind: 'local', path: '~/Downloads/shot.png' })
    expect(resolveMessageImageSource('data:image/png;base64,iVBORw0KGgo=')).toMatchObject({ kind: 'data', mimeType: 'image/png' })
    expect(resolveMessageImageSource('https://example.com/a.png')).toEqual({ kind: 'remote', href: 'https://example.com/a.png' })
  })

  it('refuses relative paths, non-image extensions and control characters', () => {
    expect(resolveMessageImageSource('shot.png')).toBeUndefined()
    expect(resolveMessageImageSource('./shot.png')).toBeUndefined()
    expect(resolveMessageImageSource('/etc/passwd')).toBeUndefined()
    expect(resolveMessageImageSource('/tmp/a.png\n/etc/passwd')).toBeUndefined()
    expect(isLocalImagePath('/tmp/x.PNG')).toBe(true)
    expect(isLocalImagePath('/tmp/x.txt')).toBe(false)
  })

  it('round-trips the protocol URL and rejects foreign URLs', () => {
    const path = '/Users/lyr/Library/Application Support/qingtian-team/handoff/图 1.png'
    expect(localImagePathFromUrl(localImageUrl(path))).toBe(path)
    expect(localImagePathFromUrl('sg-image://local/%2Ftmp%2Fnotes.txt')).toBeUndefined()
    expect(localImagePathFromUrl('https://evil/%2Ftmp%2Fa.png')).toBeUndefined()
    expect(localImagePathFromUrl('sg-image://local/%E0%A4%A')).toBeUndefined()
  })
})

describe('main-side image input and reveal policy for message images', () => {
  const root = mkdtempSync(join(tmpdir(), 'qingtian-local-image-'))
  const png = join(root, 'shot.png')
  writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
  writeFileSync(join(root, 'notes.txt'), 'x')

  it('reads a whitelisted local image by path and rejects everything else', () => {
    const parsed = parseImageInput({ path: png })
    expect(parsed.path).toBe(png)
    expect(parsed.mimeType).toBe('image/png')
    expect(parsed.bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(parsed.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(() => parseImageInput({ path: join(root, 'notes.txt') })).toThrowError(/只支持本地图片文件/)
    expect(() => parseImageInput({ path: join(root, 'missing.png') })).toThrowError(/读取图片失败/)
    expect(() => parseImageInput({ path: 'relative.png' })).toThrowError(/只支持本地图片文件/)
  })

  it('lets the user reveal an existing image file referenced in a message, but never arbitrary files', () => {
    const policy = new RevealPathPolicy([join(root, 'handoff')], { allowImageFiles: true })
    expect(policy.allows(png)).toBe(true)
    expect(policy.allows(join(root, 'notes.txt'))).toBe(false)
    expect(policy.allows(join(root, 'missing.png'))).toBe(false)
    expect(new RevealPathPolicy([join(root, 'handoff')]).allows(png)).toBe(false)
  })
})
