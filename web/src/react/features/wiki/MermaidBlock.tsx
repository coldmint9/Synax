import { useMemo } from 'react'
import { renderDiagram } from '../../../lib/mermaid-renderer'

export function MermaidBlock({ code }: { code: string }) {
  const result = useMemo(() => renderDiagram(code), [code])

  if (!result) {
    return (
      <pre className="wiki-mermaid-fallback">
        <code>{code}</code>
      </pre>
    )
  }

  if ('error' in result) {
    return (
      <pre className="wiki-mermaid-error">
        <code>{result.error}</code>
      </pre>
    )
  }

  return (
    <div
      className="wiki-mermaid"
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  )
}
