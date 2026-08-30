import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

export interface MenuSelectOption {
  value: string
  label: string
  tone?: string
}

export interface MenuSelectProps {
  value: string
  options: MenuSelectOption[]
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
  onChange: (value: string) => void
}

/**
 * 账号管线的下拉选择：自绘按钮 + 弹出列表（点击外部 / Esc 关闭），
 * 视觉与卡片设计体系一致，替代原生 select 的系统样式。
 */
export function MenuSelect({ value, options, placeholder = '请选择…', disabled, ariaLabel, onChange }: MenuSelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>()
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const menuId = useId()
  const selected = options.find((option) => option.value === value)

  const positionMenu = useCallback((): void => {
    const button = buttonRef.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    const gap = 6
    const viewportPadding = 10
    const below = window.innerHeight - rect.bottom - gap - viewportPadding
    const above = rect.top - gap - viewportPadding
    const placeAbove = below < 150 && above > below
    const maxHeight = Math.max(96, Math.min(224, placeAbove ? above : below))
    setMenuStyle({
      position: 'fixed',
      left: rect.left,
      top: placeAbove ? undefined : rect.bottom + gap,
      bottom: placeAbove ? window.innerHeight - rect.top + gap : undefined,
      width: rect.width,
      maxHeight
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', positionMenu)
    document.addEventListener('scroll', positionMenu, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', positionMenu)
      document.removeEventListener('scroll', positionMenu, true)
    }
  }, [open, positionMenu])

  return (
    <div className={`menu-select${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${selected?.tone ? ` ${selected.tone}` : ''}`} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="menu-select__button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (!open) positionMenu()
          setOpen((current) => !current)
        }}
      >
        <span className="menu-select__value">{selected ? <><i className="menu-select__swatch" aria-hidden="true" />{selected.label}</> : <em>{placeholder}</em>}</span>
        <i className="menu-select__chevron" aria-hidden="true" />
      </button>
      {open && menuStyle ? createPortal(
        <ul className="menu-select__menu is-portal" id={menuId} role="listbox" ref={menuRef} style={menuStyle}>
          {options.map((option) => (
            <li key={option.value} role="option" aria-selected={option.value === value}>
              <button
                type="button"
                className={`${option.value === value ? 'is-selected' : ''}${option.tone ? ` ${option.tone}` : ''}`}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span><i className="menu-select__swatch" aria-hidden="true" />{option.label}</span>
                {option.value === value ? (
                  <i className="menu-select__check" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m3.5 8 3 3 6-6" /></svg></i>
                ) : null}
              </button>
            </li>
          ))}
          {!options.length ? <li className="menu-select__empty">暂无可选项</li> : null}
        </ul>,
        document.body
      ) : null}
    </div>
  )
}
