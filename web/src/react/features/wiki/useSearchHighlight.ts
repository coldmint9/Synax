// ---------------------------------------------------------------------------
// useSearchHighlight — highlight search query matches inside wiki block DOM
// ---------------------------------------------------------------------------
// When a wiki search result is selected, this hook applies DOM-level
// <mark> highlighting to matching text within the target block, then
// scrolls the first match into view. Highlights are removed when the
// query changes or the component unmounts.
//
// We operate on the live DOM (not React's virtual DOM) because wiki blocks
// render deeply nested structured content via many sub-components — a
// TreeWalker over text nodes is far simpler than threading a highlight prop
// through every block renderer.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from 'react'

/** CSS class applied to <mark> elements injected by this hook. */
const MARK_CLASS = 'wiki-search-highlight'

/**
 * Find and highlight occurrences of `query` inside the DOM element whose
 * `id` matches `blockId`, then scroll the first match into view.
 *
 * @param blockId   - the `wiki-block-{id}` element to search within
 * @param query     - the search term to highlight (null/empty = no highlight)
 * @param enabled   - if false, skip highlighting (e.g. block is not selected)
 */
export function useSearchHighlight(
  blockId: string | undefined,
  query: string | null | undefined,
  enabled: boolean,
) {
  const marksRef = useRef<HTMLSpanElement[]>([])

  // Cleanup previous highlights (merges adjacent text nodes)
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
    // Always clean up first
    removeHighlights()

    const trimmed = query?.trim()
    if (!trimmed || !blockId || !enabled) return

    // Small delay so the DOM is painted after React reconciliation
    const timer = setTimeout(() => {
      const blockEl = document.getElementById(`wiki-block-${blockId}`)
      if (!blockEl) return

      const q = trimmed.toLowerCase()

      // Collect text nodes that contain the query (case-insensitive)
      const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT)
      const matchingNodes: Text[] = []
      let node: Text | null
      while ((node = walker.nextNode() as Text | null)) {
        // Skip nodes inside <mark> (already highlighted) and inside
        // interactive elements or code blocks where we don't want to break layout
        const parent = node.parentElement
        if (!parent) continue
        const tag = parent.tagName.toLowerCase()
        if (tag === 'mark' || tag === 'script' || tag === 'style' || tag === 'textarea' || tag === 'input') continue
        // Skip code blocks and source panels to avoid breaking syntax highlighting
        if (parent.closest('pre, code, .wiki-source-panel, .wiki-coordinate-panel, [data-no-highlight]')) continue
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
          // Unmatched text before this occurrence
          if (matchIdx > lastIdx) {
            fragment.appendChild(document.createTextNode(text.slice(lastIdx, matchIdx)))
          }
          // Wrapped match
          const mark = document.createElement('mark')
          mark.className = MARK_CLASS
          mark.textContent = text.slice(matchIdx, matchIdx + q.length)
          fragment.appendChild(mark)
          newMarks.push(mark)

          lastIdx = matchIdx + q.length
          matchIdx = lower.indexOf(q, lastIdx)
        }

        // Remaining text after the last match
        if (lastIdx < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(lastIdx)))
        }

        textNode.parentNode?.replaceChild(fragment, textNode)
      }

      marksRef.current = newMarks

      // Scroll the first highlighted match to a comfortable reading position
      if (newMarks.length > 0) {
        newMarks[0].scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    }, 80) // small delay to let React finish painting

    return () => {
      clearTimeout(timer)
      removeHighlights()
    }
  }, [blockId, query, enabled])
}
