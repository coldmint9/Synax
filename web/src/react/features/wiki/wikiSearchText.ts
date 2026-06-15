// Shared wiki search text helpers (mirrors api/services/wiki/wiki-fts.ts matching rules)

const CJK_RANGES: Array<[number, number]> = [
  [0x4E00, 0x9FFF],
  [0x3400, 0x4DBF],
  [0xF900, 0xFAFF],
]

function isCJK(cp: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)
}

export function cjkSeparate(text: string): string {
  let result = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    result += isCJK(cp) ? ` ${ch} ` : ch
  }
  return result.replace(/\s+/g, ' ').trim()
}

export interface QueryMatchRange {
  start: number
  length: number
}

export function findQueryMatch(text: string, query: string): QueryMatchRange | null {
  const trimmed = query.trim()
  if (!trimmed || !text) return null

  const lower = text.toLowerCase()
  const ftsLower = cjkSeparate(trimmed).toLowerCase()
  const queryLower = trimmed.toLowerCase()

  let idx = lower.indexOf(ftsLower)
  if (idx !== -1) return { start: idx, length: ftsLower.length }

  idx = lower.indexOf(queryLower)
  if (idx !== -1) return { start: idx, length: queryLower.length }

  return null
}

export function centerSnippetAroundMatch(text: string, query: string, maxLen = 64): string {
  if (!text) return ''

  const match = findQueryMatch(text, query)
  if (!match) {
    return text.length <= maxLen ? text : `${text.slice(0, maxLen)}…`
  }

  const { start, length } = match
  const end = start + length
  const budget = Math.max(0, maxLen - length)
  const before = Math.floor(budget / 2)
  const after = budget - before

  let sliceStart = Math.max(0, start - before)
  let sliceEnd = Math.min(text.length, end + after)

  if (sliceEnd - sliceStart < maxLen) {
    const deficit = maxLen - (sliceEnd - sliceStart)
    if (sliceStart > 0) {
      sliceStart = Math.max(0, sliceStart - deficit)
    } else {
      sliceEnd = Math.min(text.length, sliceEnd + deficit)
    }
  }

  const prefix = sliceStart > 0 ? '…' : ''
  const suffix = sliceEnd < text.length ? '…' : ''
  return `${prefix}${text.slice(sliceStart, sliceEnd)}${suffix}`
}

export function splitHighlightedSnippet(text: string, query: string): {
  before: string
  match: string
  after: string
} | null {
  const centered = centerSnippetAroundMatch(text, query)
  const match = findQueryMatch(centered, query)
  if (!match) return null

  return {
    before: centered.slice(0, match.start),
    match: centered.slice(match.start, match.start + match.length),
    after: centered.slice(match.start + match.length),
  }
}
