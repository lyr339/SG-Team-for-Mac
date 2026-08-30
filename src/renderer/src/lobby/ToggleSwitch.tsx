import { useId } from 'react'

export interface ToggleSwitchProps {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  /** 开关旁的可见说明文本。 */
  children?: React.ReactNode
  /** 无可见文本时的屏幕阅读器语义标签。 */
  label?: string
}

/**
 * 账号管线的开关控件：原生 checkbox 视觉隐藏 + 自绘轨道/滑块
 * （保留原生 input 的键盘可达性与测试可断言性，不引外部组件库）。
 */
export function ToggleSwitch({ checked, disabled, onChange, children, label }: ToggleSwitchProps): React.JSX.Element {
  const id = useId()
  return (
    <label className={`toggle-switch${disabled ? ' is-disabled' : ''}`} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        {...(children ? {} : { 'aria-label': label })}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-switch__track" aria-hidden="true"><i className="toggle-switch__thumb" /></span>
      {children ? <span className="toggle-switch__text">{children}</span> : null}
    </label>
  )
}
