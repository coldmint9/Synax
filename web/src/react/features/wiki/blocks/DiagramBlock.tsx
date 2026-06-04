import { useMemo } from 'react'
import { renderMermaidSVG, THEMES } from 'beautiful-mermaid'
import type { DiagramContent } from '../../../../lib/contracts/wiki'
import { useShellStore } from '../../../state/shellStore'

export default function DiagramBlock({ content }: { content: DiagramContent }) {
  const theme = useShellStore(s => s.preferences.theme)

  const { svg, error } = useMemo(() => {
    const colors = theme === 'dark' ? THEMES['github-dark'] : THEMES['github-light']
    try {
      return { svg: renderMermaidSVG(content.code, { ...colors, font: 'var(--wiki-mono, Inter)' }), error: null }
    } catch (e) {
      return { svg: null, error: e instanceof Error ? e.message : 'Parse error' }
    }
  }, [content.code, theme])

  return (
    <div className="my-4 border border-[var(--wiki-border)] rounded-[var(--wiki-radius)] overflow-hidden bg-[var(--wiki-surface)]">
      <div className="p-4 overflow-x-auto">
        {svg ? (
          <div className="w-full" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <pre className="overflow-x-auto p-3 text-[12px] leading-relaxed text-[var(--wiki-text-muted)] font-[family-name:var(--wiki-mono)]">
            <code>{content.code}</code>
          </pre>
        )}
      </div>
      {content.caption && (
        <div className="px-4 pb-3 text-[11px] text-[var(--wiki-text-muted)] text-center">
          {content.caption}
        </div>
      )}
    </div>
  )
}
