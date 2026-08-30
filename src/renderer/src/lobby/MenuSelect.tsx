import { useEffect, useRef, useState } from 'react'

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
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className={`menu-select${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${selected?.tone ? ` ${selected.tone}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className="menu-select__button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="menu-select__value">{selected ? <><i className="menu-select__swatch" aria-hidden="true" />{selected.label}</> : <em>{placeholder}</em>}</span>
        <i className="menu-select__chevron" aria-hidden="true" />
      </button>
      {open ? (
        <ul className="menu-select__menu" role="listbox">
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
                {option.value === value ? <i className="menu-select__check" aria-hidden="true">✓</i> : null}
              </button>
            </li>
          ))}
          {!options.length ? <li className="menu-select__empty">暂无可选项</li> : null}
        </ul>
      ) : null}
    </div>
  )
}
