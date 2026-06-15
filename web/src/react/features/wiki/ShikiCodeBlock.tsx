import { useEffect, useState } from 'react'
import { highlightWikiCode } from '../../../lib/shiki-highlighter'

export function ShikiCodeBlock({ code, language }: { code: string; language: string }) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void highlightWikiCode(code, language).then(result => {
      if (!cancelled) setHtml(result || null)
    })
    return () => {
      cancelled = true
    }
  }, [code, language])

  if (!html) {
    return (
      <pre>
        <code>{code}</code>
      </pre>
    )
  }

  return (
    <div
      className="wiki-shiki-block"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
