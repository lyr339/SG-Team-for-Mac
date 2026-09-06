// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageAttachment } from '../src/domain/conversation-entry'
import { AttachmentThumbnail } from '../src/renderer/src/AttachmentImageViewer'

const attachment: MessageAttachment = {
  id: 'att-1',
  name: 'screen.png',
  mimeType: 'image/png',
  size: 76_288,
  previewUrl: 'data:image/png;base64,iVBORw0KGgo=',
  path: '/Users/x/Library/Application Support/qingtian-team/channel-attachments/m1/screen.png'
}

describe('AttachmentThumbnail', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    delete (window as unknown as { qingtianDesktop?: unknown }).qingtianDesktop
  })

  it('renders a zoomable button and nothing when the attachment has no image source', () => {
    const html = renderToStaticMarkup(<AttachmentThumbnail attachment={attachment} className="chat-attachment-image" />)
    expect(html).toContain('class="attachment-thumb chat-attachment-image"')
    expect(html).toContain('点击查看大图，右键更多操作')
    expect(renderToStaticMarkup(<AttachmentThumbnail attachment={{ ...attachment, previewUrl: undefined }} />)).toBe('')
  })

  it('opens the lightbox on click, copies through the desktop API and closes on Escape', async () => {
    const copyImageToClipboard = vi.fn(async () => true)
    ;(window as unknown as { qingtianDesktop?: unknown }).qingtianDesktop = { copyImageToClipboard, saveImageAs: vi.fn(), revealPathInFolder: vi.fn() }
    await act(async () => root.render(<AttachmentThumbnail attachment={attachment} />))
    await act(async () => { container.querySelector<HTMLButtonElement>('.attachment-thumb')!.click() })
    const lightbox = document.querySelector('.attachment-lightbox')
    expect(lightbox).not.toBeNull()
    expect(lightbox?.textContent).toContain('screen.png')
    expect(lightbox?.textContent).toContain('74.5 KB')
    // 已落盘的附件多出「在 Finder 中显示」
    expect(lightbox?.textContent).toContain('在 Finder 中显示')
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.attachment-lightbox__actions button')].find((b) => b.textContent === '复制图片')!.click() })
    expect(copyImageToClipboard).toHaveBeenCalledWith({ dataUrl: attachment.previewUrl })
    expect(document.querySelector('.attachment-lightbox__actions em')?.textContent).toBe('已复制到剪贴板')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(document.querySelector('.attachment-lightbox')).toBeNull()
  })

  it('opens a context menu on right click with copy/save/reveal and an optional remove entry', async () => {
    const onRemove = vi.fn()
    await act(async () => root.render(<AttachmentThumbnail attachment={attachment} onRemove={onRemove} />))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.attachment-thumb')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }))
    })
    const labels = [...document.querySelectorAll<HTMLButtonElement>('.attachment-menu button')].map((b) => b.textContent)
    expect(labels).toEqual(['查看大图', '复制图片', '另存为…', '在 Finder 中显示', '移除附件'])
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.attachment-menu button')].at(-1)!.click() })
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.attachment-menu')).toBeNull()
  })
})
