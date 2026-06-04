import type { HeadingContent } from '../../../../lib/contracts/wiki'

const HEADING_STYLES = {
  1: 'text-[22px] font-bold tracking-[-0.02em] mt-10 mb-4',
  2: 'text-[17px] font-semibold tracking-[-0.01em] mt-8 mb-3',
  3: 'text-[14px] font-semibold mt-6 mb-2',
} as const

export default function HeadingBlock({ content }: { content: HeadingContent }) {
  const Tag = `h${content.level}` as 'h1' | 'h2' | 'h3'
  return (
    <Tag
      id={content.anchor}
      className={`text-[var(--wiki-text)] ${HEADING_STYLES[content.level]}`}
    >
      {content.text}
    </Tag>
  )
}
