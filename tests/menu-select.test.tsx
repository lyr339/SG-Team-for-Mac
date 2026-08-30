// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MenuSelect } from '../src/renderer/src/lobby/MenuSelect'

describe('MenuSelect（账号管线自绘下拉）', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  const renderSelect = async (props: Parameters<typeof MenuSelect>[0]): Promise<void> => {
    await act(async () => {
      root!.render(<MenuSelect {...props} />)
    })
  }

  const buttonOf = (): HTMLButtonElement => {
    const button = container!.querySelector<HTMLButtonElement>('.menu-select__button')
    if (!button) throw new Error('menu-select button not found')
    return button
  }

  it('关闭态只渲染按钮与当前值，不渲染选项列表', async () => {
    await renderSelect({
      value: 'a',
      options: [{ value: 'a', label: '选项 A' }, { value: 'b', label: '选项 B' }],
      onChange: () => {}
    })
    expect(buttonOf().textContent).toContain('选项 A')
    expect(container!.querySelector('.menu-select__menu')).toBeNull()
    expect(buttonOf().getAttribute('aria-expanded')).toBe('false')
  })

  it('点击展开选项列表，选中项带 is-selected 与 ✓；点击选项回调并关闭', async () => {
    const onChange = vi.fn()
    await renderSelect({
      value: 'a',
      options: [{ value: 'a', label: '选项 A' }, { value: 'b', label: '选项 B' }],
      onChange
    })
    await act(async () => { buttonOf().click() })
    expect(buttonOf().getAttribute('aria-expanded')).toBe('true')
    const options = [...container!.querySelectorAll<HTMLButtonElement>('.menu-select__menu button')]
    expect(options.map((option) => option.querySelector('span')?.textContent)).toEqual(['选项 A', '选项 B'])
    expect(options[0]!.className).toContain('is-selected')
    expect(options[0]!.textContent).toContain('✓')

    await act(async () => { options[1]!.click() })
    expect(onChange).toHaveBeenCalledWith('b')
    expect(container!.querySelector('.menu-select__menu')).toBeNull()
  })

  it('点击组件外部关闭列表；Escape 同样关闭', async () => {
    await renderSelect({
      value: 'a',
      options: [{ value: 'a', label: '选项 A' }],
      onChange: () => {}
    })
    await act(async () => { buttonOf().click() })
    expect(container!.querySelector('.menu-select__menu')).not.toBeNull()

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    await act(async () => { outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(container!.querySelector('.menu-select__menu')).toBeNull()
    outside.remove()

    await act(async () => { buttonOf().click() })
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(container!.querySelector('.menu-select__menu')).toBeNull()
  })

  it('无值时显示占位符；disabled 时按钮禁用且不可展开', async () => {
    await renderSelect({
      value: '',
      placeholder: '选择窗口…',
      options: [{ value: 'a', label: '选项 A' }],
      onChange: () => {}
    })
    expect(buttonOf().textContent).toContain('选择窗口…')

    await renderSelect({
      value: '',
      disabled: true,
      options: [{ value: 'a', label: '选项 A' }],
      onChange: () => {}
    })
    expect((buttonOf() as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { buttonOf().click() })
    expect(container!.querySelector('.menu-select__menu')).toBeNull()
  })

  it('模型选项携带厂商色调与识别色块', async () => {
    await renderSelect({
      value: 'gpt',
      options: [
        { value: 'gpt', label: 'GPT-5.6 Sol', tone: 'provider-openai' },
        { value: 'claude', label: 'Claude Opus 5', tone: 'provider-anthropic' }
      ],
      onChange: () => {}
    })
    expect(container!.querySelector('.menu-select.provider-openai')).not.toBeNull()
    expect(container!.querySelector('.menu-select__value .menu-select__swatch')).not.toBeNull()
    await act(async () => { buttonOf().click() })
    expect(container!.querySelector('.menu-select__menu .provider-anthropic .menu-select__swatch')).not.toBeNull()
  })
})
