export interface RangeFieldProps {
  value: number
  min: number
  max: number
  step: number
  unit?: string
  disabled?: boolean
  onChange: (value: number) => void
  /** 无可见文本时的屏幕阅读器语义标签。 */
  label?: string
}

/**
 * 账号管线的数值滑杆：自绘轨道 + 拖动球 + 数值读出，
 * 替代原生 number 输入（0.5 步进区间上滑动手势远比敲数字顺手）。
 */
export function RangeField({ value, min, max, step, unit, disabled, onChange, label }: RangeFieldProps): React.JSX.Element {
  const span = max - min
  const fill = span > 0 ? Math.min(100, Math.max(0, ((value - min) / span) * 100)) : 0
  return (
    <span className={`range-field${disabled ? ' is-disabled' : ''}`}>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        {...(label ? { 'aria-label': label } : {})}
        style={{ '--range-fill': `${fill}%` } as React.CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <b className="range-field__value">{value}<i>{unit}</i></b>
    </span>
  )
}
