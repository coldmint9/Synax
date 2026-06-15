import { useEffect, useRef } from 'react'
import { FileText } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import { useWikiSearch, type SearchResult } from './hooks/useWikiSearch'
import { splitHighlightedSnippet } from './wikiSearchText'
import './wiki-theme.css'

interface Props {
  query: string
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (result: SearchResult) => void
}

export default function WikiSearchPanel({ query, activeIndex, onActiveIndexChange, onSelect }: Props) {
  const { t } = useLocale()
  const { results, loading } = useWikiSearch(query)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  function renderSnippet(result: SearchResult) {
    if (!query.trim()) return result.snippet

    const parts = splitHighlightedSnippet(result.snippet, query)
    if (!parts) return result.snippet

    return (
      <>
        {parts.before}
        <mark className="wiki-search-snippet-mark">{parts.match}</mark>
        {parts.after}
      </>
    )
  }

  const grouped = results.reduce<Map<string, SearchResult[]>>((acc, r) => {
    const list = acc.get(r.documentId) ?? []
    list.push(r)
    acc.set(r.documentId, list)
    return acc
  }, new Map())

  let flatIndex = 0

  if (!query.trim()) {
    return (
      <div ref={listRef} className="p-3">
        <p className="text-center text-xs text-muted-foreground py-4">{t('wikiSearchHint')}</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div ref={listRef} className="p-3">
        <p className="text-center text-xs text-muted-foreground py-4 animate-pulse">Searching…</p>
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div ref={listRef} className="p-3">
        <p className="text-center text-xs text-muted-foreground py-4">{t('wikiSearchNoResults')}</p>
      </div>
    )
  }

  return (
    <div ref={listRef} className="max-h-[320px] overflow-y-auto p-1.5">
      {[...grouped.entries()].map(([docId, items]) => (
        <div key={docId} className="mb-1">
          <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide truncate">
            {items[0].documentTitle}
          </p>
          {items.map(result => {
            const idx = flatIndex++
            return (
              <button
                key={`${result.documentId}-${idx}`}
                type="button"
                data-index={idx}
                className={`w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left text-xs transition-colors ${
                  idx === activeIndex ? 'bg-primary/10 text-foreground' : 'text-foreground/80 hover:bg-muted/50'
                }`}
                onMouseDown={e => { e.preventDefault(); onSelect(result) }}
                onMouseEnter={() => onActiveIndexChange(idx)}
              >
                <FileText size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
                <span className="wiki-search-snippet min-w-0 flex-1">{renderSnippet(result)}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export { useWikiSearch, type SearchResult }
