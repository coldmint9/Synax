import type { CalloutContent } from '../../../../lib/contracts/wiki'
import { SegmentRenderer } from './ProseBlock'

const LEVEL_CONFIG = {
  info: {
    icon: 'ℹ️',
    bg: 'var(--wiki-accent-bg)',
    border: 'rgba(124, 154, 255, 0.15)',
  },
  warn: {
    icon: '⚠️',
    bg: 'var(--wiki-orange-bg)',
    border: 'rgba(251, 146, 60, 0.15)',
  },
  important: {
    icon: '✦',
    bg: 'var(--wiki-green-bg)',
    border: 'rgba(74, 222, 128, 0.15)',
  },
} as const

export default function CalloutBlock({ content }: { content: CalloutContent }) {
  const config = LEVEL_CONFIG[content.level]
  return (
    <div
      className="flex gap-3 p-3.5 rounded-[var(--wiki-radius)] my-4 text-[13px] leading-[1.65]"
      style={{ background: config.bg, border: `1px solid ${config.border}` }}
    >
      <span className="shrink-0 text-base mt-0.5">{config.icon}</span>
      <div className="text-[var(--wiki-text-secondary)]">
        {content.title && (
          <strong className="block text-[var(--wiki-text)] font-semibold mb-1">{content.title}</strong>
        )}
        <SegmentRenderer segments={content.body} />
      </div>
    </div>
  )
}
