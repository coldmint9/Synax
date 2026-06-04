import { memo, useState, useEffect } from 'react'
import type { DiagramContent } from '../../../../lib/contracts/wiki'

const DiagramRenderer = memo(function DiagramRenderer({ code }: { code: string }) {
  const [svgHtml, setSvgHtml] = useState<string>('')
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!code) return
    let cancelled = false
    const id = `mmd-${Math.random().toString(36).slice(2, 9)}`
    import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'dark' })
      try {
        const { svg } = await mermaid.render(id, code)
        if (!cancelled) setSvgHtml(svg)
      } catch {
        if (!cancelled) setError(true)
      }
    })
    return () => { cancelled = true }
  }, [code])

  if (error) {
    return (
      <pre className="overflow-x-auto p-3 text-[12px] leading-relaxed text-[var(--wiki-text-muted)] font-[family-name:var(--wiki-mono)]">
        <code>{code}</code>
      </pre>
    )
  }
  if (!svgHtml) {
    return <div className="flex h-24 items-center justify-center text-[12px] text-[var(--wiki-text-muted)]">Loading diagram...</div>
  }
  return <div className="w-full overflow-x-auto" dangerouslySetInnerHTML={{ __html: svgHtml }} />
})

export default function DiagramBlock({ content }: { content: DiagramContent }) {
  return (
    <div className="my-4 border border-[var(--wiki-border)] rounded-[var(--wiki-radius)] overflow-hidden bg-[var(--wiki-surface)]">
      <div className="p-4">
        <DiagramRenderer code={content.code} />
      </div>
      {content.caption && (
        <div className="px-4 pb-3 text-[11px] text-[var(--wiki-text-muted)] text-center">
          {content.caption}
        </div>
      )}
    </div>
  )
}
