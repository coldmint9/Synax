// ---------------------------------------------------------------------------
// useSearchHighlight — highlight search query matches inside wiki document DOM
// ---------------------------------------------------------------------------

import { useEffect, useRef } from 'react'

const MARK_CLASS = 'wiki-search-highlight'

export function useSearchHighlight(
  documentId: string | undefined,
  query: string | null | undefined,
  enabled: boolean,
) {
  const marksRef = useRef<HTMLSpanElement[]>([])

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

    const timer = setTimeout(() => {
      const docEl = document.getElementById(`wiki-document-${documentId}`)
      if (!docEl) return

      const q = trimmed.toLowerCase()
      const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT)
      const matchingNodes: Text[] = []
      let node: Text | null
      while ((node = walker.nextNode() as Text | null)) {
        const parent = node.parentElement
        if (!parent) continue
        const tag = parent.tagName.toLowerCase()
        if (tag === 'mark' || tag === 'script' || tag === 'style' || tag === 'textarea' || tag === 'input') continue
        if (parent.closest('pre, code, .wiki-references, [data-no-highlight]')) continue
        if (node.textContent?.toLowerCase().includes(q)) {
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
        let matchIdx = lower.indexOf(q, lastIdx)

        while (matchIdx !== -1) {
          if (matchIdx > lastIdx) {
            fragment.appendChild(document.createTextNode(text.slice(lastIdx, matchIdx)))
          }
          const mark = document.createElement('mark')
          mark.className = MARK_CLASS
          mark.textContent = text.slice(matchIdx, matchIdx + q.length)
          fragment.appendChild(mark)
          newMarks.push(mark)

          lastIdx = matchIdx + q.length
          matchIdx = lower.indexOf(q, lastIdx)
        }

        if (lastIdx < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(lastIdx)))
        }

        textNode.parentNode?.replaceChild(fragment, textNode)
      }

      marksRef.current = newMarks

      if (newMarks.length > 0) {
        newMarks[0].scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    }, 80)

    return () => {
      clearTimeout(timer)
      removeHighlights()
    }
  }, [documentId, query, enabled])
}
