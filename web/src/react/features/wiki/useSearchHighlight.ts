// ---------------------------------------------------------------------------
// useSearchHighlight — highlight search query matches inside wiki document DOM
// ---------------------------------------------------------------------------

import { useEffect, useRef } from 'react'
import { useWikiStore } from '../../state/wikiStore'
import { cjkSeparate } from './wikiSearchText'

const MARK_CLASS = 'wiki-search-highlight'
const FLASH_CLASS = 'wiki-search-highlight--flash'
const FLASH_MS = 1200

function buildMatchPattern(query: string): string[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const patterns = [trimmed.toLowerCase()]
  const fts = cjkSeparate(trimmed).toLowerCase()
  if (fts !== patterns[0]) patterns.push(fts)
  return patterns
}

export function useSearchHighlight(
  documentId: string | undefined,
  query: string | null | undefined,
  enabled: boolean,
) {
  const marksRef = useRef<HTMLSpanElement[]>([])
  const flashNonce = useWikiStore(s => s.searchHighlightNonce)
  const consumedFlashNonce = useRef(0)

  function removeHighlights() {
    for (const mark of marksRef.current) {
      const parent = mark.parentNode
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
        parent.normalize()
      }
    }
    marksRef.current = []
  }

  useEffect(() => {
    removeHighlights()

    const trimmed = query?.trim()
    if (!trimmed || !documentId || !enabled) return

    const shouldFlash = flashNonce > consumedFlashNonce.current

    const timer = setTimeout(() => {
      const docEl = document.getElementById(`wiki-document-${documentId}`)
      if (!docEl) return

      const patterns = buildMatchPattern(trimmed)
      const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT)
      const matchingNodes: Text[] = []
      let node: Text | null
      while ((node = walker.nextNode() as Text | null)) {
        const parent = node.parentElement
        if (!parent) continue
        const tag = parent.tagName.toLowerCase()
        if (tag === 'mark' || tag === 'script' || tag === 'style' || tag === 'textarea' || tag === 'input') continue
        if (parent.closest('pre, code, .wiki-references, [data-no-highlight]')) continue
        const textLower = node.textContent?.toLowerCase() ?? ''
        if (patterns.some(pattern => textLower.includes(pattern))) {
          matchingNodes.push(node)
        }
      }

      if (matchingNodes.length === 0) return

      const newMarks: HTMLSpanElement[] = []

      for (const textNode of matchingNodes) {
        const text = textNode.textContent!
        const lower = text.toLowerCase()
        const fragment = document.createDocumentFragment()
        let lastIdx = 0

        const ranges: Array<{ start: number; end: number }> = []
        for (const pattern of patterns) {
          let matchIdx = lower.indexOf(pattern)
          while (matchIdx !== -1) {
            ranges.push({ start: matchIdx, end: matchIdx + pattern.length })
            matchIdx = lower.indexOf(pattern, matchIdx + pattern.length)
          }
        }

        ranges.sort((a, b) => a.start - b.start)
        const merged: Array<{ start: number; end: number }> = []
        for (const range of ranges) {
          const prev = merged[merged.length - 1]
          if (!prev || range.start >= prev.end) {
            merged.push({ ...range })
          } else if (range.end > prev.end) {
            prev.end = range.end
          }
        }

        for (const { start, end } of merged) {
          if (start > lastIdx) {
            fragment.appendChild(document.createTextNode(text.slice(lastIdx, start)))
          }
          const mark = document.createElement('mark')
          mark.className = MARK_CLASS
          mark.textContent = text.slice(start, end)
          fragment.appendChild(mark)
          newMarks.push(mark)
          lastIdx = end
        }

        if (lastIdx < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(lastIdx)))
        }

        textNode.parentNode?.replaceChild(fragment, textNode)
      }

      marksRef.current = newMarks

      if (newMarks.length > 0) {
        newMarks[0].scrollIntoView({ block: 'center', behavior: 'smooth' })
        if (shouldFlash) {
          consumedFlashNonce.current = flashNonce
          for (const mark of newMarks) {
            mark.classList.add(FLASH_CLASS)
          }
          window.setTimeout(() => {
            for (const mark of newMarks) {
              mark.classList.remove(FLASH_CLASS)
            }
          }, FLASH_MS)
        }
      }
    }, 80)

    return () => {
      clearTimeout(timer)
      removeHighlights()
    }
  }, [documentId, query, enabled, flashNonce])
}
