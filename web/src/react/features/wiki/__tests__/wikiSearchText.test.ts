import { describe, expect, it } from 'vitest'
import {
  centerSnippetAroundMatch,
  cjkSeparate,
  findQueryMatch,
  splitHighlightedSnippet,
} from '../wikiSearchText'

describe('wikiSearchText', () => {
  it('cjkSeparate inserts spaces around CJK characters', () => {
    expect(cjkSeparate('认证')).toBe('认 证')
  })

  it('findQueryMatch handles CJK spaced search text', () => {
    const text = '系统 认 证 模块负责用户登录'
    const match = findQueryMatch(text, '认证')
    expect(match).toEqual({ start: 3, length: 3 })
  })

  it('centerSnippetAroundMatch keeps keyword near the middle', () => {
    const text = 'a'.repeat(40) + 'MATCH' + 'b'.repeat(40)
    const centered = centerSnippetAroundMatch(text, 'MATCH', 20)
    const idx = centered.indexOf('MATCH')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(idx).toBeLessThanOrEqual(Math.floor((centered.length - 5) / 2) + 2)
  })

  it('splitHighlightedSnippet returns highlight segments', () => {
    const parts = splitHighlightedSnippet('prefix keyword suffix', 'keyword')
    expect(parts).toEqual({
      before: 'prefix ',
      match: 'keyword',
      after: ' suffix',
    })
  })
})
