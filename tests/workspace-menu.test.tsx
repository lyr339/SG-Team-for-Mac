// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceMenu } from '../src/renderer/src/WorkspaceMenu'
import { DesktopShell } from '../src/renderer/src/DesktopShell'

const workspace = { id: 'project-a', name: '项目 A', path: '/projects/a' }
const detection = {
  state: 'detected' as const, confidence: 'certain' as const, source: 'cursor-window' as const,
  workspace: { id: 'project-b', name: '项目 B', path: '/projects/b', channelIds: [] },
  candidates: [], detail: '最近使用', observedAt: 1
}

describe('工作区查看入口', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })
  const trigger = (): HTMLButtonElement => container.querySelector('.workspace-detection-chip')!
  const panel = (): HTMLElement | null => document.querySelector('.workspace-menu')
  const clickText = async (text: string): Promise<void> => {
    const button = Array.from(panel()!.querySelectorAll('button')).find((item) => item.textContent?.includes(text))!
    await act(async () => button.click())
  }

  it('显示 Cursor 实际项目；已有会话项目单独提示，打开及复制不改变绑定', async () => {
    const openConfiguration = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      await act(async () => root.render(<WorkspaceMenu workspace={workspace} detection={detection} onOpenConfiguration={openConfiguration} />))
      expect(trigger().textContent).toBe('项目 B')
      await act(async () => trigger().click())
      expect(panel()?.textContent).toContain('/projects/b')
      expect(panel()?.textContent).toContain('保持原绑定')
      expect(panel()?.textContent).toContain('项目 B')
      expect(container.querySelector('.workspace-menu')).toBeNull() // portal 避开顶栏裁切
      await clickText('复制项目路径')
      expect(writeText).toHaveBeenCalledExactlyOnceWith('/projects/b')
      expect(panel()?.textContent).toContain('路径已复制')
      expect(openConfiguration).not.toHaveBeenCalled()
      await clickText('前往项目配置')
      expect(openConfiguration).toHaveBeenCalledTimes(1)
      expect(panel()).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('键盘操作、Escape 焦点恢复及外部点击关闭', async () => {
    await act(async () => root.render(<WorkspaceMenu workspace={workspace} detection={detection} onOpenConfiguration={() => {}} />))
    await act(async () => trigger().click())
    expect(document.activeElement).toBe(panel())
    await act(async () => panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement?.textContent).toBe('复制项目路径')
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
    expect(document.activeElement?.textContent).toContain('前往项目配置')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    await act(async () => trigger().click())
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(panel()).toBeNull()
  })

  it('未绑定时不把最近工程冒充当前项目；复制失败可见', async () => {
    const openConfiguration = vi.fn()
    await act(async () => root.render(<WorkspaceMenu detection={{ ...detection, source: 'cursor-recent' }} onOpenConfiguration={openConfiguration} />))
    expect(trigger().textContent).toBe('工作区未就绪')
    await act(async () => trigger().click())
    expect(panel()?.textContent).toContain('工作区未就绪')
    expect(panel()?.textContent).not.toContain('复制项目路径')
    expect(openConfiguration).not.toHaveBeenCalled()
    await act(async () => root.render(<WorkspaceMenu workspace={workspace} detection={detection} onOpenConfiguration={openConfiguration} />))
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    try {
      await clickText('复制项目路径')
      expect(panel()?.textContent).toContain('复制失败')
    } finally { vi.unstubAllGlobals() }
  })

  it('Cursor 切换后更新顶部，空窗口撤下旧路径；不触发项目配置', async () => {
    const configure = vi.fn()
    const render = async (next: typeof detection | undefined): Promise<void> => {
      await act(async () => root.render(<WorkspaceMenu workspace={workspace} detection={next} onOpenConfiguration={configure} />))
    }
    await render({ ...detection, workspace: { ...workspace, channelIds: [] } })
    expect(trigger().textContent).toBe('项目 A')
    await render(detection)
    expect(trigger().textContent).toBe('项目 B')
    await act(async () => trigger().click())
    expect(panel()?.textContent).toContain('保持原绑定')
    await render(undefined)
    expect(trigger().textContent).toBe('工作区未就绪')
    expect(panel()?.textContent).not.toContain('/projects/b')
    expect(panel()?.textContent).not.toContain('复制项目路径')
    expect(configure).not.toHaveBeenCalled()
  })

  it('壳层点击工作区保持当前会话、左右栏及页面，菜单无业务选择回调', async () => {
    localStorage.clear()
    const changeModule = vi.fn()
    const openConfiguration = vi.fn()
    await act(async () => root.render(<DesktopShell
      snapshot={{ connection: { state: 'connected', endpoint: 'local', attempt: 0, lastError: '' }, sessions: [], conversations: {}, protocolIssues: [], updatedAt: 1 }}
      activeModule="sessions" sidebar={<aside>已有会话列表</aside>}
      workspace={workspace} cursorWorkspace={detection}
      cardOpacity={1} colorMode="light" onModuleChange={changeModule}
      onOpenProjectConfiguration={openConfiguration}
      onCardOpacityChange={() => {}} onColorModeChange={() => {}}
    ><textarea defaultValue="原有草稿" /></DesktopShell>))
    const draft = container.querySelector('textarea')
    await act(async () => trigger().click())
    expect(changeModule).not.toHaveBeenCalled()
    expect(openConfiguration).not.toHaveBeenCalled()
    expect(container.textContent).toContain('已有会话列表')
    expect(container.querySelector('textarea')).toBe(draft)
    expect(draft?.value).toBe('原有草稿')
  })
})
