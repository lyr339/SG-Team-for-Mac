interface IconProps {
  className?: string
}

function Icon({ className, children }: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

/** 设置页导航图标：与 UiIcons 同一笔画语言（24 视窗、圆角端点、currentColor）。 */

export function SettingsAccountsIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><circle cx="12" cy="8.5" r="3.6" {...stroke} /><path d="M4.8 19.5c.9-3.6 3.7-5.5 7.2-5.5s6.3 1.9 7.2 5.5" {...stroke} /></Icon>
}

export function SettingsImportIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><path d="M12 4v9.5M8 9.5l4 4 4-4" {...stroke} /><path d="M4.5 15v2.8a1.7 1.7 0 0 0 1.7 1.7h11.6a1.7 1.7 0 0 0 1.7-1.7V15" {...stroke} /></Icon>
}

export function SettingsAutomationIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><path d="M13 3.5 5.5 13.5H11l-1 7 7.5-10H12l1-7Z" {...stroke} /></Icon>
}

export function SettingsAozaiIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><rect x="3.5" y="6" width="17" height="12" rx="2.2" {...stroke} /><path d="M3.5 10h17M7 14.5h4" {...stroke} /></Icon>
}

export function SettingsMaintenanceIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><path d="m14.8 6.2 3 3M4.5 19.5l1.2-4.2L14.9 6a1.9 1.9 0 0 1 2.7 0l.3.3a1.9 1.9 0 0 1 0 2.7l-9.2 9.2-4.2 1.3Z" {...stroke} /></Icon>
}
