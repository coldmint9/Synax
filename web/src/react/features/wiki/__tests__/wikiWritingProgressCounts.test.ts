import { describe, expect, it } from 'vitest'
import { resolveWikiWritingProgressCounts, resolveGeneratingDocumentId } from '../wikiWritingProgressCounts'
import type { WikiDocument } from '../../../../lib/contracts/wiki'

function doc(id: string, contentMd = ''): WikiDocument {
  return {
    id,
    snapshotId: 'snap-1',
    title: id,
    slug: id,
    docType: 'module',
    sortOrder: 0,
    parentId: null,
    isSection: false,
    contentMd,
    pipelineStage: contentMd ? 'done' : 'pending',
    staleState: 'fresh',
    manualState: 'none',
    targetFiles: [],
    keyQuestions: [],
    references: [],
    createdAt: '',
    updatedAt: '',
  }
}

describe('resolveWikiWritingProgressCounts', () => {
  it('uses document counts as primary source', () => {
    const documents = [doc('a', 'content'), doc('b'), doc('c', 'x')]
    const result = resolveWikiWritingProgressCounts(documents, null)
    expect(result).toEqual({ done: 2, total: 3, percent: 67 })
  })

  it('prefers the higher done count from SSE progress', () => {
    const documents = [doc('a', 'content'), doc('b'), doc('c')]
    const result = resolveWikiWritingProgressCounts(documents, { doneDocs: 2, totalDocs: 5 })
    expect(result.done).toBe(2)
    expect(result.total).toBe(3)
    expect(result.percent).toBe(67)
  })

  it('falls back to SSE totals when documents are empty', () => {
    const result = resolveWikiWritingProgressCounts([], { doneDocs: 2, totalDocs: 8 })
    expect(result).toEqual({ done: 2, total: 8, percent: 25 })
  })
})

describe('resolveGeneratingDocumentId', () => {
  it('prefers documentId from SSE progress', () => {
    const documents = [doc('a'), doc('b')]
    expect(resolveGeneratingDocumentId(documents, { documentId: 'b' }, true)).toBe('b')
  })

  it('falls back to title match', () => {
    const documents = [doc('alpha'), doc('beta')]
    expect(resolveGeneratingDocumentId(documents, { docTitle: 'beta' }, true)).toBe('beta')
  })

  it('uses snapshot writing status when gen tracking is inactive', () => {
    const documents = [doc('alpha'), doc('beta')]
    expect(resolveGeneratingDocumentId(documents, { documentId: 'beta' }, false, 'writing')).toBe('beta')
  })

  it('returns null when not writing', () => {
    const documents = [doc('alpha')]
    expect(resolveGeneratingDocumentId(documents, { documentId: 'alpha' }, false, 'partial')).toBeNull()
  })
})
