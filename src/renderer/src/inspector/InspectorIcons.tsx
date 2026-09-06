import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function base(props: IconProps): IconProps {
  return { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', ...props }
}

export function DiffIcon(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="M5 2.5v5M2.5 5h5M2.5 11.5h5M9 3.5h4.5M9 12.5h4.5M11.25 3.5v9" /></svg>
}

export function PlanIcon(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="m2.5 4.5 1.3 1.3L6 3.6M2.5 9l1.3 1.3L6 8.1M8.5 4.5h5M8.5 9h5M2.7 13.5h10.8" /></svg>
}

export function ActivityIcon(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="M1.5 8.5h2.6l1.9-5 2.4 9 2.1-6.5 1.4 2.5h2.6" /></svg>
}

export function ArtifactIcon(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><rect x="2" y="2.5" width="12" height="11" rx="1.8" /><path d="m2.5 11 3.4-3.4a1 1 0 0 1 1.4 0L10 10.3l1.3-1.3a1 1 0 0 1 1.4 0l.8.8" /><circle cx="10.4" cy="5.8" r="1" fill="currentColor" stroke="none" /></svg>
}

export function OpenExternalIcon(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="M6.5 3.5H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5M9.5 2.5h4v4M13.5 2.5 7.5 8.5" /></svg>
}

export function CopyIcon(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" /></svg>
}

export function FolderIcon(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z" /></svg>
}

export function QuoteIcon(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /><path d="M5.5 6.5h5M5.5 8.5h3" /></svg>
}

export function StageIcon(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="M8 3v10M3 8h10" /></svg>
}

export function UnstageIcon(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="M3 8h10" /></svg>
}

export function RevertIcon(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="M3 6.5h6.5a3 3 0 0 1 0 6H6" /><path d="m5.5 4-2.5 2.5L5.5 9" /></svg>
}

export function ChevronIcon({ open, ...props }: IconProps & { open: boolean }): React.JSX.Element {
  return <svg {...base(props)}><path d={open ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} /></svg>
}

export function ExpandAllIcon(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="m5 6.5 3-3 3 3M5 9.5l3 3 3-3" /></svg>
}

export function CollapseAllIcon(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="m5 3.5 3 3 3-3M5 12.5l3-3 3 3" /></svg>
}

export function TerminalGlyph(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="m3 4.5 3 3-3 3M8 11h5" /></svg>
}

export function FileGlyph(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="M4 1.5h5l3.5 3.5v9.5H4z" /><path d="M9 1.5V5h3.5" /></svg>
}

export function SearchGlyph(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></svg>
}

export function GlobeGlyph(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></svg>
}

export function PlugGlyph(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><path d="M5.5 2v3M10.5 2v3M4 5h8v2.5a4 4 0 0 1-8 0zM8 11.5V14" /></svg>
}

export function TargetGlyph(props: IconProps): React.JSX.Element {
  return <svg {...base(props)}><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2" /></svg>
}
