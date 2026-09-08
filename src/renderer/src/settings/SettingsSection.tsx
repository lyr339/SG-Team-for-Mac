interface SettingsSectionProps {
  /** 区块标题（如「已保存账号」）。 */
  title: string
  /** 一句功能说明，陈述它能做什么；无说明时省略。 */
  description?: string
  /** 说明文字的悬停完整内容（如 settings.json 的绝对路径）。 */
  descriptionTitle?: string
  /** 标题行右侧的辅助位（计数徽章、状态点等）。 */
  aside?: React.ReactNode
  children: React.ReactNode
}

/**
 * 设置分组内的区块外壳：标题 + 说明 + 卡片内容。
 * 视觉对齐设计系统——边框优先、圆角 9-17px、阴影仅 hairline。
 */
export function SettingsSection({ title, description, descriptionTitle, aside, children }: SettingsSectionProps): React.JSX.Element {
  return (
    <section className="settings-section">
      <header className="settings-section__head">
        <span className="settings-section__title">
          <strong>{title}</strong>
          {description ? <small title={descriptionTitle}>{description}</small> : null}
        </span>
        {aside ? <span className="settings-section__aside">{aside}</span> : null}
      </header>
      <div className="settings-section__body">{children}</div>
    </section>
  )
}
