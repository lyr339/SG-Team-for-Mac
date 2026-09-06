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
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

export function SessionsIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><rect x="3.5" y="4" width="17" height="16" rx="2.2" {...stroke} /><path d="M7.5 8h9M7.5 12h6M7.5 16h8" {...stroke} /></Icon>
}

export function WorkspaceIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><path d="M3.5 6.5h6l2 2H20.5v9.8a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7V6.5Z" {...stroke} /><path d="M3.5 9h17" {...stroke} /></Icon>
}

export function PlayIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><path d="M8 5.5v13l10.5-6.5L8 5.5Z" {...stroke} /></Icon>
}

export function CrownIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><path d="m3.5 7.5 4.2 3.1L12 5l4.3 5.6 4.2-3.1-1.4 9.2H4.9L3.5 7.5Z" fill="currentColor" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.4" /><path d="M5.2 19h13.6" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" /></Icon>
}

export function GridIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><rect x="4" y="4" width="7" height="7" rx="1.4" {...stroke} /><rect x="13" y="4" width="7" height="7" rx="1.4" {...stroke} /><rect x="4" y="13" width="7" height="7" rx="1.4" {...stroke} /><rect x="13" y="13" width="7" height="7" rx="1.4" {...stroke} /></Icon>
}

export function SunIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><circle cx="12" cy="12" r="4" {...stroke} /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" {...stroke} /></Icon>
}

export function ExportIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><path d="M12 4v10.5M7.5 10 12 14.5 16.5 10M5 18.5h14" {...stroke} /></Icon>
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}>
    <path d="M18.2 8.2A7 7 0 0 0 6.4 6.7L4.5 8.6" {...stroke} />
    <path d="M4.5 5.1v3.5H8" {...stroke} />
    <path d="M5.8 15.8a7 7 0 0 0 11.8 1.5l1.9-1.9" {...stroke} />
    <path d="M19.5 18.9v-3.5H16" {...stroke} />
  </Icon>
}

export function EraseIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><path d="m13.5 4.5 6 6L12 18H7.5l-3-3 9-10.5Z" {...stroke} /><path d="M7 19.5h13" {...stroke} /></Icon>
}

export function HandoffIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><path d="M4 8h12.5M13 4.5 16.5 8 13 11.5M20 16H7.5M11 12.5 7.5 16l3.5 3.5" {...stroke} /></Icon>
}

export function ChevronDownIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><path d="m6.5 9 5.5 5.5L17.5 9" {...stroke} /></Icon>
}

export function SettingsIcon(props: IconProps): React.JSX.Element {
  return <Icon {...props}><circle cx="12" cy="12" r="3.1" {...stroke} /><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.45 1.45M16.55 16.55 18 18M18 6l-1.45 1.45M7.45 16.55 6 18" {...stroke} /></Icon>
}

export function PanelIcon({ side, ...props }: IconProps & { side: 'left' | 'right' }): React.JSX.Element {
  return <Icon {...props}><rect x="3.5" y="4" width="17" height="16" rx="2.2" {...stroke} /><path d={side === 'left' ? 'M9.5 4v16' : 'M14.5 4v16'} {...stroke} /></Icon>
}
