import { useEffect, useRef, useCallback } from 'react'
import { Hash, AlignLeft, List, Table2, Code, Share2, CheckSquare } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import { useWikiStore } from '../../state/wikiStore'
import { useWikiSearch, type SearchResult } from './hooks/useWikiSearch'
import type { WikiBlockType } from '../../../lib/contracts/wiki'

const blockTypeIcons: Record<WikiBlockType, typeof Hash> = {
  heading: Hash,
  paragraph: AlignLeft,
  list: List,
  table: Table2,
  code_ref: Code,
  diagram: Share2,
  task: CheckSquare,
}

interface Props {
  query: string
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (result: SearchResult) => void
}

export default function WikiSearchPanel({ query, activeIndex, onActiveIndexChange, onSelect }: Props) {
  const { t } = useLocale()
  const { results } = useWikiSearch(query)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  function renderSnippet(result: SearchResult) {
    if (!query.trim()) return result.snippet
    const lower = result.snippet.toLowerCase()
    const idx = lower.indexOf(query.trim().toLowerCase())
    if (idx === -1) return result.snippet
    const before = result.snippet.slice(0, idx)
    const match = result.snippet.slice(idx, idx + query.trim().length)
    const after = result.snippet.slice(idx + query.trim().length)
    return (
      <>
        {before}
        <mark className="bg-warning/30 text-foreground rounded-sm px-0.5">{match}</mark>
        {after}
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
            const Icon = blockTypeIcons[result.blockType] ?? AlignLeft
            return (
              <button
                key={result.blockId}
                type="button"
                data-index={idx}
                className={`w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left text-xs transition-colors ${
                  idx === activeIndex ? 'bg-primary/10 text-foreground' : 'text-foreground/80 hover:bg-muted/50'
                }`}
                onMouseDown={e => { e.preventDefault(); onSelect(result) }}
                onMouseEnter={() => onActiveIndexChange(idx)}
              >
                <Icon size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
                <span className="line-clamp-2 break-all">{renderSnippet(result)}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export { useWikiSearch, type SearchResult }
