import { iconSurfaceClass } from '../../lib/icon-tones'
import { cn } from '../../lib/utils'

interface ProviderLogoProps {
  src: string
  alt: string
  invertOnDark?: boolean
  className?: string
}

export function ProviderLogo({ src, alt, invertOnDark, className }: ProviderLogoProps) {
  return (
    <span className={cn(iconSurfaceClass('logo', 'xs'), className)} data-tone="logo" data-size="xs">
      <img
        src={src}
        alt={alt}
        className={cn('icon-logo-img', invertOnDark && 'icon-logo-img-invert-dark')}
        draggable={false}
      />
    </span>
  )
}
