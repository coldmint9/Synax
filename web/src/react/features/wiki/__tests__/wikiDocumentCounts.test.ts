import { describe, it, expect } from 'vitest'
import { countWritableDocuments, countWrittenDocuments } from '../wikiDocumentCounts'
import type { WikiDocument } from '../../../../lib/contracts/wiki'

function makeDoc(partial: Partial<WikiDocument> & Pick<WikiDocument, 'id'>): WikiDocument {
  return {
    snapshotId: 'snap-1',
    projectId: 'proj-1',
    title: partial.id,
    docType: 'module',
    sortOrder: 0,
    parentId: null,
    contentMd: '',
    references: [],
    pipelineStage: 'pending',
    manualState: 'none',
    staleState: 'fresh',
    isSection: false,
    createdAt: '',
    updatedAt: '',
    ...partial,
  }
}

describe('wikiDocumentCounts', () => {
  it('excludes section nodes from writable totals', () => {
    const documents = [
      makeDoc({ id: 'sec', isSection: true }),
      makeDoc({ id: 'a', contentMd: '# A' }),
      makeDoc({ id: 'b' }),
    ]
    expect(countWritableDocuments(documents)).toBe(2)
    expect(countWrittenDocuments(documents)).toBe(1)
  })
})
