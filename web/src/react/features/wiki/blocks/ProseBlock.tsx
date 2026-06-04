import type { ProseContent, Segment } from '../../../../lib/contracts/wiki'

export function SegmentRenderer({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((seg, i) => {
        switch (seg.type) {
          case 'text':
            return <span key={i}>{seg.value}</span>
          case 'bold':
            return <strong key={i} className="font-semibold text-[var(--wiki-text)]">{seg.value}</strong>
          case 'code':
            return (
              <code key={i} className="font-[family-name:var(--wiki-mono)] text-[0.88em] bg-[var(--wiki-raised)] px-1.5 py-0.5 rounded-[3px] text-[var(--wiki-accent)]">
                {seg.value}
              </code>
            )
          case 'xref':
            return (
              <a key={i} className="text-[var(--wiki-accent)] no-underline border-b border-dashed border-[var(--wiki-accent-dim)] hover:border-solid cursor-pointer">
                {seg.label}
              </a>
            )
        }
      })}
    </>
  )
}

export default function ProseBlock({ content }: { content: ProseContent }) {
  return (
    <p className="text-[var(--wiki-text-secondary)] leading-[1.75] mb-3">
      <SegmentRenderer segments={content.segments} />
    </p>
  )
}
