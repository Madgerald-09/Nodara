type NodaraLogoProps = {
  className?: string
}

export function NodaraLogo({ className = '' }: NodaraLogoProps) {
  return <img className={`nodara-logo ${className}`.trim()} src="/nodara-logo.svg" alt="NODARA — Discover. Connect. Experience." />
}
