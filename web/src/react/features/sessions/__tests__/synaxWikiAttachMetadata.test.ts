import { describe, expect, it } from 'vitest'
import {
  readSynaxDocumentId,
  readSynaxWikiAttachMode,
} from '../synaxSessionTypes'

describe('readSynaxWikiAttachMode', () => {
  it('defaults to auto when missing', () => {
    expect(readSynaxWikiAttachMode(null)).toBe('auto')
    expect(readSynaxWikiAttachMode({})).toBe('auto')
  })

  it('reads manual when set', () => {
    expect(readSynaxWikiAttachMode({ wikiAttachMode: 'manual' })).toBe('manual')
  })
})

describe('readSynaxDocumentId', () => {
  it('returns null for missing or empty values', () => {
    expect(readSynaxDocumentId(null)).toBeNull()
    expect(readSynaxDocumentId({ documentId: '' })).toBeNull()
    expect(readSynaxDocumentId({ documentId: 1 })).toBeNull()
  })

  it('returns document id string', () => {
    expect(readSynaxDocumentId({ documentId: 'doc_1' })).toBe('doc_1')
  })
})
