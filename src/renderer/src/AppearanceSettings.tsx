interface AppearanceSettingsProps {
  cardOpacity: number
  colorMode: 'system' | 'light' | 'dark'
  onCardOpacityChange: (value: number) => void
  onColorModeChange: (value: 'system' | 'light' | 'dark') => void
  onClose: () => void
}

const PRESETS = [
  { label: '通透', value: 0 },
  { label: '轻盈', value: 0.45 },
  { label: '柔和', value: 0.72 },
  { label: '实色', value: 1 }
] as const

export function AppearanceSettings({
  cardOpacity,
  colorMode,
  onCardOpacityChange,
  onColorModeChange,
  onClose
}: AppearanceSettingsProps): React.JSX.Element {
  const percentage = Math.round(cardOpacity * 100)

  return (
    <section className="appearance-popover" aria-label="外观设置">
      <header>
        <div>
          <strong>外观</strong>
          <span>让内容保持清晰，也让背景自由透出来。</span>
        </div>
        <button onClick={onClose} aria-label="关闭外观设置">×</button>
      </header>

      <div className="appearance-mode">
        <span>显示模式</span>
        <div aria-label="显示模式">
          {([
            ['system', '跟随系统'],
            ['light', '浅色'],
            ['dark', '深色']
          ] as const).map(([value, label]) => (
            <button
              key={value}
              className={colorMode === value ? 'is-active' : ''}
              onClick={() => onColorModeChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="appearance-opacity">
        <div>
          <label htmlFor="card-opacity">卡片透明度</label>
          <output htmlFor="card-opacity">{percentage}%</output>
        </div>
        <input
          id="card-opacity"
          type="range"
          min="0"
          max="100"
          step="1"
          value={percentage}
          onChange={(event) => onCardOpacityChange(Number(event.currentTarget.value) / 100)}
        />
        <div className="appearance-opacity__ends" aria-hidden="true">
          <span>完全透明</span>
          <span>完全实色</span>
        </div>
      </div>

      <div className="appearance-presets" aria-label="透明度预设">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            className={Math.abs(cardOpacity - preset.value) < 0.01 ? 'is-active' : ''}
            onClick={() => onCardOpacityChange(preset.value)}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </section>
  )
}
