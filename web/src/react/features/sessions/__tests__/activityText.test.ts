import { describe, expect, it } from 'vitest'
import { ACTIVITY_BODY_LIMIT, activityPreview, formatCharCount, tailForDisplay } from '../activityText'

describe('formatCharCount', () => {
  it('keeps small counts exact and compacts large ones', () => {
    expect(formatCharCount(0)).toBe('0')
    expect(formatCharCount(812)).toBe('812')
    expect(formatCharCount(7_240)).toBe('7.2k')
    expect(formatCharCount(99_332)).toBe('99.3k')
    expect(formatCharCount(123_456)).toBe('123k')
  })
})

describe('activityPreview', () => {
  it('flattens the first non-empty line and truncates it', () => {
    expect(activityPreview('\n\nLet me check   the state.\nsecond line')).toBe('Let me check the state.')
    expect(activityPreview('x'.repeat(200))).toHaveLength(90)
    expect(activityPreview('x'.repeat(200)).endsWith('…')).toBe(true)
  })
})

describe('tailForDisplay', () => {
  it('returns the body untouched below the limit', () => {
    expect(tailForDisplay('short')).toEqual({ text: 'short', hidden: 0 })
  })

  it('keeps the tail of an oversized body and reports what it hid', () => {
    const content = 'a'.repeat(ACTIVITY_BODY_LIMIT) + 'TAIL'
    const { text, hidden } = tailForDisplay(content)
    expect(hidden).toBe(4)
    expect(text.startsWith('a')).toBe(true)
    expect(text.endsWith('TAIL')).toBe(true)
    expect(text).toHaveLength(ACTIVITY_BODY_LIMIT)
  })
})
