interface BrandMarkProps {
  className?: string
}

export function BrandMark({ className }: BrandMarkProps): React.JSX.Element {
  return <img className={className} src="./brand-team.png" alt="" />
}
