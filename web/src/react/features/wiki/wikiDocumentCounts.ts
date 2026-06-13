import type { WikiDocument } from '../../../lib/contracts/wiki'

export function getWritableDocuments(documents: WikiDocument[]): WikiDocument[] {
  return documents.filter(d => !d.isSection)
}

export function countWritableDocuments(documents: WikiDocument[]): number {
  return getWritableDocuments(documents).length
}

export function countWrittenDocuments(documents: WikiDocument[]): number {
  return getWritableDocuments(documents).filter(d => d.contentMd.trim().length > 0).length
}
