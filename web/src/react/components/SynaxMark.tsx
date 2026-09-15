import { cn } from '../../lib/utils'

interface SynaxMarkProps {
  /** Rendered box size in px; the glyph keeps its own aspect inside it. */
  size?: number
  className?: string
  /** When provided the mark is exposed to assistive tech as an image. */
  title?: string
}

/**
 * Synax brand mark: the "S" synapse ribbon with its two terminal nodes.
 * The geometry mirrors `web/public/favicon.svg` so the in-app mark and the
 * app icon stay the same shape, but it is drawn with `currentColor` and
 * cropped to the ink box so it can sit inline at text/icon sizes.
 */
export function SynaxMark({ size = 16, className, title }: SynaxMarkProps) {
  return (
    <svg
      viewBox="15.6 10.6 34.1 41.8"
      width={size}
      height={size}
      className={cn('synax-mark', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M43.25 23.4 C43.25 18.4 38.9 15.9 32.6 15.9 C26.4 15.9 22 19 22 24 C22 29 27 30.9 32 31.5 C37 32.1 42 34 42 39 C42 44 37.6 47.1 32 47.1 C26.4 47.1 22.6 44.6 22 40.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="8.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle className="synax-mark-node" cx="43.25" cy="23.4" r="5.4" />
      <circle className="synax-mark-node" cx="22" cy="40.25" r="5.4" />
    </svg>
  )
}
